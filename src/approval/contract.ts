/**
 * The wire format between the approval server and the local approval UI.
 *
 * This file is the single source of truth for that boundary, and it is
 * deliberately import-free. Two consumers compile against it from different
 * TypeScript projects — `server.ts` under `tsconfig.json` (Node types, ESM,
 * `src/` as root) and the Angular app under `ui/tsconfig.app.json` (DOM types,
 * a different root) — and a shared file can only serve both if it drags neither
 * project's module graph into the other.
 *
 * The point is drift detection. `server.ts` pins each response object against
 * the types below with `satisfies`, so renaming a field in the domain model
 * breaks the server build; the UI reads the same declarations, so a template
 * still referencing the old name breaks the UI build. Neither can silently
 * start rendering `undefined` into a dialog whose whole job is to state
 * precisely what is about to leave the machine.
 *
 * Everything here is local-only. None of these shapes is ever serialised
 * towards Hermes — that boundary has its own, much narrower types in
 * `core/egress.ts`.
 */

// -------------------------------------------------------------- shared unions

export type ApiActionStatus =
    | 'awaiting_local_approval'
    | 'selection_required'
    | 'executing'
    | 'completed'
    | 'rejected'
    | 'failed'
    | 'expired';

export type ApiActionStatusReason =
    | 'awaiting_user'
    | 'user_rejected'
    | 'user_discarded'
    | 'resource_changed'
    | 'resource_expired'
    | 'action_expired'
    | 'selection_pending'
    | 'target_unavailable'
    | 'source_unavailable'
    | 'local_model_unavailable'
    | 'delivery_failed'
    | 'delivered';

export type ApiSensitivity = 'low' | 'medium' | 'high';

/** Source-side classification, e.g. Paperless tags or correspondent. */
export type ApiAttributes = Record<string, string | string[]>;

// -------------------------------------------------------------------- actions

/** One file that would leave the machine, with the digest of the exact bytes. */
export interface ApiAttachment {
    filename: string;
    mimeType: string;
    byteSize: number;
    sha256: string;
}

/** Verdict of the local model, shown so the user can weigh it — not obey it. */
export interface ApiJudgement {
    model: string;
    /** 0..1. */
    confidence: number;
    reasoning: string;
    sensitivity: ApiSensitivity;
    uncertainties: string[];
    createdAt: string;
}

export interface ApiResourceSummary {
    /** Opaque reference; the only handle Hermes ever sees. */
    ref: string;
    /** Vetted, non-revealing label that was approved for egress. */
    safeLabel: string;
    /** Real title as it appears in the source. Local only. */
    title: string;
    sourceId: string;
    sourceLabel: string;
    nativeIdDisplay: string;
    mimeType?: string;
    byteSize?: number;
    createdAt?: string;
    modifiedAt?: string;
    attributes?: ApiAttributes;
    excerpt?: string;
    /**
     * Link into the source's own web interface, when one is configured. Local
     * only — this is the one location-shaped string in the whole payload, and it
     * exists so the user can look at the actual document before deciding.
     */
    webUrl?: string;
}

export interface ApiTargetSummary {
    id: string;
    label: string;
    /**
     * Masked for a fixed target; the full address for a dynamic-recipient one,
     * because there the whole point is that the user reads it before approving.
     */
    recipientDisplay: string;
    purpose: string;
    dynamicRecipient: boolean;
}

/** Exactly what leaves the machine if this action is approved. */
export interface ApiEgressPlan {
    subject?: string;
    body: string;
    attachments: ApiAttachment[];
    totalBytes: number;
    /**
     * Which parts the cloud agent wrote verbatim rather than the gateway. The UI
     * marks those, because "a machine notice the gateway composed" and "prose an
     * agent wrote that will go out unchanged" are two very different things to
     * be releasing, and they look identical otherwise.
     */
    authoredByAgent: { subject: boolean; body: boolean };
}

export interface ApiActionView {
    actionId: string;
    status: ApiActionStatus;
    /** Hash over the whole plan. Goes back with the approval to pin it. */
    bindingHash: string;
    purpose: string;
    createdAt: string;
    expiresAt: string;
    resource: ApiResourceSummary;
    target: ApiTargetSummary;
    egress: ApiEgressPlan;
    judgement: ApiJudgement;
    /** True when the staged bytes are gone (e.g. after a restart) and must be re-read. */
    needsRefetch: boolean;
}

