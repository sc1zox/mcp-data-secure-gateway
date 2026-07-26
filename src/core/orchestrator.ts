import type { GatewayConfig } from '../config.js';
import { Judge } from '../judge/judge.js';
import { LocalModelResponseError, LocalModelUnavailableError } from '../judge/ollamaClient.js';
import type { AuditLog } from '../store/auditLog.js';
import { ActionStore } from '../store/actionStore.js';
import { ReferenceStore } from '../store/referenceStore.js';
import { SelectionStore } from '../store/selectionStore.js';
import { SourceUnavailableError, type PrivateSource, type SourceFile } from '../sources/source.js';
import { TargetDeliveryError, type EgressAttachment, type EgressTarget } from '../targets/target.js';
import { sha256Bytes, sha256Text, stableHash, safeEqual } from '../util/hash.js';
import { newActionId, newQueryId, newResourceRef, newSelectionId } from '../util/ids.js';
import { createLogger, describeError, type Logger } from '../util/log.js';
import {
    EgressGuard,
    note,
    publicActionState,
    publicResourceRef,
    publicTarget,
    sanitiseLabel,
    type PublicActionState,
    type PublicFindResult,
    type PublicTarget
} from './egress.js';
import { TERMINAL_ACTION_STATUSES } from './types.js';
import type {
    ActionPlan,
    ActionRecord,
    InternalResource,
    JudgementRecord,
    LocalResourceSummary,
    PlannedAttachment,
    ResourceRecord,
    SelectionCandidate,
    SelectionRequest,
    TargetDescriptor
} from './types.js';

/** Free text Hermes may contribute to a message body, hard-capped. */
const MAX_HERMES_NOTE_CHARS = 500;
const MAX_PURPOSE_CHARS = 500;
const MAX_QUERY_CHARS = 500;
/** An agent-supplied subject line. Single-line by construction, see `clamp`. */
const MAX_SUBJECT_CHARS = 200;
/** An agent-supplied message body. Generous, because this may be a real letter. */
const MAX_BODY_CHARS = 10000;

/** How long `awaitActionDecision` waits by default, and at most. */
const DEFAULT_DECISION_WAIT_SECONDS = 60;
const MAX_DECISION_WAIT_SECONDS = 600;

export interface FindResourceInput {
    query: string;
    purpose: string;
    /** Optional handle from an earlier `selection_required` answer. */
    pendingSelection?: string;
}

export interface PrepareActionInput {
    reference: string;
    target: string;
    purpose: string;
    /**
     * Optional short note from Hermes. Only used when `body` is absent — with an
     * agent-written body there is nothing for a separately attributed note to
     * be distinguished from.
     */
    note?: string;
    /**
     * Subject line written by Hermes. Optional; without it the gateway composes
     * one from the resource label.
     */
    subject?: string;
    /**
     * Message body written by Hermes, used verbatim. Optional; without it the
     * gateway composes the previous machine-notice body.
     *
     * Verbatim is the point: a message that has to read like ordinary post — an
     * application, a reply to a request — cannot carry a gateway footer. The
     * control is not that the gateway edits this text but that the user reads
     * all of it, marked as agent-written, before releasing it, and that the
     * binding hash covers it so it cannot change afterwards.
     */
    body?: string;
    /**
     * Concrete recipient address. Only accepted for a target whose descriptor
     * sets `dynamicRecipient: true`; required there, refused everywhere else.
     */
    recipient?: string;
}

/** Everything the local approval view needs. Never sent to Hermes. */
export interface LocalActionView {
    actionId: string;
    status: ActionRecord['status'];
    bindingHash: string;
    purpose: string;
    createdAt: string;
    expiresAt: string;
    /** `webUrl` links into the source's own interface; local UI only. */
    resource: LocalResourceSummary & { ref: string; safeLabel: string; webUrl?: string };
    target: { id: string; label: string; recipientDisplay: string; purpose: string; dynamicRecipient: boolean };
    egress: {
        subject?: string;
        body: string;
        attachments: PlannedAttachment[];
        totalBytes: number;
        /** Which of subject and body the cloud agent wrote rather than the gateway. */
        authoredByAgent: { subject: boolean; body: boolean };
    };
    judgement: JudgementRecord;
    /** True when the staged bytes are no longer in memory (e.g. after a restart). */
    needsRefetch: boolean;
}

export interface LocalSelectionView {
    selectionId: string;
    query: string;
    purpose: string;
    reasoning: string;
    createdAt: string;
    expiresAt: string;
    /** Set when a prepared action is parked on this selection. */
    originActionId?: string;
    candidates: Array<{
        candidateId: string;
        title: string;
        sourceId: string;
        sourceLabel: string;
        nativeId: string;
        type: string;
        createdAt?: string;
        modifiedAt?: string;
        mimeType?: string;
        attributes?: Record<string, string | string[]>;
        excerpt?: string;
        /** Deep link into the source's own interface, if it offers one. */
        webUrl?: string;
        /**
         * True when this is the resource the parked action already points at.
         * Choosing it confirms the action instead of replacing it.
         */
        isCurrent?: boolean;
    }>;
}

