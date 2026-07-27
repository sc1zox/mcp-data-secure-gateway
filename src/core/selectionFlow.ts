/**
 * Invariant 9 — ambiguity never resolves itself.
 *
 * Every path that opens, parks on, resolves or cancels a local selection
 * lives here, including the `find_resource` search itself: resolving a query
 * either lands on one reference or lands here, on the question of which one.
 * The model can propose candidates; only a person picks between them.
 * `resolveSelection`/`cancelSelection`/`requestReselection` stay methods of
 * `Orchestrator` (the approval server calls them there) and delegate into
 * this class for the actual bookkeeping.
 */
import type { GatewayConfig } from '../config.js';
import type { ActionStore } from '../store/actionStore.js';
import type { AuditLog } from '../store/auditLog.js';
import type { Judge } from '../judge/judge.js';
import type { ReferenceStore } from '../store/referenceStore.js';
import type { SelectionStore } from '../store/selectionStore.js';
import { createLogger, describeError, type Logger } from '../util/log.js';
import { newSelectionId } from '../util/ids.js';
import { note, publicResourceRef, sanitiseLabel, type PublicFindResult } from './egress.js';
import { resourceStateHash } from './binding.js';
import { safeEqual } from '../util/hash.js';
import { ApprovalConflictError, UnknownActionError } from './actionExecutor.js';
import type { SourceLookup } from './orchestrator.js';
import { resourceBindingsOf, targetIdOf } from './types.js';
import type {
    ActionRecord,
    InternalResource,
    ResourceRecord,
    SelectionCandidate,
    SelectionRequest
} from './types.js';
import type { SelectionOutcomeForAction } from './localViews.js';

export class SelectionFlow {
    private readonly log: Logger;

    constructor(
        private readonly config: GatewayConfig,
        private readonly selections: SelectionStore,
        private readonly references: ReferenceStore,
        private readonly actions: ActionStore,
        private readonly audit: AuditLog,
        private readonly sources: SourceLookup,
        private readonly judge: Judge,
        private readonly localModelFailure: (error: unknown) => PublicFindResult,
        private readonly discardStaged: (actionId: string) => void,
        private readonly mintReference: (
            resource: InternalResource,
            safeLabel: string,
            purpose: string,
            originQuery: string
        ) => Promise<ResourceRecord>,
        logger?: Logger
    ) {
        this.log = logger ?? createLogger('orchestrator');
    }

    async createSelection(
        query: string,
        purpose: string,
        candidates: InternalResource[],
        reasoning: string,
        originActionId?: string
    ): Promise<SelectionRequest> {
        const now = new Date();
        const selectionCandidates: SelectionCandidate[] = candidates.map((resource, index) => ({
            candidateId: `c${index + 1}`,
            resource
        }));
        const request: SelectionRequest = {
            selectionId: newSelectionId(),
            query,
            purpose,
            candidates: selectionCandidates,
            reasoning,
            createdAt: now.toISOString(),
            expiresAt: new Date(
                now.getTime() + this.config.approval.selectionTtlSeconds * 1000
            ).toISOString(),
            status: 'open',
            originActionId
        };
        await this.selections.create(request);
        this.log.info('Auswahl erforderlich', {
            selectionId: request.selectionId,
            candidates: selectionCandidates.length,
            originActionId: originActionId ?? null
        });
        return request;
    }

    /**
     * Decides what a resolved selection means for the action parked on it.
     *
     * Same resource in the same state as the action was prepared against: the
     * user confirmed what was already there, so the action comes back exactly as
     * it was — same plan, same binding hash, same countdown. Anything else — a
     * different document, or the same one after it changed — cannot be squared
     * with a binding that pins the resource and its state, so the action is
     * discarded and Hermes has to prepare a new one against the new reference.
     */
    async settleParkedAction(
        request: SelectionRequest,
        candidate: SelectionCandidate
    ): Promise<SelectionOutcomeForAction> {
        const actionId = request.originActionId;
        if (!actionId) {
            return { kind: 'none' };
        }
        const action = this.actions.get(actionId);
        if (!action || action.status !== 'selection_required') {
            return { kind: 'none' };
        }

        const record = this.references.resolve(action.resourceRef);
        const unchanged =
            record !== undefined &&
            record.locator.sourceId === candidate.resource.locator.sourceId &&
            record.locator.nativeId === candidate.resource.locator.nativeId &&
            safeEqual(resourceStateHash(candidate.resource), action.resourceStateHash);

        if (unchanged) {
            // `unpark` reports `none` if the action expired while the user was
            // comparing candidates, which is the honest answer here too.
            return this.unpark(actionId, 'selection_confirmed_same_resource');
        }

        await this.actions.transition(actionId, 'rejected', {
            reason: 'user_discarded',
            decidedAt: new Date().toISOString()
        });
        this.discardStaged(actionId);
        await this.audit.record('action_discarded', {
            actionId,
            resourceRef: action.resourceRef,
            targetId: targetIdOf(action.plan),
            selectionId: request.selectionId,
            detail: { reason: 'user_chose_other_resource' }
        });
        return { kind: 'discarded', actionId };
    }

