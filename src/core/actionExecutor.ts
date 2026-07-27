/**
 * Invariants 7 + 12 — nothing is transferred except through here, and only
 * with exactly what was approved.
 *
 * This is the sole owner of `staged`, the in-memory originals kept between
 * `prepare_action` and a decision. Every action that reaches a terminal state
 * without having been delivered must have its staged bytes dropped here —
 * that is the whole reason the map has exactly one owner instead of eight
 * call sites across the orchestrator each remembering to clean up.
 */
import type { ActionStore } from '../store/actionStore.js';
import type { AuditLog } from '../store/auditLog.js';
import type { SourceFile } from '../sources/source.js';
import { TargetDeliveryError, type EgressAttachment } from '../targets/target.js';
import { sha256Bytes, sha256Text, safeEqual } from '../util/hash.js';
import { describeError, type Logger } from '../util/log.js';
import { isSafeAttachment } from './attachmentSafety.js';
import { verifyStoredBinding } from './binding.js';
import type { TargetLookup } from './orchestrator.js';
import { ResourceGate, ResourceSetChangedError } from './resourceGate.js';
import { resourceBindingsOf, targetIdOf } from './types.js';
import type { ActionRecord, SendResourcePlan, SummariseResourcePlan } from './types.js';

/** Thrown when an approval or rejection is submitted against a stored action that no longer supports it. */
export class ApprovalConflictError extends Error {}
/** Thrown for an actionId/selectionId/candidateId with no matching stored record. */
export class UnknownActionError extends Error {}

export class ActionExecutor {
    /**
     * Original files fetched while preparing an action, held until the action
     * reaches a terminal state. Keeping them means the approval view can show the
     * exact size and digest of the complete set, and that approval does not race
     * a second download.
     */
    private readonly staged = new Map<string, SourceFile[]>();

    constructor(
        private readonly actions: ActionStore,
        private readonly targets: TargetLookup,
        private readonly resourceGate: ResourceGate,
        private readonly audit: AuditLog,
        private readonly log: Logger
    ) {}

    stage(actionId: string, files: SourceFile[]): void {
        this.staged.set(actionId, files);
    }

    discard(actionId: string): void {
        this.staged.delete(actionId);
    }

    hasStaged(actionId: string): boolean {
        return this.staged.has(actionId);
    }

    /** Same check as `hasStaged`, named for read sites that ask "would sending need a refetch?". */
    isStaged(actionId: string): boolean {
        return this.staged.has(actionId);
    }

    /**
     * Carries out what the user approved. Runs after the human decision and is
     * the only place in the gateway that hands a payload to anything.
     */
    async execute(action: ActionRecord): Promise<void> {
        if (action.plan.kind === 'summarize_resource') {
            await this.release(action, action.plan);
            return;
        }
        await this.deliver(action, action.plan);
    }

    /**
     * Releases an action for delivery.
     *
     * `expectedBindingHash` is the hash the UI displayed. Requiring it back is
     * how "an approval covers exactly the combination that was shown" becomes
     * enforceable: if the record changed between rendering and clicking, the
     * hashes differ and the approval is refused rather than applied to
     * something the user never saw. `verifyStoredBinding` (invariant 12) then
     * guards against a tampered store, where the hash must still follow from
     * the fields it covers.
     */
    async approve(actionId: string, expectedBindingHash: string): Promise<ActionRecord> {
        const action = this.actions.get(actionId);
        if (!action) {
            throw new UnknownActionError(`Aktion ${actionId} ist unbekannt.`);
        }
        if (action.status !== 'awaiting_local_approval') {
            throw new ApprovalConflictError(
                `Aktion ${actionId} steht nicht zur Freigabe (Status: ${action.status}).`
            );
        }
        if (Date.parse(action.expiresAt) <= Date.now()) {
            await this.actions.transition(actionId, 'expired', { reason: 'action_expired' });
            throw new ApprovalConflictError(`Aktion ${actionId} ist abgelaufen.`);
        }
        if (!safeEqual(expectedBindingHash, action.bindingHash)) {
            await this.audit.record('action_binding_mismatch', {
                actionId,
                detail: { expected: action.bindingHash, submitted: expectedBindingHash, phase: 'approve' }
            });
            throw new ApprovalConflictError(
                'Die angezeigte Aktion stimmt nicht mehr mit der gespeicherten Aktion überein. Bitte neu prüfen.'
            );
        }
        const verification = verifyStoredBinding(action);
        if (!verification.ok) {
            await this.audit.record('invariant_blocked', {
                actionId,
                detail:
                    verification.invariant === 'action_resource_set'
                        ? { invariant: 'action_resource_set', phase: 'approve' }
                        : { invariant: 'action_immutability', expected: verification.expected, stored: action.bindingHash }
            });
            await this.actions.transition(actionId, 'failed', { reason: 'delivery_failed' });
            throw new ApprovalConflictError(
                verification.invariant === 'action_resource_set'
                    ? 'Die Ressourcenmenge der Aktion ist inkonsistent gespeichert und wurde nicht ausgeführt.'
                    : 'Die Aktion ist inkonsistent gespeichert und wurde nicht ausgeführt.'
            );
        }

        await this.audit.record('action_approved', {
            actionId,
            resourceRef: action.resourceRef,
            targetId: targetIdOf(action.plan),
            detail: {
                bindingHash: action.bindingHash,
                purpose: action.purpose,
                resourceRefs: verification.bindings.map((binding) => binding.resourceRef)
            }
        });
        const executing = await this.actions.transition(actionId, 'executing', {
            decidedAt: new Date().toISOString()
        });
        // Deliberately not awaited: delivery can take seconds and the UI should
        // return immediately. Status is polled from the store afterwards.
        void this.execute(executing);
        return executing;
    }

