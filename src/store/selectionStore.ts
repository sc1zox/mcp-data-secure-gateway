import type { SelectionRequest } from '../core/types.js';
import { JsonlStore, storePath } from './jsonlStore.js';
import type { AuditLog } from './auditLog.js';

/**
 * Open selections: searches the local model refused to resolve on its own
 * (invariant 9). Candidates are stored with full local detail so the user can
 * compare them in the approval UI; none of it is reachable from the Hermes side.
 */
export class SelectionStore {
    private readonly store: JsonlStore<SelectionRequest>;

    constructor(dataDir: string, private readonly audit: AuditLog) {
        this.store = new JsonlStore<SelectionRequest>(
            storePath(dataDir, 'selections'),
            (record) => record.selectionId
        );
    }

    async load(): Promise<void> {
        await this.store.load();
        await this.expireStale();
        await this.store.compact();
    }

    async create(request: SelectionRequest): Promise<void> {
        await this.store.put(request);
        await this.audit.record('selection_required', {
            selectionId: request.selectionId,
            detail: {
                query: request.query,
                purpose: request.purpose,
                reasoning: request.reasoning,
                candidates: request.candidates.map((candidate) => ({
                    candidateId: candidate.candidateId,
                    sourceId: candidate.resource.locator.sourceId,
                    nativeId: candidate.resource.locator.nativeId,
                    title: candidate.resource.title
                }))
            }
        });
    }

    get(selectionId: string): SelectionRequest | undefined {
        return this.store.get(selectionId);
    }

    open(now: Date = new Date()): SelectionRequest[] {
        return this.store
            .all()
            .filter(
                (request) => request.status === 'open' && Date.parse(request.expiresAt) > now.getTime()
            )
            .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    }

    async resolve(selectionId: string, resolvedRef: string): Promise<SelectionRequest> {
        const request = this.requireOpen(selectionId);
        const updated: SelectionRequest = { ...request, status: 'resolved', resolvedRef };
        await this.store.put(updated);
        await this.audit.record('selection_resolved', {
            selectionId,
            resourceRef: resolvedRef,
            detail: { query: request.query, purpose: request.purpose }
        });
        return updated;
    }

    /**
     * Finds a selection the user already decided for this exact query and purpose,
     * within its validity window.
     *
     * This is what closes the loop after the user picked a different resource in
     * the approval view: Hermes repeats its search, and instead of asking the model
     * again the gateway hands back the resource the user chose by hand. A human
     * decision outranks a fresh model guess.
     */
    findResolvedFor(query: string, purpose: string, now: Date = new Date()): SelectionRequest | undefined {
        return this.store
            .all()
            .filter(
                (request) =>
                    request.status === 'resolved' &&
                    request.resolvedRef !== undefined &&
                    Date.parse(request.expiresAt) > now.getTime() &&
                    normalise(request.query) === normalise(query) &&
                    normalise(request.purpose) === normalise(purpose)
            )
            .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    }

    async cancel(selectionId: string): Promise<SelectionRequest> {
        const request = this.requireOpen(selectionId);
        const updated: SelectionRequest = { ...request, status: 'cancelled' };
        await this.store.put(updated);
        await this.audit.record('selection_cancelled', { selectionId });
        return updated;
    }

    private requireOpen(selectionId: string): SelectionRequest {
        const request = this.store.get(selectionId);
        if (!request) {
            throw new Error(`Auswahl ${selectionId} ist unbekannt.`);
        }
        if (request.status !== 'open') {
            throw new Error(`Auswahl ${selectionId} ist bereits ${request.status}.`);
        }
        return request;
    }

    async expireStale(now: Date = new Date()): Promise<number> {
        let expired = 0;
        for (const request of this.store.all()) {
            if (request.status !== 'open' || Date.parse(request.expiresAt) > now.getTime()) {
                continue;
            }
            await this.store.put({ ...request, status: 'expired' });
            expired += 1;
        }
        return expired;
    }
}

/** Same normalisation as the reference store uses for purposes: case and whitespace only. */
function normalise(value: string): string {
    return value.trim().toLowerCase().replace(/\s+/g, ' ');
}
