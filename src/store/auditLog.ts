import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { newEventId } from '../util/ids.js';

/**
 * Local, append-only trail of every decision the gateway made (invariant 14).
 *
 * Append-only within a retention window, not forever. Entries carry internal
 * ids and enough of an egress payload to reconstruct what left the machine and
 * on whose authority — never a document's content, never a summary's text,
 * never a message body — and a file of those growing without bound is itself a
 * privacy problem: it accumulates a picture of the user's affairs that nobody
 * chose to keep. `prune` therefore drops entries past `retentionDays` and
 * caps the file at `maxEntries`, oldest first.
 */

/** How much history the trail keeps. Both bounds apply; whichever bites first wins. */
export interface AuditRetention {
    retentionDays: number;
    maxEntries: number;
}
export type AuditEventType =
    | 'gateway_started'
    | 'gateway_stopped'
    | 'hermes_request'
    | 'hermes_response'
    | 'hermes_request_rejected'
    | 'source_queried'
    | 'source_unavailable'
    | 'judge_invoked'
    | 'judge_unavailable'
    | 'judge_output_rejected'
    | 'reference_minted'
    | 'reference_rejected'
    | 'selection_required'
    | 'selection_resolved'
    | 'selection_cancelled'
    | 'action_prepared'
    | 'action_approved'
    | 'action_rejected'
    | 'action_discarded'
    /** Parked while the user re-picks the resource; not a decision yet. */
    | 'action_parked'
    /** Un-parked after the user confirmed the resource it already carried. */
    | 'action_restored'
    /** A referenced resource changed in the source since the reference was minted. */
    | 'resource_state_mismatch'
    | 'egress_performed'
    | 'egress_failed'
    | 'action_expired'
    | 'reference_expired'
    | 'invariant_blocked'
    | 'telegram_notified'
    | 'telegram_delivery_failed'
    | 'telegram_callback_rejected';

export interface AuditEvent {
    eventId: string;
    ts: string;
    type: AuditEventType;
    /** Correlates entries belonging to one logical operation. */
    correlationId?: string;
    resourceRef?: string;
    actionId?: string;
    selectionId?: string;
    sourceId?: string;
    targetId?: string;
    /** Free-form local detail. Never sent to Hermes. */
    detail?: Record<string, unknown>;
}

export class AuditLog {
    private writeChain: Promise<void> = Promise.resolve();

    constructor(
        private readonly filePath: string,
        /**
         * Absent means "keep everything", which is what the tests and any
         * embedding without a configured window get. The gateway always passes
         * one — see `index.ts`.
         */
        private readonly retention?: AuditRetention
    ) {}

    async init(): Promise<void> {
        await mkdir(dirname(this.filePath), { recursive: true });
        await this.prune();
    }

    record(type: AuditEventType, fields: Omit<AuditEvent, 'eventId' | 'ts' | 'type'> = {}): Promise<void> {
        const event: AuditEvent = {
            eventId: newEventId(),
            ts: new Date().toISOString(),
            type,
            ...fields
        };
        const next = this.writeChain.then(() =>
            appendFile(this.filePath, `${JSON.stringify(event)}\n`, 'utf8')
        );
        this.writeChain = next.catch(() => undefined);
        return next;
    }

    /** Most recent entries first. Used by the local history view. */
    async tail(limit = 200): Promise<AuditEvent[]> {
        // Flush first, then look. The other order asks whether the file exists
        // before the writes that would create it have run — and `record` is
        // deliberately fire-and-forget in places, so on a fresh trail the very
        // events a reader is asking about are exactly the ones still queued.
        await this.writeChain;
        const events = await this.readAll();
        return events.slice(-limit).reverse();
    }

    /**
     * Drops entries the configured window no longer covers, oldest first.
     *
     * Runs on the same write chain as `record`, because it rewrites the file
     * an append would otherwise be extending. Entries without a parseable
     * timestamp are kept: the point is to forget deliberately, and a line the
     * pruner cannot date is not a line it should be deciding about.
     *
     * Returns how many entries were removed.
     */
    async prune(): Promise<number> {
        if (!this.retention) {
            return 0;
        }
        const { retentionDays, maxEntries } = this.retention;
        const next = this.writeChain.then(async () => {
            const events = await this.readAll();
            if (events.length === 0) {
                return 0;
            }
            const cutoff = Date.now() - retentionDays * 86_400_000;
            const withinWindow = events.filter((event) => {
                const ts = Date.parse(event.ts);
                return Number.isNaN(ts) || ts >= cutoff;
            });
            const kept = withinWindow.slice(-maxEntries);
            if (kept.length === events.length) {
                return 0;
            }
            const temporaryPath = `${this.filePath}.tmp`;
            const serialised = kept.map((event) => `${JSON.stringify(event)}\n`).join('');
            await writeFile(temporaryPath, serialised, { encoding: 'utf8', mode: 0o600 });
            await rename(temporaryPath, this.filePath);
            return events.length - kept.length;
        });
        this.writeChain = next.then(
            () => undefined,
            () => undefined
        );
        return next;
    }

    private async readAll(): Promise<AuditEvent[]> {
        if (!existsSync(this.filePath)) {
            return [];
        }
        const content = await readFile(this.filePath, 'utf8');
        const events: AuditEvent[] = [];
        for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (trimmed.length === 0) {
                continue;
            }
            try {
                events.push(JSON.parse(trimmed) as AuditEvent);
            } catch {
                // A single unreadable entry must not hide the rest of the trail.
                continue;
            }
        }
        return events;
    }
}
