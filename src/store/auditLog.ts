import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { newEventId } from '../util/ids.js';

/**
 * Local, append-only trail of every decision the gateway made (invariant 14).
 *
 * Unlike the reference and action stores this file is never compacted and has
 * no delete path: the point of the record is that it survives the thing it
 * describes. Entries may contain internal ids and full egress payloads, because
 * they exist so the user can reconstruct afterwards exactly what left the
 * machine and on whose authority.
 */
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
    | 'action_binding_mismatch'
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

    constructor(private readonly filePath: string) {}

    async init(): Promise<void> {
        await mkdir(dirname(this.filePath), { recursive: true });
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
        return events.slice(-limit).reverse();
    }
}
