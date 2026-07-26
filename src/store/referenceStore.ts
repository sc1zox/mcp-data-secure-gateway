import type { ResourceRecord } from '../core/types.js';
import { JsonlStore, storePath } from './jsonlStore.js';
import type { AuditLog } from './auditLog.js';

/**
 * The mapping from opaque reference to real resource (invariants 4 and 5).
 *
 * This store is the reason Hermes can name a document without knowing anything
 * about it. Two rules matter beyond plain lookup:
 *
 *  - references expire, so a handle Hermes remembers from an old conversation
 *    cannot be used to reach into the sources later,
 *  - a reference is bound to the purpose it was minted for. Resolving it for a
 *    different purpose fails, so an intent stated as "find my CV to apply for a
 *    job" cannot silently become the basis for mailing it somewhere else.
 */
export class ReferenceStore {
    private readonly store: JsonlStore<ResourceRecord>;

    constructor(dataDir: string, private readonly audit: AuditLog) {
        this.store = new JsonlStore<ResourceRecord>(storePath(dataDir, 'references'), (record) => record.ref);
    }

    async load(): Promise<void> {
        await this.store.load();
        await this.pruneExpired();
        await this.store.compact();
    }

    async mint(record: ResourceRecord): Promise<void> {
        await this.store.put(record);
        await this.audit.record('reference_minted', {
            resourceRef: record.ref,
            sourceId: record.locator.sourceId,
            detail: {
                nativeId: record.locator.nativeId,
                title: record.localSummary.title,
                safeLabel: record.safeLabel,
                purpose: record.purpose,
                stateHash: record.stateHash,
                expiresAt: record.expiresAt
            }
        });
    }

    /** Returns the record only if it exists and has not expired. */
    resolve(ref: string, now: Date = new Date()): ResourceRecord | undefined {
        const record = this.store.get(ref);
        if (!record) {
            return undefined;
        }
        if (Date.parse(record.expiresAt) <= now.getTime()) {
            return undefined;
        }
        return record;
    }

    /**
     * Resolves a reference for a specific purpose. A mismatch is a refusal, not
     * a warning: the whole point of carrying the purpose is that it constrains
     * later use of the handle.
     */
    resolveForPurpose(ref: string, purpose: string, now: Date = new Date()): ResourceRecord | undefined {
        const record = this.resolve(ref, now);
        if (!record) {
            return undefined;
        }
        if (normalisePurpose(record.purpose) !== normalisePurpose(purpose)) {
            return undefined;
        }
        return record;
    }

    all(): ResourceRecord[] {
        return this.store.all();
    }

    async pruneExpired(now: Date = new Date()): Promise<number> {
        let pruned = 0;
        for (const record of this.store.all()) {
            if (Date.parse(record.expiresAt) <= now.getTime()) {
                await this.store.delete(record.ref);
                await this.audit.record('reference_expired', {
                    resourceRef: record.ref,
                    sourceId: record.locator.sourceId,
                    detail: { expiresAt: record.expiresAt }
                });
                pruned += 1;
            }
        }
        return pruned;
    }
}

/**
 * Purposes are user-facing prose coming from Hermes, so exact string equality
 * would be brittle. Whitespace and case are ignored; wording is not, because a
 * materially different purpose should require a new search.
 */
function normalisePurpose(purpose: string): string {
    return purpose.trim().toLowerCase().replace(/\s+/g, ' ');
}