/** What resolving a selection did to the action it was opened from. */
export type SelectionOutcomeForAction =
    | { kind: 'none' }
    | { kind: 'restored'; actionId: string }
    | { kind: 'discarded'; actionId: string };

export class ApprovalConflictError extends Error {}
export class UnknownActionError extends Error {}

/**
 * The orchestrator needs only lookup from the registries. Depending on these
 * narrow views instead of the concrete classes keeps the core testable against
 * fake sources and targets without opening a registration hole in the real
 * registries, whose closed-set property is a security invariant.
 */
export interface SourceLookup {
    get(sourceId: string): PrivateSource | undefined;
    all(): PrivateSource[];
    available(): PrivateSource[];
}

export interface TargetLookup {
    get(targetId: string): EgressTarget | undefined;
    describeAll(): TargetDescriptor[];
}

/**
 * The gateway's decision core: it owns the flow from an abstract request by
 * Hermes, through the private sources and the local model, to a prepared action
 * that only a human can release.
 *
 * Nothing in this class returns internal data to a caller on the Hermes side. The
 * public methods return the `Public*` shapes from `egress.ts`; the `local*`
 * methods return full detail and are only reachable from the loopback approval
 * server.
 */
export class Orchestrator {
    private readonly log: Logger;
    /**
     * Original bytes fetched while preparing an action, held until the action
     * reaches a terminal state. Keeping them means the approval view can show the
     * exact size and digest of what would leave, and that approval does not race
     * a second download.
     */
    private readonly staged = new Map<string, SourceFile>();
    /**
     * Callers of `awaitActionDecision`, keyed by action. Woken by the store's
     * transition hook, so a waiting Hermes learns about a decision the moment it
     * is persisted instead of finding out on its next poll.
     */
    private readonly decisionWaiters = new Map<string, Set<() => void>>();

    constructor(
        private readonly config: GatewayConfig,
        private readonly sources: SourceLookup,
        private readonly targets: TargetLookup,
        private readonly judge: Judge,
        private readonly references: ReferenceStore,
        private readonly actions: ActionStore,
        private readonly selections: SelectionStore,
        private readonly audit: AuditLog,
        private readonly guard: EgressGuard,
        logger?: Logger
    ) {
        this.log = logger ?? createLogger('orchestrator');
        this.actions.onTransition((record) => this.wakeWaiters(record.actionId));
    }

    // ---------------------------------------------------------------- Hermes API

    /**
     * Resolves a natural-language description to a single opaque reference, or
     * reports that the user has to choose locally.
     */
    async findResource(input: FindResourceInput): Promise<PublicFindResult> {
        const correlationId = newQueryId();
        const query = clamp(input.query, MAX_QUERY_CHARS);
        const purpose = clamp(input.purpose, MAX_PURPOSE_CHARS);

        await this.audit.record('hermes_request', {
            correlationId,
            detail: {
                tool: 'find_resource',
                query,
                purpose,
                pendingSelection: input.pendingSelection ?? null
            }
        });

        if (input.pendingSelection) {
            return this.finish(correlationId, await this.resumeSelection(input.pendingSelection));
        }
        if (query.length === 0 || purpose.length === 0) {
            return this.finish(correlationId, { status: 'unavailable', note: note('invalid_request') });
        }

        // A resource the user picked by hand for this exact query and purpose wins
        // over a fresh model guess. This is the return path after "andere Ressource
        // wählen" in the approval view.
        const userChoice = this.selections.findResolvedFor(query, purpose);
        if (userChoice?.resolvedRef) {
            const chosen = this.references.resolve(userChoice.resolvedRef);
            if (chosen) {
                return this.finish(correlationId, {
                    status: 'resolved',
                    resource: publicResourceRef(chosen),
                    note: note('selection_resolved')
                });
            }
        }

        const availableSources = this.sources.available();
        if (availableSources.length === 0) {
            await this.audit.record('source_unavailable', {
                correlationId,
                detail: { reason: 'no_source_connected' }
            });
            return this.finish(correlationId, { status: 'unavailable', note: note('source_unavailable') });
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
            return this.finish(correlationId, { status: 'not_found', note: note('not_found') });
        }

        let outcome;
        try {
            outcome = await this.judge.selectResource(query, purpose, candidates, correlationId);
        } catch (error) {
            return this.finish(correlationId, this.localModelFailure(error));
        }

        if (outcome.kind === 'none') {
            return this.finish(correlationId, { status: 'not_found', note: note('not_found') });
        }
        if (outcome.kind === 'ambiguous') {
            const selection = await this.createSelection(query, purpose, candidates, outcome.judgement.reasoning);
            return this.finish(correlationId, {
                status: 'selection_required',
                selection_reference: selection.selectionId,
                note: note('selection_required')
            });
        }

        const record = await this.mintReference(outcome.resource, outcome.safeLabel, purpose, query);
        return this.finish(correlationId, {
            status: 'resolved',
            resource: publicResourceRef(record),
            note: note('resource_resolved')
        });
    }

