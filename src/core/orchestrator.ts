import type { GatewayConfig } from '../config.js';
import { Judge } from '../judge/judge.js';
import type { AuditLog } from '../store/auditLog.js';
import { ActionStore } from '../store/actionStore.js';
import { ReferenceStore } from '../store/referenceStore.js';
import { SelectionStore } from '../store/selectionStore.js';
import type { PrivateSource } from '../sources/source.js';
import type { EgressTarget } from '../targets/target.js';
import { sha256Text, safeEqual } from '../util/hash.js';
import { newActionId, newQueryId, newResourceRef } from '../util/ids.js';
import { createLogger, describeError, type Logger } from '../util/log.js';
import {
    EgressGuard,
    note,
    publicActionState,
    publicResourceRef,
    publicSummary,
    publicTarget,
    sanitiseLabel,
    type PublicActionState,
    type PublicFindResult,
    type PublicSummary,
    type PublicTarget
} from './egress.js';
import { TERMINAL_ACTION_STATUSES } from './types.js';
import type { ActionRecord, InternalResource, ResourceRecord, TargetDescriptor } from './types.js';
import {
    DEFAULT_DECISION_WAIT_SECONDS,
    MAX_DECISION_WAIT_SECONDS,
    MAX_PURPOSE_CHARS,
    MAX_QUERY_CHARS
} from './limits.js';
import { computeBindingHash, resourceStateHash } from './binding.js';
import { clamp, type FindResourceInput, type PrepareActionInput, type SummarizeResourceInput } from './agentInput.js';
import { RefusalFactory } from './refusals.js';
import { DecisionWaiters } from './decisionWaiters.js';
import { ResourceGate } from './resourceGate.js';
import { createOptimizationService } from '../attachments/factory.js';
import { ActionExecutor, ApprovalConflictError, UnknownActionError } from './actionExecutor.js';
import { ActionPreparer } from './actionPreparation.js';
import { SelectionFlow } from './selectionFlow.js';
import { LocalViewBuilder, type LocalActionView, type LocalSelectionView } from './localViews.js';

export type { FindResourceInput, PrepareActionInput, SummarizeResourceInput } from './agentInput.js';
export { computeBindingHash, resourceStateHash } from './binding.js';
export { ApprovalConflictError, UnknownActionError } from './actionExecutor.js';
export type {
    LocalActionView,
    LocalSelectionView,
    LocalSendActionView,
    LocalSummaryActionView,
    SelectionOutcomeForAction
} from './localViews.js';

import type { SelectionOutcomeForAction } from './localViews.js';

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
 * The gateway's decision core. Its public methods return `Public*` boundary
 * shapes; its `local*` methods are reachable only from the loopback approval
 * server.
 *
 * The class is a coordinator: every security-relevant responsibility it used
 * to carry directly now lives in a dedicated collaborator built in the
 * constructor — `binding.ts` (invariant 12), `resourceGate.ts` (invariants
 * 4+12), `refusals.ts` (invariant 13), `actionExecutor.ts` (invariants 7+12),
 * `selectionFlow.ts` (invariant 9), `localViews.ts` (the local/Hermes split).
 * What stays here is state ownership, request validation and the sequencing
 * between those collaborators.
 */