// ----------------------------------------------------------------- selections

export interface ApiSelectionCandidate {
    candidateId: string;
    title: string;
    sourceId: string;
    sourceLabel: string;
    nativeId: string;
    type: string;
    createdAt?: string;
    modifiedAt?: string;
    mimeType?: string;
    attributes?: ApiAttributes;
    excerpt?: string;
    /** Link into the source's own web interface, when one is configured. */
    webUrl?: string;
    /**
     * True when a parked action already points at this candidate. Choosing it
     * confirms that action rather than replacing it.
     */
    isCurrent?: boolean;
}

export interface ApiSelectionView {
    selectionId: string;
    query: string;
    purpose: string;
    /** Why the local model refused to pick one candidate itself. */
    reasoning: string;
    createdAt: string;
    expiresAt: string;
    /**
     * The action parked on this selection, if the user opened it from an
     * approval. That action is on hold, not decided: confirming its current
     * resource brings it back, picking another discards it, cancelling restores
     * it unchanged.
     */
    originActionId?: string;
    candidates: ApiSelectionCandidate[];
}

// -------------------------------------------------------------------- history

/**
 * A past action as the history table shows it. This is the persisted record,
 * so it carries the plan rather than the assembled egress view.
 */
export interface ApiHistoryEntry {
    actionId: string;
    resourceRef: string;
    purpose: string;
    status: ApiActionStatus;
    statusReason?: ApiActionStatusReason;
    createdAt: string;
    expiresAt: string;
    decidedAt?: string;
    executedAt?: string;
    localOutcome?: string;
    plan: {
        targetId: string;
        recipientDisplay: string;
        dynamicRecipient: boolean;
        subject?: string;
        attachments: ApiAttachment[];
    };
    judgement: ApiJudgement;
}

// ---------------------------------------------------------------------- audit

export type ApiAuditEventType =
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
    | 'action_parked'
    | 'action_restored'
    | 'action_binding_mismatch'
    | 'egress_performed'
    | 'egress_failed'
    | 'action_expired'
    | 'reference_expired'
    | 'invariant_blocked';

export interface ApiAuditEvent {
    eventId: string;
    ts: string;
    type: ApiAuditEventType;
    correlationId?: string;
    resourceRef?: string;
    actionId?: string;
    selectionId?: string;
    sourceId?: string;
    targetId?: string;
    detail?: Record<string, unknown>;
}

// ------------------------------------------------------------------ responses

export interface ApiStateResponse {
    actions: ApiActionView[];
    selections: ApiSelectionView[];
    history: ApiHistoryEntry[];
    serverTime: string;
}

export interface ApiAuditResponse {
    events: ApiAuditEvent[];
}

export interface ApiOkResponse {
    ok: true;
}

/**
 * What a selection did to the action it was opened from. `none` covers both "no
 * action was parked on it" and "the parked action is gone", so the client never
 * has to distinguish those to phrase a message.
 */
export type ApiParkedActionOutcome =
    | { kind: 'none' }
    | { kind: 'restored'; actionId: string }
    | { kind: 'discarded'; actionId: string };

export interface ApiReselectResponse extends ApiOkResponse {
    selection_id: string;
}

export interface ApiSelectResponse extends ApiOkResponse {
    reference: string;
    action: ApiParkedActionOutcome;
}

export interface ApiCancelSelectionResponse extends ApiOkResponse {
    action: ApiParkedActionOutcome;
}

/** Every non-2xx response from `/api/*` carries this shape. */
export interface ApiErrorResponse {
    error: string;
    hint?: string;
}

// ------------------------------------------------------------------- requests

export interface ApiApproveRequest {
    action_id: string;
    /** The hash the UI displayed. The server refuses if it no longer matches. */
    binding_hash: string;
}

export interface ApiActionRequest {
    action_id: string;
}

export interface ApiSelectRequest {
    selection_id: string;
    candidate_id: string;
}

export interface ApiCancelSelectionRequest {
    selection_id: string;
}

// --------------------------------------------------------------------- routes

/**
 * Every path the client-side router can land on. The server serves the same
 * shell for all of them and the Angular router decides from there, so the two
 * lists must agree — a route added on one side only would 404 on reload.
 */
export const API_TAB_ROUTES = ['approvals', 'selections', 'history', 'audit'] as const;

export type ApiTabRoute = (typeof API_TAB_ROUTES)[number];
