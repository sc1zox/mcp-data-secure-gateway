/**
 * Turns a validated Hermes request into a persisted, awaiting-approval action.
 *
 * Complements `actionExecutor.ts`: that module owns what happens after a human
 * approves; this one owns assembling exactly what will be shown to them, from
 * resolving and gating the referenced resource(s) (`resourceGate.ts`) through
 * building the frozen plan (`planBuilder.ts`) to persisting the record. Both
 * `prepare_action` and `summarize_resource` end here, because both produce
 * the same shape of thing — an action nothing has happened to yet.
 */
import type { GatewayConfig } from '../config.js';
import type { ActionStore } from '../store/actionStore.js';
import type { AuditLog } from '../store/auditLog.js';
import type { SourceFile } from '../sources/source.js';
import { sha256Bytes, sha256Text } from '../util/hash.js';
import { newActionId, newQueryId } from '../util/ids.js';
import { describeError, type Logger } from '../util/log.js';
import {
    EgressViolationError,
    publicActionState,
    type EgressGuard,
    type PublicActionState
} from './egress.js';
import { computeBindingHash } from './binding.js';
import {
    clamp,
    clampMultiline,
    emptyToUndefined,
    isValidRecipientFormat,
    normaliseRequestedReferences,
    type PrepareActionInput,
    type SummarizeResourceInput
} from './agentInput.js';
import {
    MAX_BODY_CHARS,
    MAX_FOCUS_CHARS,
    MAX_HERMES_NOTE_CHARS,
    MAX_PURPOSE_CHARS,
    MAX_SUBJECT_CHARS
} from './limits.js';
import { buildSendPlan, buildSummaryPlan } from './planBuilder.js';
import type { PreparationKey, PreparationLimiter } from './preparationLimits.js';
import { RefusalFactory } from './refusals.js';
import { ResourceGate } from './resourceGate.js';
import type { TargetLookup } from './orchestrator.js';
import type {
    ActionPlan,
    ActionRecord,
    ActionResourceBinding,
    JudgementRecord,
    PlannedAttachment,
    SendResourcePlan,
    SummariseResourcePlan
} from './types.js';

export class ActionPreparer {
    constructor(
        private readonly config: GatewayConfig,
        private readonly targets: TargetLookup,
        private readonly actions: ActionStore,
        private readonly guard: EgressGuard,
        private readonly audit: AuditLog,
        private readonly log: Logger,
        private readonly resourceGate: ResourceGate,
        private readonly refusals: RefusalFactory,
        private readonly stage: (actionId: string, files: SourceFile[]) => void,
        private readonly limiter: PreparationLimiter
    ) {}

    /**
     * The approval-fatigue gate, run before the source is touched.
     *
     * Placed here rather than after the plan is built on purpose: a caller in a
     * loop must not be able to make the gateway read documents and run local
     * inference once per refused request. Everything the check needs is in the
     * request itself.
     */
    private async guardAgainstFlood(
        correlationId: string,
        key: PreparationKey
    ): Promise<PublicActionState | undefined> {
        const refusal = this.limiter.check(key);
        if (!refusal) {
            return undefined;
        }
        this.log.warn('Vorbereitung abgelehnt, Schutz gegen Freigabeflut', {
            reason: refusal,
            kind: key.kind
        });
        return this.refusals.rejectRequest(correlationId, refusal, { reason: refusal });
    }