    /** Returns a parked action to the approval queue. A no-op for anything else. */
    async unpark(actionId: string | undefined, reason: string): Promise<SelectionOutcomeForAction> {
        if (!actionId) {
            return { kind: 'none' };
        }
        const action = this.actions.get(actionId);
        if (!action || action.status !== 'selection_required') {
            return { kind: 'none' };
        }
        if (Date.parse(action.expiresAt) <= Date.now()) {
            // Restoring it would only offer the user a button that the approval
            // path refuses a moment later.
            await this.actions.transition(actionId, 'expired', { reason: 'action_expired' });
            return { kind: 'none' };
        }
        await this.actions.transition(actionId, 'awaiting_local_approval', { reason: 'awaiting_user' });
        await this.audit.record('action_restored', {
            actionId,
            resourceRef: action.resourceRef,
            targetId: targetIdOf(action.plan),
            detail: { reason }
        });
        return { kind: 'restored', actionId };
    }

    /**
     * Resolves a natural-language query to a single opaque reference, or
     * reports that the user has to choose locally. This is `find_resource`'s
     * fresh-search path; `resumeSelection` is its return path once a selection
     * handle exists.
     */
    async resolveQuery(correlationId: string, query: string, purpose: string): Promise<PublicFindResult> {
        // A resource the user picked by hand for this exact query and purpose wins
        // over a fresh model guess. This is the return path after "andere Ressource
        // wählen" in the approval view.
        const userChoice = this.selections.findResolvedFor(query, purpose);
        if (userChoice?.resolvedRef) {
            const chosen = this.references.resolve(userChoice.resolvedRef);
            if (chosen) {
                return {
                    status: 'resolved',
                    resource: publicResourceRef(chosen),
                    note: note('selection_resolved')
                };
            }
        }

        const availableSources = this.sources.available();
        if (availableSources.length === 0) {
            await this.audit.record('source_unavailable', {
                correlationId,
                detail: { reason: 'no_source_connected' }
            });
            return { status: 'unavailable', note: note('source_unavailable') };
        }

        // Gather candidates across every reachable source. A source failing here
        // must not hide results from the others.
        const candidates: InternalResource[] = [];
        for (const source of availableSources) {
            try {
                const found = await source.search(query, this.config.sources[0]?.maxCandidates ?? 8);
                candidates.push(...found);
                await this.audit.record('source_queried', {
                    correlationId,
                    sourceId: source.id,
                    detail: { query, resultCount: found.length }
                });
            } catch (error) {
                await this.audit.record('source_unavailable', {
                    correlationId,
                    sourceId: source.id,
                    detail: { error: describeError(error) }
                });
                this.log.warn('Suche in Quelle fehlgeschlagen', {
                    sourceId: source.id,
                    error: describeError(error)
                });
            }
        }

        if (candidates.length === 0) {
            return { status: 'not_found', note: note('not_found') };
        }

        let outcome;
        try {
            outcome = await this.judge.selectResource(query, purpose, candidates, correlationId);
        } catch (error) {
            return this.localModelFailure(error);
        }

        if (outcome.kind === 'none') {
            return { status: 'not_found', note: note('not_found') };
        }
        if (outcome.kind === 'ambiguous') {
            const selection = await this.createSelection(query, purpose, candidates, outcome.judgement.reasoning);
            return {
                status: 'selection_required',
                selection_reference: selection.selectionId,
                note: note('selection_required')
            };
        }

        const record = await this.mintReference(outcome.resource, outcome.safeLabel, purpose, query);
        return {
            status: 'resolved',
            resource: publicResourceRef(record),
            note: note('resource_resolved')
        };
    }

    /** Answers a `find_resource` call that carries a selection handle. */
    async resumeSelection(selectionId: string): Promise<PublicFindResult> {
        const request = this.selections.get(selectionId);
        if (!request) {
            return { status: 'not_found', note: note('reference_unknown') };
        }
        if (request.status === 'open') {
            if (Date.parse(request.expiresAt) <= Date.now()) {
                await this.selections.expireStale();
                return { status: 'not_found', note: note('reference_expired') };
            }
            return {
                status: 'selection_pending',
                selection_reference: selectionId,
                note: note('selection_pending')
            };
        }
        if (request.status === 'resolved' && request.resolvedRef) {
            const record = this.references.resolve(request.resolvedRef);
            if (!record) {
                return { status: 'not_found', note: note('reference_expired') };
            }
            return {
                status: 'resolved',
                resource: publicResourceRef(record),
                note: note('selection_resolved')
            };
        }
        return { status: 'not_found', note: note('ambiguous_no_candidates') };
    }