    async reject(actionId: string, discard = false): Promise<ActionRecord> {
        const action = this.actions.get(actionId);
        if (!action) {
            throw new UnknownActionError(`Aktion ${actionId} ist unbekannt.`);
        }
        if (action.status !== 'awaiting_local_approval') {
            throw new ApprovalConflictError(
                `Aktion ${actionId} kann nicht abgelehnt werden (Status: ${action.status}).`
            );
        }
        const updated = await this.actions.transition(actionId, 'rejected', {
            reason: discard ? 'user_discarded' : 'user_rejected',
            decidedAt: new Date().toISOString()
        });
        this.discard(actionId);
        await this.audit.record(discard ? 'action_discarded' : 'action_rejected', {
            actionId,
            resourceRef: action.resourceRef,
            targetId: targetIdOf(action.plan)
        });
        return updated;
    }

    /**
     * Releases an approved summary for collection.
     *
     * Nothing is transmitted here — the gateway does not call outwards, for
     * summaries no more than for anything else. What changes is that the action
     * becomes `completed`, and `get_summary` hands the text over from then on.
     * That status change is the moment the user's decision takes effect, so it
     * is the moment the audit trail records as the egress.
     */
    private async release(action: ActionRecord, plan: SummariseResourcePlan): Promise<void> {
        if (!safeEqual(sha256Text(plan.summary), plan.summarySha256)) {
            await this.fail(
                action.actionId,
                'delivery_failed',
                'Der gespeicherte Zusammenfassungstext weicht von der freigegebenen Prüfsumme ab.'
            );
            return;
        }
        await this.actions.transition(action.actionId, 'completed', {
            reason: 'summary_released',
            executedAt: new Date().toISOString(),
            localOutcome: `Zusammenfassung freigegeben (${plan.summary.length} Zeichen)`
        });
        await this.audit.record('egress_performed', {
            actionId: action.actionId,
            resourceRef: action.resourceRef,
            detail: {
                kind: 'summarize_resource',
                recipientDisplay: 'Cloud-Agent (Abholung über get_summary)',
                summarySha256: plan.summarySha256,
                summaryChars: plan.summary.length,
                redactions: plan.redactions,
                bindingHash: action.bindingHash
            }
        });
        this.log.info('Zusammenfassung freigegeben', { actionId: action.actionId });
    }