    /**
     * Binds a reference (or ordered set) to a target and a purpose, producing
     * an immutable action that waits for local approval. Nothing is
     * transferred here.
     */
    async prepareSend(input: PrepareActionInput): Promise<PublicActionState> {
        const correlationId = newQueryId();
        const purpose = clamp(input.purpose, MAX_PURPOSE_CHARS);
        const requestedReferences = normaliseRequestedReferences(input);
        const hermesNote = input.note ? clamp(input.note, MAX_HERMES_NOTE_CHARS) : undefined;
        // Subject through the single-line clamp: an outgoing mail header must not
        // be able to grow a second header from an embedded newline. The body keeps
        // its line breaks, because it is prose the user will read as prose.
        const agentSubject = emptyToUndefined(clamp(input.subject, MAX_SUBJECT_CHARS));
        const agentBody = emptyToUndefined(clampMultiline(input.body, MAX_BODY_CHARS));

        const recipientInput = input.recipient?.trim();
        await this.audit.record('hermes_request', {
            correlationId,
            resourceRef: input.reference ?? input.references?.[0],
            targetId: input.target,
            detail: {
                tool: 'prepare_action',
                purpose,
                resourceRefs: requestedReferences ?? [],
                hasNote: Boolean(hermesNote),
                agentSubject: agentSubject ?? null,
                agentBodyChars: agentBody?.length ?? 0,
                recipientRequested: recipientInput ?? null
            }
        });

        if (!requestedReferences || purpose.length === 0) {
            return this.refusals.rejectRequest(correlationId, 'invalid_request', {
                reason: 'invalid_resource_set'
            });
        }

        const target = this.targets.get(input.target);
        if (!target) {
            return this.refusals.rejectRequest(correlationId, 'target_unknown', { targetId: input.target });
        }
        const descriptor = target.describe();
        const maxAttachments = descriptor.maxAttachments ?? 1;
        if (!descriptor.supportsAttachments || requestedReferences.length > maxAttachments) {
            return this.refusals.rejectRequest(correlationId, 'invalid_request', {
                reason: 'attachment_count_out_of_range',
                requested: requestedReferences.length,
                limit: maxAttachments
            });
        }

        if (descriptor.dynamicRecipient) {
            if (!recipientInput || !isValidRecipientFormat(recipientInput)) {
                return this.refusals.rejectRequest(correlationId, 'recipient_required', { targetId: input.target });
            }
        } else if (recipientInput) {
            return this.refusals.rejectRequest(correlationId, 'recipient_not_allowed', { targetId: input.target });
        }

        const flooded = await this.guardAgainstFlood(correlationId, {
            kind: 'send_resource',
            resourceRefs: requestedReferences,
            purpose,
            targetId: descriptor.id,
            recipient: descriptor.dynamicRecipient ? recipientInput : undefined,
            subject: agentSubject,
            body: agentBody,
            // A note only reaches the message when the gateway composes the
            // body; with an agent-written body it is unused, so it must not
            // distinguish two otherwise identical requests either.
            note: agentBody === undefined ? hermesNote : undefined
        });
        if (flooded) {
            return flooded;
        }

        const resolvedSet = await this.resourceGate.resolveSet(correlationId, requestedReferences, purpose);
        if (!resolvedSet.ok) {
            return this.refusals.rejectRequest(correlationId, resolvedSet.code, resolvedSet.detail);
        }

        // Read originals sequentially after the set-wide metadata gate, bounded
        // by the configured total as they come in, then have each member
        // assessed on its own content — one gate, because both checks decide
        // whether these bytes may become part of a plan at all.
        // Which ceiling applies depends on whether this target may compress. If
        // it may, refusing here at the target's transport limit would make the
        // whole feature unreachable: the oversized sets that need the pipeline
        // would never survive long enough to be approved. The transport limit
        // is then checked after the pipeline instead, and by the target itself.
        const optimisation = this.config.attachmentOptimization;
        const bounds =
            descriptor.optimization && optimisation.enabled
                ? {
                      totalBytes: optimisation.limits.maxTotalInputBytes,
                      singleBytes: optimisation.limits.maxSingleInputBytes
                  }
                : { totalBytes: descriptor.maxAttachmentBytes };
        const prepared = await this.resourceGate.prepareAttachments(
            correlationId,
            resolvedSet.resources,
            purpose,
            descriptor,
            bounds
        );
        if (!prepared.ok) {
            if (prepared.kind === 'local_model_failure') {
                const failure = this.refusals.localModelFailure(prepared.error);
                await this.audit.record('hermes_response', {
                    correlationId,
                    detail: { tool: 'prepare_action', outcome: 'local_model_unavailable' }
                });
                return this.refusals.syntheticActionState('local_model_unavailable', failure.note);
            }
            return this.refusals.rejectRequest(correlationId, prepared.code, prepared.detail);
        }
        const { files, assessments } = prepared;

        const attachments: PlannedAttachment[] = files.map((file) => ({
            filename: file.filename,
            mimeType: file.mimeType,
            byteSize: file.bytes.byteLength,
            sha256: sha256Bytes(file.bytes)
        }));
        const safeLabels = resolvedSet.resources.map(
            ({ record }, index) => assessments[index]?.safeLabel ?? record.safeLabel
        );
        const plan: SendResourcePlan = buildSendPlan({
            descriptor,
            recipientInput,
            agentSubject,
            agentBody,
            hermesNote,
            purpose,
            safeLabels,
            attachments
        });

        const resourceBindings: ActionResourceBinding[] = resolvedSet.resources.map(
            ({ record, currentStateHash }, index) => ({
                resourceRef: record.ref,
                resourceStateHash: currentStateHash,
                judgement: assessments[index]!.judgement
            })
        );
        const firstBinding = resourceBindings[0]!;
        const bindingHash = computeBindingHash(
            resourceBindings.map(({ resourceRef, resourceStateHash }) => ({ resourceRef, resourceStateHash })),
            plan
        );
        const actionId = newActionId();
        const action = await this.persist(
            actionId,
            firstBinding.resourceRef,
            firstBinding.resourceStateHash,
            resourceBindings,
            purpose,
            plan,
            bindingHash,
            firstBinding.judgement
        );
        this.stage(actionId, files);
        this.log.info('Aktion vorbereitet, wartet auf lokale Freigabe', { actionId, targetId: descriptor.id });
        return this.respond(correlationId, 'prepare_action', action);
    }

