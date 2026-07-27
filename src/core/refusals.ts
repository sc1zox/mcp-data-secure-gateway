/**
 * Invariant 13 — closed refusal vocabulary.
 *
 * Every path that answers Hermes without producing or executing an action —
 * an invalid request, an unreachable source, a local model that would not
 * respond — comes through here, so the note codes and `PublicActionState`
 * shapes that can ever reach the boundary are enumerated in one place rather
 * than assembled ad hoc at each call site.
 */
import { LocalModelResponseError, LocalModelUnavailableError } from '../judge/ollamaClient.js';
import { SourceUnavailableError } from '../sources/source.js';
import type { AuditLog } from '../store/auditLog.js';
import { describeError, type Logger } from '../util/log.js';
import { note, type EgressGuard, type PublicActionState, type PublicFindResult } from './egress.js';
import type { ActionRecord } from './types.js';

const SYNTHETIC_REASONS: Partial<Record<Parameters<typeof note>[0], ActionRecord['statusReason']>> = {
    resource_changed: 'resource_changed',
    reference_expired: 'resource_expired',
    source_unavailable: 'source_unavailable',
    local_model_unavailable: 'local_model_unavailable',
    target_unavailable: 'target_unavailable',
    target_unknown: 'target_unavailable'
};

export class RefusalFactory {
    constructor(
        private readonly audit: AuditLog,
        private readonly guard: EgressGuard,
        private readonly log: Logger
    ) {}

    /** No cloud fallback, by design (invariant 10): a local-model error ends the request. */
    localModelFailure(error: unknown): PublicFindResult {
        if (error instanceof LocalModelUnavailableError || error instanceof LocalModelResponseError) {
            this.log.error('Lokale Bewertung nicht möglich; kein Ersatzpfad.', {
                error: describeError(error)
            });
            return { status: 'unavailable', note: note('local_model_unavailable') };
        }
        if (error instanceof SourceUnavailableError) {
            return { status: 'unavailable', note: note('source_unavailable') };
        }
        this.log.error('Unerwarteter Fehler bei der Suche', { error: describeError(error) });
        return { status: 'unavailable', note: note('invalid_request') };
    }

    async rejectRequest(
        correlationId: string,
        noteCode: Parameters<typeof note>[0],
        detail: Record<string, unknown>
    ): Promise<PublicActionState> {
        await this.audit.record('hermes_request_rejected', {
            correlationId,
            detail: { ...detail, noteCode }
        });
        return this.syntheticActionState(noteCode, note(noteCode));
    }

    /**
     * A refusal that never became an action still has to answer in the action
     * vocabulary. `failed` plus a coarse note is the honest shape: nothing is
     * pending and nothing was sent.
     */
    syntheticActionState(
        noteCode: Parameters<typeof note>[0],
        noteText: string,
        actionId = 'act_none'
    ): PublicActionState {
        const payload: PublicActionState = {
            action_id: actionId,
            status: 'failed',
            note: noteText
        };
        const reason = SYNTHETIC_REASONS[noteCode];
        if (reason) {
            payload.reason = reason;
        }
        this.guard.assertClean(payload, 'action_refusal');
        return payload;
    }
}