    /** Performs the approved transfer of the original document to its target. */
    private async deliver(action: ActionRecord, plan: SendResourcePlan): Promise<void> {
        const target = this.targets.get(plan.targetId);
        if (!target) {
            await this.fail(action.actionId, 'target_unavailable', 'Ziel ist nicht mehr konfiguriert.');
            return;
        }

        let attachments: EgressAttachment[];
        try {
            attachments = await this.materialiseAttachments(action, plan);
        } catch (error) {
            await this.fail(
                action.actionId,
                error instanceof ResourceSetChangedError ? 'resource_changed' : 'source_unavailable',
                describeError(error)
            );
            return;
        }

        try {
            const receipt = await target.deliver({
                subject: plan.subject,
                body: plan.body,
                attachments,
                recipient: plan.recipientAddress
            });
            await this.actions.transition(action.actionId, 'completed', {
                reason: 'delivered',
                executedAt: new Date().toISOString(),
                localOutcome: receipt.reference
            });
            await this.audit.record('egress_performed', {
                actionId: action.actionId,
                resourceRef: action.resourceRef,
                targetId: plan.targetId,
                detail: {
                    recipientDisplay: plan.recipientDisplay,
                    subject: plan.subject,
                    bodySha256: sha256Text(plan.body),
                    bodyChars: plan.body.length,
                    resourceBindings: resourceBindingsOf(action).map(
                        ({ resourceRef, resourceStateHash }) => ({
                            resourceRef,
                            resourceStateHash
                        })
                    ),
                    attachments: plan.attachments,
                    deliveryReference: receipt.reference,
                    bindingHash: action.bindingHash
                }
            });
            this.log.info('Aktion ausgeführt', { actionId: action.actionId });
        } catch (error) {
            const reason = error instanceof TargetDeliveryError ? 'delivery_failed' : 'target_unavailable';
            await this.fail(action.actionId, reason, describeError(error));
        } finally {
            this.discard(action.actionId);
        }
    }

    /**
     * Produces the bytes to send.
     *
     * Normally they are the ones staged at prepare time. After a restart the
     * staging map is empty, so every file is re-read and compared against the
     * approved ordered plan. Any difference abandons the whole transfer rather
     * than sending content the user never approved.
     */
    private async materialiseAttachments(
        action: ActionRecord,
        plan: SendResourcePlan
    ): Promise<EgressAttachment[]> {
        const planned = plan.attachments;
        const resolved = await this.resourceGate.revalidateForExecution(action);
        if (planned.length !== resolved.length) {
            throw new ResourceSetChangedError(
                'Die Zahl der gespeicherten Ressourcen stimmt nicht mit der freigegebenen Anhangsmenge überein.'
            );
        }

        const staged = this.staged.get(action.actionId);
        if (staged) {
            if (staged.length !== planned.length) {
                throw new ResourceSetChangedError(
                    'Die bereitgestellte Ressourcenmenge weicht von der freigegebenen Aktion ab.'
                );
            }
            return staged.map((file, index) => {
                const expected = planned[index]!;
                if (
                    file.bytes.byteLength !== expected.byteSize ||
                    !safeEqual(sha256Bytes(file.bytes), expected.sha256)
                ) {
                    throw new ResourceSetChangedError(
                        'Die bereitgestellten Daten weichen von der freigegebenen Aktion ab.'
                    );
                }
                return {
                    filename: expected.filename,
                    mimeType: expected.mimeType,
                    bytes: file.bytes
                };
            });
        }

        const attachments: EgressAttachment[] = [];
        for (const [index, { record, source }] of resolved.entries()) {
            let file: SourceFile;
            try {
                file = await source.fetchOriginal(record.locator.nativeId);
            } catch {
                throw new Error('Mindestens eine Ressource konnte nicht erneut geladen werden.');
            }
            if (!isSafeAttachment(file)) {
                throw new ResourceSetChangedError(
                    'Die erneut geladene Ressourcenmenge enthält unsichere Anhangsmetadaten.'
                );
            }
            const expected = planned[index]!;
            if (
                file.filename !== expected.filename ||
                file.mimeType !== expected.mimeType ||
                file.bytes.byteLength !== expected.byteSize ||
                !safeEqual(sha256Bytes(file.bytes), expected.sha256)
            ) {
                throw new ResourceSetChangedError(
                    'Die Ressourcenmenge hat sich seit der Freigabe geändert.'
                );
            }
            attachments.push({
                filename: expected.filename,
                mimeType: expected.mimeType,
                bytes: file.bytes
            });
        }
        return attachments;
    }

    private async fail(
        actionId: string,
        reason: ActionRecord['statusReason'] & string,
        detail: string
    ): Promise<void> {
        try {
            await this.actions.transition(actionId, 'failed', {
                reason,
                localOutcome: detail,
                executedAt: new Date().toISOString()
            });
        } catch (error) {
            this.log.error('Statuswechsel auf failed nicht möglich', {
                actionId,
                error: describeError(error)
            });
        }
        await this.audit.record('egress_failed', { actionId, detail: { reason, detail } });
        this.log.warn('Aktion fehlgeschlagen', { actionId, reason, detail });
        this.discard(actionId);
    }
}