    /**
     * Records the user's pick for an ambiguous search and mints the reference.
     * Hermes learns only that the selection resolved, via `find_resource` with
     * the selection handle.
     */
    async resolve(
        selectionId: string,
        candidateId: string
    ): Promise<{ ref: string; action: SelectionOutcomeForAction }> {
        const request = this.selections.get(selectionId);
        if (!request) {
            throw new UnknownActionError(`Auswahl ${selectionId} ist unbekannt.`);
        }
        if (request.status !== 'open') {
            throw new ApprovalConflictError(`Auswahl ${selectionId} ist bereits ${request.status}.`);
        }
        if (Date.parse(request.expiresAt) <= Date.now()) {
            await this.selections.cancel(selectionId);
            throw new ApprovalConflictError(`Auswahl ${selectionId} ist abgelaufen.`);
        }
        const candidate = request.candidates.find((entry) => entry.candidateId === candidateId);
        if (!candidate) {
            throw new UnknownActionError(`Kandidat ${candidateId} gehört nicht zu dieser Auswahl.`);
        }
        // The user's own choice is authoritative, so no model call here. The label
        // still passes through the same scrubbing as any model-proposed one.
        const record = await this.mintReference(
            candidate.resource,
            sanitiseLabel(candidate.resource.title),
            request.purpose,
            request.query
        );
        await this.selections.resolve(selectionId, record.ref);
        const action = await this.settleParkedAction(request, candidate);
        return { ref: record.ref, action };
    }

    /**
     * Ends a selection without a pick. An action parked on it goes back to
     * waiting for approval — cancelling the question is not answering it, and
     * least of all is it a rejection.
     */
    async cancel(selectionId: string): Promise<SelectionOutcomeForAction> {
        const request = this.selections.get(selectionId);
        await this.selections.cancel(selectionId);
        return this.unpark(request?.originActionId, 'selection_cancelled');
    }

    /**
     * "Andere Ressource wählen" from the approval view.
     *
     * Re-runs the action's original search so the user can look at the
     * alternatives by hand. The action is *parked*, not discarded: it moves to
     * `selection_required`, which is not approvable, and waits there.
     *
     * Confirming the same resource restores the action unchanged, picking a
     * different one discards it (the binding covers the resource, so a
     * different resource genuinely needs a new action), and cancelling the
     * selection puts it back as it was.
     */
    async reselect(action: ActionRecord): Promise<{ selectionId: string }> {
        if (action.status !== 'awaiting_local_approval') {
            throw new ApprovalConflictError(
                `Aktion ${action.actionId} steht nicht zur Entscheidung (Status: ${action.status}).`
            );
        }
        if (resourceBindingsOf(action).length !== 1) {
            throw new ApprovalConflictError(
                'Eine einzelne Ressource kann in einer Mehrfachaktion nicht separat ersetzt werden. Bitte die Aktion verwerfen und neu vorbereiten.'
            );
        }
        const record = this.references.resolve(action.resourceRef);
        const query = record?.originQuery ?? record?.localSummary.title;
        if (!query) {
            throw new ApprovalConflictError(
                'Die ursprüngliche Suchanfrage ist nicht mehr verfügbar. Bitte die Aktion verwerfen und neu vorbereiten.'
            );
        }

        // Park before searching: while the user is comparing candidates the
        // action must not be approvable, but it must still be recoverable.
        await this.actions.transition(action.actionId, 'selection_required', { reason: 'selection_pending' });
        await this.audit.record('action_parked', {
            actionId: action.actionId,
            resourceRef: action.resourceRef,
            targetId: targetIdOf(action.plan),
            detail: { query }
        });

        const candidates: InternalResource[] = [];
        for (const source of this.sources.available()) {
            try {
                candidates.push(...(await source.search(query, this.config.sources[0]?.maxCandidates ?? 8)));
            } catch (error) {
                this.log.warn('Erneute Suche in Quelle fehlgeschlagen', {
                    sourceId: source.id,
                    error: describeError(error)
                });
            }
        }
        if (candidates.length === 0) {
            // Nothing to choose between, so there is nothing to park for.
            await this.unpark(action.actionId, 'reselection_without_candidates');
            throw new ApprovalConflictError(
                'Die erneute Suche lieferte keine Kandidaten. Die Aktion wartet unverändert weiter auf eine Entscheidung.'
            );
        }
        const selection = await this.createSelection(
            query,
            action.purpose,
            candidates,
            'Der Nutzer hat eine andere Ressource verlangt und wählt lokal aus.',
            action.actionId
        );
        return { selectionId: selection.selectionId };
    }
}