    /**
     * Has the local model write a redacted summary of a referenced document,
     * and parks it for local approval. The shape of the answer is the point:
     * this call does not return a summary, it returns an action id and
     * `awaiting_local_approval` — a summary is a transfer, of text instead of
     * a file, and is subject to the same invariant 7 as a send.
     */
    async prepareSummary(input: SummarizeResourceInput): Promise<PublicActionState> {
        const correlationId = newQueryId();
        const purpose = clamp(input.purpose, MAX_PURPOSE_CHARS);
        const focus = emptyToUndefined(clamp(input.focus, MAX_FOCUS_CHARS));

        await this.audit.record('hermes_request', {
            correlationId,
            resourceRef: input.reference,
            detail: { tool: 'summarize_resource', purpose, focus: focus ?? null }
        });

        const flooded = await this.guardAgainstFlood(correlationId, {
            kind: 'summarize_resource',
            resourceRefs: [input.reference],
            purpose,
            focus
        });
        if (flooded) {
            return flooded;
        }

        const resolved = await this.resourceGate.resolveOne(correlationId, input.reference, purpose);
        if (!resolved.ok) {
            return this.refusals.rejectRequest(correlationId, resolved.code, resolved.detail);
        }
        const { record, currentStateHash } = resolved.resource;

        const drafted = await this.resourceGate.draftSummary(correlationId, resolved.resource, purpose, focus);
        if (!drafted.ok) {
            if (drafted.kind === 'local_model_failure') {
                const failure = this.refusals.localModelFailure(drafted.error);
                await this.audit.record('hermes_response', {
                    correlationId,
                    detail: { tool: 'summarize_resource', outcome: 'local_model_unavailable' }
                });
                return this.refusals.syntheticActionState('local_model_unavailable', failure.note);
            }
            return this.refusals.rejectRequest(correlationId, drafted.code, drafted.detail);
        }
        const { draft } = drafted;

        if (draft.summary.length === 0) {
            return this.refusals.rejectRequest(correlationId, 'summary_unusable', {
                resourceRef: record.ref,
                reason: 'empty_summary'
            });
        }
        // The guard normally runs on a finished public payload. It runs here as
        // well, before the text is stored, because a summary carrying a URL, a
        // path or a configured secret must not reach the approval view at all.
        try {
            this.guard.assertClean({ summary: draft.summary }, 'summarize_resource');
        } catch (error) {
            if (!(error instanceof EgressViolationError)) {
                throw error;
            }
            await this.audit.record('invariant_blocked', {
                correlationId,
                resourceRef: record.ref,
                detail: { invariant: 'no_raw_data', phase: 'summary_draft', error: describeError(error) }
            });
            return this.refusals.rejectRequest(correlationId, 'summary_unusable', {
                resourceRef: record.ref,
                reason: 'guard_violation'
            });
        }

        const plan: SummariseResourcePlan = buildSummaryPlan({
            summary: draft.summary,
            summarySha256: sha256Text(draft.summary),
            redactions: draft.redactions,
            model: draft.judgement.model,
            focus
        });

        const actionId = newActionId();
        const action = await this.persist(
            actionId,
            record.ref,
            currentStateHash,
            undefined,
            purpose,
            plan,
            computeBindingHash(record.ref, currentStateHash, plan),
            draft.judgement
        );
        this.log.info('Zusammenfassung vorbereitet, wartet auf lokale Freigabe', {
            actionId,
            chars: plan.summary.length
        });
        return this.respond(correlationId, 'summarize_resource', action);
    }

    /** Shared tail: assemble and persist the awaiting-approval record. */
    private async persist(
        actionId: string,
        resourceRef: string,
        resourceStateHashValue: string,
        resourceBindings: ActionResourceBinding[] | undefined,
        purpose: string,
        plan: ActionPlan,
        bindingHash: string,
        judgement: JudgementRecord
    ): Promise<ActionRecord> {
        const now = new Date();
        const action: ActionRecord = {
            actionId,
            resourceRef,
            resourceStateHash: resourceStateHashValue,
            resourceBindings,
            purpose,
            plan,
            bindingHash,
            judgement,
            status: 'awaiting_local_approval',
            statusReason: 'awaiting_user',
            createdAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + this.config.approval.actionTtlSeconds * 1000).toISOString()
        };
        await this.actions.create(action);
        // Counted here, where an action actually came into being. A refused
        // request costs the agent nothing against its rate.
        this.limiter.recordPrepared();
        return action;
    }

    /** Shared tail: the boundary payload for a newly prepared action, guarded and audited. */
    private async respond(correlationId: string, tool: string, action: ActionRecord): Promise<PublicActionState> {
        const payload = publicActionState(action);
        this.guard.assertClean(payload, tool);
        await this.audit.record('hermes_response', {
            correlationId,
            actionId: action.actionId,
            detail: { tool, status: payload.status }
        });
        return payload;
    }
}