export class Orchestrator {
    private readonly log: Logger;
    /**
     * Callers of `awaitActionDecision`, keyed by action. Woken by the store's
     * transition hook, so a waiting Hermes learns about a decision the moment it
     * is persisted instead of finding out on its next poll.
     */
    private readonly decisionWaiters = new DecisionWaiters();
    private readonly refusals: RefusalFactory;
    private readonly resourceGate: ResourceGate;
    private readonly actionExecutor: ActionExecutor;
    private readonly actionPreparer: ActionPreparer;
    private readonly selectionFlow: SelectionFlow;
    private readonly localViews: LocalViewBuilder;

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
        this.refusals = new RefusalFactory(this.audit, this.guard, this.log);
        this.resourceGate = new ResourceGate(this.references, this.sources, this.audit, this.judge, this.log);
        this.actionExecutor = new ActionExecutor(
            this.actions,
            this.targets,
            this.resourceGate,
            this.audit,
            this.log,
            createOptimizationService(this.config.attachmentOptimization)
        );
        this.actionPreparer = new ActionPreparer(
            this.config,
            this.targets,
            this.actions,
            this.guard,
            this.audit,
            this.log,
            this.resourceGate,
            this.refusals,
            (actionId, files) => this.actionExecutor.stage(actionId, files)
        );
        this.selectionFlow = new SelectionFlow(
            this.config,
            this.selections,
            this.references,
            this.actions,
            this.audit,
            this.sources,
            this.judge,
            (error) => this.refusals.localModelFailure(error),
            (actionId) => this.actionExecutor.discard(actionId),
            (resource, safeLabel, purpose, originQuery) =>
                this.mintReference(resource, safeLabel, purpose, originQuery),
            this.log
        );
        this.localViews = new LocalViewBuilder(
            this.references,
            this.sources,
            this.targets,
            (actionId) => this.actionExecutor.isStaged(actionId),
            (actionId) => this.actions.get(actionId)
        );
        this.actions.onTransition((record) => this.decisionWaiters.wake(record.actionId));
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
            return this.finish(correlationId, await this.selectionFlow.resumeSelection(input.pendingSelection));
        }
        if (query.length === 0 || purpose.length === 0) {
            return this.finish(correlationId, { status: 'unavailable', note: note('invalid_request') });
        }

        return this.finish(correlationId, await this.selectionFlow.resolveQuery(correlationId, query, purpose));
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
        return this.actionPreparer.prepareSend(input);
    }

    /**
     * Has the local model write a redacted summary of a referenced document, and
     * parks it for local approval.
     *
     * The shape of the answer is the point: this call does not return a summary.
     * It returns an action id and `awaiting_local_approval`, exactly like
     * preparing a transfer does, because a summary is a transfer — of a small
     * amount of text instead of a file, to the agent instead of to a mailbox,
     * and therefore subject to the same rule that nothing crosses the boundary
     * without a person having read it first (invariant 7).
     */
    async summarizeResource(input: SummarizeResourceInput): Promise<PublicActionState> {
        return this.actionPreparer.prepareSummary(input);
    }


    /**
     * Hands over a summary the user released.
     *
     * This is the only way a summary leaves the machine, and it is a read of
     * something already decided rather than a decision of its own: the text
     * comes out when — and only when — the action reached `completed`, which
     * `approveAction` is the sole path to. Any other status answers with the
     * status and no text.
     */
    async getSummary(actionId: string): Promise<PublicSummary> {
        const action = this.actions.get(actionId);
        if (!action) {
            const unknown: PublicSummary = {
                action_id: actionId,
                status: 'failed',
                note: note('action_unknown')
            };
            this.guard.assertClean(unknown, 'get_summary');
            return unknown;
        }
        if (action.plan.kind !== 'summarize_resource') {
            // A transfer has no text to collect, and saying so must not describe
            // what that transfer was about.
            const wrongKind: PublicSummary = {
                action_id: actionId,
                status: action.status,
                note: note('summary_not_released')
            };
            this.guard.assertClean(wrongKind, 'get_summary');
            return wrongKind;
        }

        const payload = publicSummary(action);
        // The digest is re-checked at the boundary for the same reason the
        // attachment digest is: the approved thing and the sent thing have to be
        // the same thing, even if the store was edited in between.
        if (payload.summary !== undefined && !safeEqual(sha256Text(payload.summary), action.plan.summarySha256)) {
            await this.audit.record('invariant_blocked', {
                actionId,
                detail: { invariant: 'action_immutability', phase: 'get_summary' }
            });
            const mismatch: PublicSummary = {
                action_id: actionId,
                status: 'failed',
                note: note('summary_not_released')
            };
            this.guard.assertClean(mismatch, 'get_summary');
            return mismatch;
        }

        this.guard.assertClean(payload, 'get_summary');
        await this.audit.record('hermes_response', {
            correlationId: actionId,
            actionId,
            detail: {
                tool: 'get_summary',
                status: payload.status,
                released: payload.summary !== undefined,
                summarySha256: payload.summary !== undefined ? action.plan.summarySha256 : undefined
            }
        });
        return payload;
    }

    /** Limited status of a prepared action. */
    getActionStatus(actionId: string): PublicActionState {
        const action = this.actions.get(actionId);
        if (!action) {
            return this.refusals.syntheticActionState('action_unknown', note('action_unknown'), actionId);
        }
        const payload = publicActionState(action);
        this.guard.assertClean(payload, 'get_action_status');
        return payload;
    }

    /**
     * Blocks until the action is decided and finished, or until the wait window
     * elapses — the answer to "how does Hermes learn that the user released
     * this?" without the gateway ever calling outwards. Resolves on a terminal
     * status rather than on approval, because `executing` lasts seconds and
     * reporting it would only buy Hermes another round trip. A timeout is not a
     * failure: the current state comes back and the call can simply be repeated.
     */
    async awaitActionDecision(actionId: string, waitSeconds?: number): Promise<PublicActionState> {
        const timeoutMs =
            Math.min(Math.max(waitSeconds ?? DEFAULT_DECISION_WAIT_SECONDS, 1), MAX_DECISION_WAIT_SECONDS) * 1000;
        const deadline = Date.now() + timeoutMs;

        for (;;) {
            const action = this.actions.get(actionId);
            if (!action) {
                return this.refusals.syntheticActionState('action_unknown', note('action_unknown'), actionId);
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
            await this.decisionWaiters.wait(actionId, remaining);
        }
    }

    // ----------------------------------------------------------- local approval

    localPendingActions(): LocalActionView[] {
        return this.actions.pending().map((action) => this.localViews.toLocalActionView(action));
    }

    localAction(actionId: string): LocalActionView | undefined {
        const action = this.actions.get(actionId);
        return action ? this.localViews.toLocalActionView(action) : undefined;
    }

    localHistory(limit = 100): ActionRecord[] {
        return this.actions
            .all()
            .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
            .slice(0, limit);
    }

    localOpenSelections(): LocalSelectionView[] {
        return this.selections.open().map((request) => this.localViews.toLocalSelectionView(request));
    }

    /**
     * Notifies whenever an action becomes `awaiting_local_approval` — freshly
     * prepared, or returning from a parked selection. Local-only: this exists
     * for the optional Telegram approval channel to send a notification
     * without polling `localPendingActions()`, and it never touches anything
     * that reaches Hermes.
     */
    onActionAwaitingApproval(listener: (view: LocalActionView) => void): () => void {
        const notifyIfAwaiting = (record: ActionRecord): void => {
            if (record.status === 'awaiting_local_approval') {
                listener(this.localViews.toLocalActionView(record));
            }
        };
        const offCreate = this.actions.onCreate(notifyIfAwaiting);
        const offTransition = this.actions.onTransition(notifyIfAwaiting);
        return () => {
            offCreate();
            offTransition();
        };
    }

    /** Releases an action. Validation and the binding-hash re-check live in `actionExecutor.ts` (invariant 12). */
    async approveAction(actionId: string, expectedBindingHash: string): Promise<LocalActionView> {
        const executing = await this.actionExecutor.approve(actionId, expectedBindingHash);
        return this.localViews.toLocalActionView(executing);
    }

    async rejectAction(actionId: string, discard = false): Promise<LocalActionView> {
        const updated = await this.actionExecutor.reject(actionId, discard);
        return this.localViews.toLocalActionView(updated);
    }

    /**
     * Records the user's pick for an ambiguous search. Hermes learns only that
     * the selection resolved, via `find_resource` with the selection handle.
     */
    async resolveSelection(
        selectionId: string,
        candidateId: string
    ): Promise<{ ref: string; action: SelectionOutcomeForAction }> {
        return this.selectionFlow.resolve(selectionId, candidateId);
    }

    /**
     * Ends a selection without a pick. An action parked on it goes back to
     * waiting for approval — cancelling the question is not answering it.
     */
    async cancelSelection(selectionId: string): Promise<SelectionOutcomeForAction> {
        return this.selectionFlow.cancel(selectionId);
    }

    /** "Andere Ressource wählen" from the approval view; see `selectionFlow.ts` for the parking behaviour. */
    async requestReselection(actionId: string): Promise<{ selectionId: string }> {
        const action = this.actions.get(actionId);
        if (!action) {
            throw new UnknownActionError(`Aktion ${actionId} ist unbekannt.`);
        }
        return this.selectionFlow.reselect(action);
    }

    /** Periodic housekeeping: expires stale actions, selections and references. */
    async sweep(): Promise<void> {
        const expiredActions = await this.actions.expireStale();
        for (const action of this.actions.all()) {
            // A parked action keeps its bytes: it is still undecided, and dropping
            // them would mean a restored action needs a refetch it never earned.
            const stillOpen =
                action.status === 'awaiting_local_approval' || action.status === 'selection_required';
            if (!stillOpen && this.actionExecutor.hasStaged(action.actionId)) {
                this.actionExecutor.discard(action.actionId);
            }
        }
        const expiredSelections = await this.selections.expireStale();
        const prunedReferences = await this.references.pruneExpired();
        if (expiredActions + expiredSelections + prunedReferences > 0) {
            this.log.info('Aufräumen abgeschlossen', { expiredActions, expiredSelections, prunedReferences });
        }
    }

    // ------------------------------------------------------------------ internals

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
            expiresAt: new Date(now.getTime() + this.config.approval.referenceTtlSeconds * 1000).toISOString(),
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
}