    /** The abstract target names and what they are for. */
    listTargets(): PublicTarget[] {
        const payload = this.targets.describeAll().map(publicTarget);
        this.guard.assertClean(payload, 'list_targets');
        return payload;
    }

    /**
     * Binds a reference to a target and a purpose, producing an immutable action
     * that waits for local approval. Nothing is transferred here.
     */
    async prepareAction(input: PrepareActionInput): Promise<PublicActionState> {
        const correlationId = newQueryId();
        const purpose = clamp(input.purpose, MAX_PURPOSE_CHARS);
        const hermesNote = input.note ? clamp(input.note, MAX_HERMES_NOTE_CHARS) : undefined;
        // Subject through the single-line clamp: an outgoing mail header must not
        // be able to grow a second header from an embedded newline. The body keeps
        // its line breaks, because it is prose the user will read as prose.
        const agentSubject = emptyToUndefined(clamp(input.subject, MAX_SUBJECT_CHARS));
        const agentBody = emptyToUndefined(clampMultiline(input.body, MAX_BODY_CHARS));

        const recipientInput = input.recipient?.trim();
        await this.audit.record('hermes_request', {
            correlationId,
            resourceRef: input.reference,
            targetId: input.target,
            detail: {
                tool: 'prepare_action',
                purpose,
                hasNote: Boolean(hermesNote),
                agentSubject: agentSubject ?? null,
                agentBodyChars: agentBody?.length ?? 0,
                recipientRequested: recipientInput ?? null
            }
        });

        const target = this.targets.get(input.target);
        if (!target) {
            return this.rejectRequest(correlationId, 'target_unknown', { targetId: input.target });
        }
        const descriptor = target.describe();

        if (descriptor.dynamicRecipient) {
            if (!recipientInput || !isValidRecipientFormat(recipientInput)) {
                return this.rejectRequest(correlationId, 'recipient_required', { targetId: input.target });
            }
        } else if (recipientInput) {
            return this.rejectRequest(correlationId, 'recipient_not_allowed', { targetId: input.target });
        }

        const record = this.references.resolve(input.reference);
        if (!record) {
            const known = this.references.all().some((entry) => entry.ref === input.reference);
            return this.rejectRequest(
                correlationId,
                known ? 'reference_expired' : 'reference_unknown',
                { resourceRef: input.reference }
            );
        }
        if (!this.references.resolveForPurpose(input.reference, purpose)) {
            return this.rejectRequest(correlationId, 'purpose_mismatch', {
                resourceRef: input.reference,
                mintedFor: record.purpose,
                requestedFor: purpose
            });
        }

        const source = this.sources.get(record.locator.sourceId);
        if (!source || !source.isAvailable()) {
            return this.rejectRequest(correlationId, 'source_unavailable', {
                sourceId: record.locator.sourceId
            });
        }

        // The resource must still be in the state the reference was minted for.
        // Otherwise the user would approve a description of something that has
        // since changed.
        let current: InternalResource | undefined;
        try {
            current = await source.fetchMetadata(record.locator.nativeId);
        } catch (error) {
            await this.audit.record('source_unavailable', {
                correlationId,
                sourceId: source.id,
                detail: { error: describeError(error) }
            });
            return this.rejectRequest(correlationId, 'source_unavailable', { sourceId: source.id });
        }
        if (!current) {
            return this.rejectRequest(correlationId, 'reference_unknown', {
                resourceRef: input.reference,
                reason: 'resource_gone'
            });
        }
        const currentStateHash = resourceStateHash(current);
        if (!safeEqual(currentStateHash, record.stateHash)) {
            await this.audit.record('action_binding_mismatch', {
                correlationId,
                resourceRef: record.ref,
                detail: { expected: record.stateHash, actual: currentStateHash, phase: 'prepare' }
            });
            return this.rejectRequest(correlationId, 'resource_changed', { resourceRef: record.ref });
        }

        // Fetch the original now so the approval view can state the exact size and
        // digest of what would leave. This is a local read, not a transfer.
        let file: SourceFile;
        try {
            file = await source.fetchOriginal(record.locator.nativeId);
        } catch (error) {
            await this.audit.record('source_unavailable', {
                correlationId,
                sourceId: source.id,
                resourceRef: record.ref,
                detail: { error: describeError(error), phase: 'fetch_original' }
            });
            return this.rejectRequest(correlationId, 'source_unavailable', { sourceId: source.id });
        }

        const limit = descriptor.maxAttachmentBytes ?? Number.POSITIVE_INFINITY;
        if (file.bytes.byteLength > limit) {
            return this.rejectRequest(correlationId, 'attachment_too_large', {
                bytes: file.bytes.byteLength,
                limit
            });
        }

        let assessment;
        try {
            assessment = await this.judge.assessEgress(
                current,
                purpose,
                descriptor.label,
                descriptor.purpose,
                correlationId
            );
        } catch (error) {
            const failure = this.localModelFailure(error);
            await this.audit.record('hermes_response', {
                correlationId,
                detail: { tool: 'prepare_action', outcome: 'local_model_unavailable' }
            });
            return this.syntheticActionState('local_model_unavailable', failure.note);
        }

        const attachment: PlannedAttachment = {
            filename: file.filename,
            mimeType: file.mimeType,
            byteSize: file.bytes.byteLength,
            sha256: sha256Bytes(file.bytes)
        };
        const plan: ActionPlan = {
            kind: 'send_resource',
            targetId: descriptor.id,
            // Dynamic case: show the exact address that will be used, unmasked,
            // because approving it *is* approving that address.
            recipientDisplay: descriptor.dynamicRecipient ? recipientInput! : descriptor.recipientDisplay,
            dynamicRecipient: descriptor.dynamicRecipient,
            recipientAddress: descriptor.dynamicRecipient ? recipientInput : undefined,
            subject: agentSubject ?? buildSubject(record.safeLabel),
            body:
                agentBody ??
                buildBody({
                    safeLabel: assessment.safeLabel ?? record.safeLabel,
                    purpose,
                    hermesNote
                }),
            attachments: [attachment],
            authoredByAgent: { subject: agentSubject !== undefined, body: agentBody !== undefined }
        };

        const now = new Date();
        const actionId = newActionId();
        const action: ActionRecord = {
            actionId,
            resourceRef: record.ref,
            resourceStateHash: currentStateHash,
            purpose,
            plan,
            bindingHash: computeBindingHash(record.ref, currentStateHash, descriptor.id, plan),
            judgement: assessment.judgement,
            status: 'awaiting_local_approval',
            statusReason: 'awaiting_user',
            createdAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + this.config.approval.actionTtlSeconds * 1000).toISOString()
        };

        await this.actions.create(action);
        this.staged.set(actionId, file);
        this.log.info('Aktion vorbereitet, wartet auf lokale Freigabe', {
            actionId,
            targetId: descriptor.id
        });

        const payload = publicActionState(action);
        this.guard.assertClean(payload, 'prepare_action');
        await this.audit.record('hermes_response', {
            correlationId,
            actionId,
            detail: { tool: 'prepare_action', status: payload.status }
        });
        return payload;
    }

    /** Limited status of a prepared action. */
    getActionStatus(actionId: string): PublicActionState {
        const action = this.actions.get(actionId);
        if (!action) {
            return this.syntheticActionState('action_unknown', note('action_unknown'), actionId);
        }
        const payload = publicActionState(action);
        this.guard.assertClean(payload, 'get_action_status');
        return payload;
    }

    /**
     * Blocks until the action is decided and finished, or until the wait window
     * elapses — the answer to "how does Hermes learn that the user released
     * this?" without the gateway ever calling outwards.
     *
     * Waiting rather than webhooking is a deliberate choice about direction. A
     * callback would make the machine that holds the private documents open a
     * connection to the cloud on its own initiative, which is a new egress path
     * to secure, configure and reason about. Here the flow of causality stays
     * what it already is: Hermes asks, the gateway answers, and nothing leaves
     * this machine that a request did not come for.
     *
     * It resolves on a terminal status rather than on approval, because
     * `executing` lasts seconds and reporting it would only buy Hermes another
     * round trip to learn whether the send actually worked. A timeout is not a
     * failure: the current state comes back and the call can simply be repeated.
     */
    async awaitActionDecision(actionId: string, waitSeconds?: number): Promise<PublicActionState> {
        const timeoutMs = Math.min(
            Math.max(waitSeconds ?? DEFAULT_DECISION_WAIT_SECONDS, 1),
            MAX_DECISION_WAIT_SECONDS
        ) * 1000;
        const deadline = Date.now() + timeoutMs;

        for (;;) {
            const action = this.actions.get(actionId);
            if (!action) {
                return this.syntheticActionState('action_unknown', note('action_unknown'), actionId);
            }
            if (TERMINAL_ACTION_STATUSES.includes(action.status)) {
                return this.getActionStatus(actionId);
            }
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
                return this.getActionStatus(actionId);
            }
            // Woken by the store's transition hook; the timer is the backstop for
            // a status that changes without one, such as an expiry noticed by a
            // sweep that ran before this call started waiting.
            await this.waitForTransition(actionId, remaining);
        }
    }

    // ----------------------------------------------------------- local approval

    localPendingActions(): LocalActionView[] {
        return this.actions.pending().map((action) => this.toLocalActionView(action));
    }

    localAction(actionId: string): LocalActionView | undefined {
        const action = this.actions.get(actionId);
        return action ? this.toLocalActionView(action) : undefined;
    }

    localHistory(limit = 100): ActionRecord[] {
        return this.actions
            .all()
            .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
            .slice(0, limit);
    }

    localOpenSelections(): LocalSelectionView[] {
        return this.selections.open().map((request) => this.toLocalSelectionView(request));
    }

    /**
     * Releases an action.
     *
     * `expectedBindingHash` is the hash the UI displayed. Requiring it back is how
     * "an approval covers exactly the combination that was shown" becomes
     * enforceable: if the record changed between rendering and clicking, the
     * hashes differ and the approval is refused rather than applied to something
     * the user never saw.
     */
    async approveAction(actionId: string, expectedBindingHash: string): Promise<LocalActionView> {
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
        // Guards against a tampered store: the hash must still follow from the
        // fields it covers.
        const recomputed = computeBindingHash(
            action.resourceRef,
            action.resourceStateHash,
            action.plan.targetId,
            action.plan
        );
        if (!safeEqual(recomputed, action.bindingHash)) {
            await this.audit.record('invariant_blocked', {
                actionId,
                detail: { invariant: 'action_immutability', expected: recomputed, stored: action.bindingHash }
            });
            await this.actions.transition(actionId, 'failed', { reason: 'delivery_failed' });
            throw new ApprovalConflictError(
                'Die Aktion ist inkonsistent gespeichert und wurde nicht ausgeführt.'
            );
        }

        await this.audit.record('action_approved', {
            actionId,
            resourceRef: action.resourceRef,
            targetId: action.plan.targetId,
            detail: { bindingHash: action.bindingHash, purpose: action.purpose }
        });
        const executing = await this.actions.transition(actionId, 'executing', {
            decidedAt: new Date().toISOString()
        });
        // Deliberately not awaited: delivery can take seconds and the UI should
        // return immediately. Status is polled from the store afterwards.
        void this.execute(executing);
        return this.toLocalActionView(executing);
    }

    async rejectAction(actionId: string, discard = false): Promise<LocalActionView> {
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
        this.staged.delete(actionId);
        await this.audit.record(discard ? 'action_discarded' : 'action_rejected', {
            actionId,
            resourceRef: action.resourceRef,
            targetId: action.plan.targetId
        });
        return this.toLocalActionView(updated);
    }

    /**
     * Records the user's pick for an ambiguous search and mints the reference.
     * Hermes learns only that the selection resolved, via `find_resource` with the
     * selection handle.
     */
    async resolveSelection(
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
    async cancelSelection(selectionId: string): Promise<SelectionOutcomeForAction> {
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
     * The earlier version rejected it up front, which made opening the list an
     * irreversible act — a user who opened it to check, then confirmed the very
     * document the action already carried, found the action gone and Hermes
     * told it had been discarded. Nothing about looking is a decision, so
     * nothing about looking decides anything now: confirming the same resource
     * restores the action unchanged, picking a different one discards it (the
     * binding covers the resource, so a different resource genuinely needs a new
     * action), and cancelling the selection puts it back as it was.
     */
    async requestReselection(actionId: string): Promise<{ selectionId: string }> {
        const action = this.actions.get(actionId);
        if (!action) {
            throw new UnknownActionError(`Aktion ${actionId} ist unbekannt.`);
        }
        if (action.status !== 'awaiting_local_approval') {
            throw new ApprovalConflictError(
                `Aktion ${actionId} steht nicht zur Entscheidung (Status: ${action.status}).`
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
        await this.actions.transition(actionId, 'selection_required', { reason: 'selection_pending' });
        await this.audit.record('action_parked', {
            actionId,
            resourceRef: action.resourceRef,
            targetId: action.plan.targetId,
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
            await this.unpark(actionId, 'reselection_without_candidates');
            throw new ApprovalConflictError(
                'Die erneute Suche lieferte keine Kandidaten. Die Aktion wartet unverändert weiter auf eine Entscheidung.'
            );
        }
        const selection = await this.createSelection(
            query,
            action.purpose,
            candidates,
            'Der Nutzer hat eine andere Ressource verlangt und wählt lokal aus.',
            actionId
        );
        return { selectionId: selection.selectionId };
    }

    /** Periodic housekeeping: expires stale actions, selections and references. */
    async sweep(): Promise<void> {
        const expiredActions = await this.actions.expireStale();
        for (const action of this.actions.all()) {
            // A parked action keeps its bytes: it is still undecided, and dropping
            // them would mean a restored action needs a refetch it never earned.
            const stillOpen =
                action.status === 'awaiting_local_approval' || action.status === 'selection_required';
            if (!stillOpen && this.staged.has(action.actionId)) {
                this.staged.delete(action.actionId);
            }
        }
        const expiredSelections = await this.selections.expireStale();
        const prunedReferences = await this.references.pruneExpired();
        if (expiredActions + expiredSelections + prunedReferences > 0) {
            this.log.info('Aufräumen abgeschlossen', {
                expiredActions,
                expiredSelections,
                prunedReferences
            });
        }
    }

    // ------------------------------------------------------------------ internals

    /** Resolves on the next transition of this action, or after `timeoutMs`. */
    private waitForTransition(actionId: string, timeoutMs: number): Promise<void> {
        return new Promise<void>((resolveWait) => {
            let waiters = this.decisionWaiters.get(actionId);
            if (!waiters) {
                waiters = new Set();
                this.decisionWaiters.set(actionId, waiters);
            }
            const wake = (): void => {
                clearTimeout(timer);
                waiters!.delete(wake);
                if (waiters!.size === 0) {
                    this.decisionWaiters.delete(actionId);
                }
                resolveWait();
            };
            // Deliberately not unref'd: this timer is the only thing holding an
            // in-flight tool call open, and a call that is still owed an answer
            // is a reason for the process to stay up.
            const timer = setTimeout(wake, timeoutMs);
            waiters.add(wake);
        });
    }

    private wakeWaiters(actionId: string): void {
        const waiters = this.decisionWaiters.get(actionId);
        if (!waiters) {
            return;
        }
        for (const wake of [...waiters]) {
            wake();
        }
    }

    /**
     * Performs the approved transfer. Runs after the human decision and is the
     * only place in the gateway that hands bytes to a target.
     */
    private async execute(action: ActionRecord): Promise<void> {
        const target = this.targets.get(action.plan.targetId);
        if (!target) {
            await this.fail(action.actionId, 'target_unavailable', 'Ziel ist nicht mehr konfiguriert.');
            return;
        }

        let attachments: EgressAttachment[];
        try {
            attachments = await this.materialiseAttachments(action);
        } catch (error) {
            await this.fail(action.actionId, 'source_unavailable', describeError(error));
            return;
        }

        try {
            const receipt = await target.deliver({
                subject: action.plan.subject,
                body: action.plan.body,
                attachments,
                recipient: action.plan.recipientAddress
            });
            await this.actions.transition(action.actionId, 'completed', {
                reason: 'delivered',
                executedAt: new Date().toISOString(),
                localOutcome: receipt.reference
            });
            await this.audit.record('egress_performed', {
                actionId: action.actionId,
                resourceRef: action.resourceRef,
                targetId: action.plan.targetId,
                detail: {
                    recipientDisplay: action.plan.recipientDisplay,
                    subject: action.plan.subject,
                    bodySha256: sha256Text(action.plan.body),
                    bodyChars: action.plan.body.length,
                    attachments: action.plan.attachments,
                    deliveryReference: receipt.reference,
                    bindingHash: action.bindingHash
                }
            });
            this.log.info('Aktion ausgeführt', { actionId: action.actionId });
        } catch (error) {
            const reason = error instanceof TargetDeliveryError ? 'delivery_failed' : 'target_unavailable';
            await this.fail(action.actionId, reason, describeError(error));
        } finally {
            this.staged.delete(action.actionId);
        }
    }

    /**
     * Produces the bytes to send.
     *
     * Normally they are the ones staged at prepare time. After a restart the
     * staging map is empty, so the file is re-read and its digest compared against
     * the approved plan: if the document changed in the meantime the digests
     * differ and the transfer is abandoned rather than sending content the user
     * never approved.
     */
    private async materialiseAttachments(action: ActionRecord): Promise<EgressAttachment[]> {
        const planned = action.plan.attachments;
        const staged = this.staged.get(action.actionId);
        if (staged) {
            const digest = sha256Bytes(staged.bytes);
            const expected = planned[0]?.sha256;
            if (!expected || !safeEqual(digest, expected)) {
                throw new Error('Die bereitgestellten Daten weichen von der freigegebenen Aktion ab.');
            }
            return [{ filename: planned[0]!.filename, mimeType: planned[0]!.mimeType, bytes: staged.bytes }];
        }

        const record = this.references.resolve(action.resourceRef) ?? undefined;
        const locator = record?.locator;
        if (!locator) {
            throw new Error('Die Referenz der Aktion ist abgelaufen; erneute Vorbereitung nötig.');
        }
        const source = this.sources.get(locator.sourceId);
        if (!source || !source.isAvailable()) {
            throw new Error(`Quelle ${locator.sourceId} ist nicht verfügbar.`);
        }
        const file = await source.fetchOriginal(locator.nativeId);
        const digest = sha256Bytes(file.bytes);
        const expected = planned[0]?.sha256;
        if (!expected || !safeEqual(digest, expected)) {
            throw new Error(
                'Die Ressource hat sich seit der Freigabe geändert. Die Aktion wird nicht ausgeführt.'
            );
        }
        return [{ filename: planned[0]!.filename, mimeType: planned[0]!.mimeType, bytes: file.bytes }];
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
        this.staged.delete(actionId);
    }

    private async mintReference(
        resource: InternalResource,
        safeLabel: string,
        purpose: string,
        originQuery: string
    ): Promise<ResourceRecord> {
        const source = this.sources.get(resource.locator.sourceId);
        const now = new Date();
        const record: ResourceRecord = {
            ref: newResourceRef(),
            locator: resource.locator,
            safeLabel: sanitiseLabel(safeLabel),
            type: resource.type,
            stateHash: resourceStateHash(resource),
            stateToken: resource.stateToken,
            purpose,
            originQuery,
            createdAt: now.toISOString(),
            expiresAt: new Date(
                now.getTime() + this.config.approval.referenceTtlSeconds * 1000
            ).toISOString(),
            localSummary: {
                title: resource.title,
                sourceId: resource.locator.sourceId,
                sourceLabel: source?.label ?? resource.locator.sourceId,
                nativeIdDisplay: resource.locator.nativeId,
                mimeType: resource.mimeType,
                byteSize: resource.byteSize,
                createdAt: resource.createdAt,
                modifiedAt: resource.modifiedAt,
                attributes: resource.attributes,
                excerpt: resource.excerpt
            }
        };
        await this.references.mint(record);
        return record;
    }

    private async createSelection(
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
    private async settleParkedAction(
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
        this.staged.delete(actionId);
        await this.audit.record('action_discarded', {
            actionId,
            resourceRef: action.resourceRef,
            targetId: action.plan.targetId,
            selectionId: request.selectionId,
            detail: { reason: 'user_chose_other_resource' }
        });
        return { kind: 'discarded', actionId };
    }

    /** Returns a parked action to the approval queue. A no-op for anything else. */
    private async unpark(
        actionId: string | undefined,
        reason: string
    ): Promise<SelectionOutcomeForAction> {
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
            targetId: action.plan.targetId,
            detail: { reason }
        });
        return { kind: 'restored', actionId };
    }

    /** Answers a `find_resource` call that carries a selection handle. */
    private async resumeSelection(selectionId: string): Promise<PublicFindResult> {
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

    private localModelFailure(error: unknown): PublicFindResult {
        if (error instanceof LocalModelUnavailableError || error instanceof LocalModelResponseError) {
            // No cloud fallback, by design (invariant 10).
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

    private async rejectRequest(
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
    private syntheticActionState(
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

    private async finish(correlationId: string, result: PublicFindResult): Promise<PublicFindResult> {
        this.guard.assertClean(result, 'find_resource');
        await this.audit.record('hermes_response', {
            correlationId,
            detail: {
                tool: 'find_resource',
                status: result.status,
                reference: 'resource' in result ? result.resource.reference : undefined
            }
        });
        return result;
    }

    private toLocalActionView(action: ActionRecord): LocalActionView {
        const record = this.references.resolve(action.resourceRef);
        const descriptor: TargetDescriptor | undefined = this.targets.get(action.plan.targetId)?.describe();
        const summary: LocalResourceSummary =
            record?.localSummary ??
            ({
                title: '(Referenz abgelaufen)',
                sourceId: 'unbekannt',
                sourceLabel: 'unbekannt',
                nativeIdDisplay: '-'
            } satisfies LocalResourceSummary);

        return {
            actionId: action.actionId,
            status: action.status,
            bindingHash: action.bindingHash,
            purpose: action.purpose,
            createdAt: action.createdAt,
            expiresAt: action.expiresAt,
            resource: {
                ...summary,
                ref: action.resourceRef,
                safeLabel: record?.safeLabel ?? '(unbekannt)',
                // Resolved at view time rather than stored with the reference, so
                // configuring the source's web address later lights up the links
                // on actions that already exist.
                webUrl: record ? this.webUrlFor(record.locator.sourceId, record.locator.nativeId) : undefined
            },
            target: {
                id: action.plan.targetId,
                label: descriptor?.label ?? action.plan.targetId,
                recipientDisplay: action.plan.recipientDisplay,
                purpose: descriptor?.purpose ?? '-',
                dynamicRecipient: action.plan.dynamicRecipient
            },
            egress: {
                subject: action.plan.subject,
                body: action.plan.body,
                attachments: action.plan.attachments,
                totalBytes: action.plan.attachments.reduce((sum, item) => sum + item.byteSize, 0),
                // Older records predate the field; absent means the gateway wrote
                // both, which is what those actions in fact carry.
                authoredByAgent: action.plan.authoredByAgent ?? { subject: false, body: false }
            },
            judgement: action.judgement,
            needsRefetch: !this.staged.has(action.actionId)
        };
    }

    private toLocalSelectionView(request: SelectionRequest): LocalSelectionView {
        // Which candidate the parked action already points at, so the UI can say
        // "this is the current one" instead of making the user match ids by eye.
        const parked = request.originActionId ? this.actions.get(request.originActionId) : undefined;
        const current =
            parked?.status === 'selection_required'
                ? this.references.resolve(parked.resourceRef)?.locator
                : undefined;

        return {
            selectionId: request.selectionId,
            query: request.query,
            purpose: request.purpose,
            reasoning: request.reasoning,
            createdAt: request.createdAt,
            expiresAt: request.expiresAt,
            originActionId: parked?.status === 'selection_required' ? parked.actionId : undefined,
            candidates: request.candidates.map((candidate) => ({
                candidateId: candidate.candidateId,
                title: candidate.resource.title,
                sourceId: candidate.resource.locator.sourceId,
                sourceLabel: this.sources.get(candidate.resource.locator.sourceId)?.label ?? candidate.resource.locator.sourceId,
                nativeId: candidate.resource.locator.nativeId,
                type: candidate.resource.type,
                createdAt: candidate.resource.createdAt,
                modifiedAt: candidate.resource.modifiedAt,
                mimeType: candidate.resource.mimeType,
                attributes: candidate.resource.attributes,
                excerpt: candidate.resource.excerpt,
                webUrl: this.webUrlFor(
                    candidate.resource.locator.sourceId,
                    candidate.resource.locator.nativeId
                ),
                isCurrent:
                    current !== undefined &&
                    current.sourceId === candidate.resource.locator.sourceId &&
                    current.nativeId === candidate.resource.locator.nativeId
            }))
        };
    }

    /** Deep link into a source's own interface, when that source offers one. */
    private webUrlFor(sourceId: string, nativeId: string): string | undefined {
        const source = this.sources.get(sourceId);
        return source?.webUrl?.(nativeId);
    }
}

const SYNTHETIC_REASONS: Partial<Record<Parameters<typeof note>[0], ActionRecord['statusReason']>> = {
    resource_changed: 'resource_changed',
    reference_expired: 'resource_expired',
    source_unavailable: 'source_unavailable',
    local_model_unavailable: 'local_model_unavailable',
    target_unavailable: 'target_unavailable',
    target_unknown: 'target_unavailable'
};

/**
 * Identity of a resource *in a particular state*. Covering the state token means
 * an edited document yields a different hash, which invalidates references and
 * approvals that were made against the old content.
 */
export function resourceStateHash(resource: InternalResource): string {
    return stableHash({
        sourceId: resource.locator.sourceId,
        nativeId: resource.locator.nativeId,
        stateToken: resource.stateToken,
        title: resource.title,
        byteSize: resource.byteSize ?? null,
        mimeType: resource.mimeType ?? null
    });
}

/** Pins an approval to one exact resource state, target and payload. */
export function computeBindingHash(
    resourceRef: string,
    resourceStateHashValue: string,
    targetId: string,
    plan: ActionPlan
): string {
    return stableHash({ resourceRef, resourceStateHash: resourceStateHashValue, targetId, plan });
}

function buildSubject(safeLabel: string): string {
    return `Local Trust Gateway: ${safeLabel}`;
}

/**
 * Message body, composed locally from the purpose and the label. A note from
 * Hermes is included but explicitly attributed, so the user reading the approval
 * view can tell which words came from the cloud agent.
 */
function buildBody(input: { safeLabel: string; purpose: string; hermesNote?: string }): string {
    const lines = [
        `Ressource: ${input.safeLabel}`,
        `Zweck: ${input.purpose}`,
        `Vorbereitet: ${new Date().toISOString()}`,
        '',
        'Diese Nachricht wurde nach lokaler Freigabe durch das Local Trust Gateway versandt.'
    ];
    if (input.hermesNote) {
        lines.push('', 'Hinweis des Agenten (nicht lokal verifiziert):', input.hermesNote);
    }
    return lines.join('\n');
}

/** RFC 5321's own upper bound on a mailbox address. */
const MAX_RECIPIENT_CHARS = 320;

/**
 * Coarse shape check on a Hermes-supplied recipient, applied before an action
 * can even be created. `MailTarget.deliver` repeats an equivalent check
 * independently right before sending, so a bug or a tampered store here
 * cannot turn into a send to a malformed address either.
 */
function isValidRecipientFormat(value: string): boolean {
    return value.length <= MAX_RECIPIENT_CHARS && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function clamp(value: string | undefined, limit: number): string {
    if (typeof value !== 'string') {
        return '';
    }
    const normalised = value.replace(/\s+/g, ' ').trim();
    return normalised.length <= limit ? normalised : normalised.slice(0, limit);
}

/**
 * Clamp for text that is meant to be read as prose: line breaks survive,
 * everything else that could carry structure does not.
 *
 * Control characters are dropped rather than escaped. In a mail body they are
 * invisible, so text containing them would render to the user in the approval
 * view as something subtly different from what the transport later sends — and
 * this view's whole purpose is that the two are the same thing.
 */
function clampMultiline(value: string | undefined, limit: number): string {
    if (typeof value !== 'string') {
        return '';
    }
    const normalised = value
        .replace(/\r\n?/g, '\n')
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
        .replace(/[ \t]+$/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return normalised.length <= limit ? normalised : `${normalised.slice(0, limit - 1).trimEnd()}…`;
}

function emptyToUndefined(value: string): string | undefined {
    return value.length > 0 ? value : undefined;
}
