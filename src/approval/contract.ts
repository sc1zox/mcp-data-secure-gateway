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

/**
 * What an action would do. `send_resource` hands the original document to a
 * configured target; `summarize_resource` hands a locally redacted text back to
 * the cloud agent and the document stays here.
 */
export type ApiActionKind = 'send_resource' | 'summarize_resource';

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
    | 'delivered'
    | 'summary_released';

export type ApiSensitivity = 'low' | 'medium' | 'high';

/** Source-side classification, e.g. Paperless tags or correspondent. */
export type ApiAttributes = Record<string, string | string[]>;

// -------------------------------------------------------------------- actions

/**
 * One file that would leave the machine.
 *
 * Named, typed and measured — no digest. The gateway still pins the exact bytes
 * by their SHA-256 internally and refuses to send anything else, but a hex
 * string is not something a person can check, and a screen that asks for a
 * decision should carry only what the decision actually rests on.
 */
export interface ApiAttachment {
    filename: string;
    mimeType: string;
    byteSize: number;
}

/**
 * What the local model had in front of it when it judged.
 *
 * Shown next to the verdict because the two are read together or not at all: a
 * paragraph about a document and a paragraph about a document's title are
 * written in the same confident German, and only this says which one is on
 * screen.
 */
export interface ApiJudgementBasis {
    /** `fulltext` the document's text, `excerpt` a short sample, `none` metadata only. */
    kind: 'fulltext' | 'excerpt' | 'none';
    /** Characters of document text the model saw. */
    textChars: number;
    /** Whether the model confirmed the content matches title and purpose. */
    contentChecked: boolean;
}

/** Verdict of the local model, shown so the user can weigh it — not obey it. */
export interface ApiJudgement {
    model: string;
    /** 0..1. */
    confidence: number;
    reasoning: string;
    sensitivity: ApiSensitivity;
    uncertainties: string[];
    /** Absent on actions prepared before the gateway recorded this. */
    basis?: ApiJudgementBasis;
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
    /**
     * True when this exact address has never been approved for this target
     * before — the one approval where reading the address *is* the decision
     * rather than a formality. The UI marks it and asks for a second,
     * separately worded confirmation.
     */
    firstTimeRecipient: boolean;
}

/**
 * What the gateway may do to the attachments between this approval and the
 * transport, when the target is configured to shrink oversized ones.
 *
 * Shown because the sizes next to it describe the *originals*, and a reader who
 * is not told otherwise will take them for what arrives. The approval does bind
 * this policy — it is part of the frozen plan — but it does not bind the
 * resulting bytes, and that difference is only honest if it is on screen.
 */
export interface ApiTransformPolicy {
    /** Version of the profile catalogue this approval is bound to. */
    policyVersion: string;
    /** The strongest rung permitted. Never exceeded during execution. */
    maxProfile: 'structural' | 'balanced' | 'compact';
    /** Media types that may be transformed at all, e.g. `application/pdf`. */
    formats: string[];
}

/** Exactly what leaves the machine if this action is approved. */
export interface ApiEgressPlan {
    subject?: string;
    body: string;
    /** The originals. The sizes below are theirs. */
    attachments: ApiAttachment[];
    totalBytes: number;
    /**
     * Absent for every target that transforms nothing — which is the default,
     * and which means the bytes listed above are exactly the bytes sent.
     */
    optimization?: ApiTransformPolicy;
    /**
     * Which parts the cloud agent wrote verbatim rather than the gateway. The UI
     * marks those, because "a machine notice the gateway composed" and "prose an
     * agent wrote that will go out unchanged" are two very different things to
     * be releasing, and they look identical otherwise.
     */
    authoredByAgent: { subject: boolean; body: boolean };
}

/** Everything both kinds of pending action have in common. */
export interface ApiActionViewBase {
    actionId: string;
    status: ApiActionStatus;
    purpose: string;
    createdAt: string;
    expiresAt: string;
    resource: ApiResourceSummary;
    judgement: ApiJudgement;
    /**
     * Every resource covered by the approval, in attachment order. `resource`
     * and `judgement` above remain the first member for local API compatibility.
     */
    resources: Array<ApiResourceSummary & { judgement: ApiJudgement }>;
}

/** A document on its way to a configured target. */
export interface ApiSendActionView extends ApiActionViewBase {
    kind: 'send_resource';
    target: ApiTargetSummary;
    egress: ApiEgressPlan;
}

/** One category of detail the local model claims to have removed. */
export type ApiRedactionPlaceholder =
    | 'REDACTED_NAME'
    | 'REDACTED_ORG'
    | 'REDACTED_ADDRESS'
    | 'REDACTED_CONTACT'
    | 'REDACTED_DATE'
    | 'REDACTED_AMOUNT'
    | 'REDACTED_ID'
    | 'REDACTED_HEALTH'
    | 'REDACTED_CREDENTIAL'
    | 'REDACTED_OTHER';

/**
 * Something in the summary that still looks like it should have been removed.
 *
 * Produced by a pattern scan the gateway runs over the finished text — a second
 * opinion about the local model's work, not a filter it had to pass. It exists
 * to be shown, so the person deciding gets pointed at the two lines worth
 * re-reading instead of being asked to proofread a paragraph unaided.
 */
export interface ApiResidualFinding {
    kind: string;
    sample: string;
}

/** The exact text that would be handed to the cloud agent. */
export interface ApiSummaryPlan {
    text: string;
    chars: number;
    redactions: ApiRedactionPlaceholder[];
    residuals: ApiResidualFinding[];
    /** The local model that wrote it. */
    model: string;
    /** What the agent said it was looking for, if anything. */
    focus?: string;
}

/** A redacted summary waiting to be released to the cloud agent. */
export interface ApiSummaryActionView extends ApiActionViewBase {
    kind: 'summarize_resource';
    summary: ApiSummaryPlan;
}

export type ApiActionView = ApiSendActionView | ApiSummaryActionView;

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
    resourceRefs: string[];
    purpose: string;
    status: ApiActionStatus;
    statusReason?: ApiActionStatusReason;
    createdAt: string;
    expiresAt: string;
    decidedAt?: string;
    executedAt?: string;
    localOutcome?: string;
    /**
     * The plan, narrowed to what a table row needs. Neither branch carries the
     * payload: a mail body and a summary text both belong in the approval view
     * and the audit trail, not in a list of everything that ever happened.
     */
    plan:
        | {
              kind: 'send_resource';
              targetId: string;
              recipientDisplay: string;
              dynamicRecipient: boolean;
              subject?: string;
              attachments: ApiAttachment[];
          }
        | {
              kind: 'summarize_resource';
              summaryChars: number;
              redactions: ApiRedactionPlaceholder[];
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
    | 'resource_state_mismatch'
    | 'egress_performed'
    | 'egress_failed'
    | 'action_expired'
    | 'reference_expired'
    | 'invariant_blocked'
    | 'telegram_notified'
    | 'telegram_delivery_failed'
    | 'telegram_callback_rejected';

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

/**
 * What the user confirms: one action, named by its id.
 *
 * There is no digest to echo back. An action is immutable once prepared —
 * changing a recipient, a subject, a body or an attachment produces a new
 * action and discards the old one — so an id identifies exactly one snapshot
 * for its whole life. A stale screen can therefore only ever name an action
 * that has since been decided or expired, and the server refuses those on their
 * status alone.
 */
export interface ApiApproveRequest {
    action_id: string;
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

// ------------------------------------------------------------ telegram approval

/**
 * Secret-free view of the Telegram approval channel. Never carries the bot
 * token — only whether one is stored — and shows chat id and allowed user id
 * masked, the same way a target's recipient is masked elsewhere in this file.
 */
export interface ApiTelegramApprovalStatus {
    enabled: boolean;
    /** True once bot token, chat id and allowed user id are all stored. */
    configured: boolean;
    botTokenSet: boolean;
    chatIdMasked?: string;
    allowedUserIdMasked?: string;
    /** Whether the long-polling loop is currently running. */
    polling: boolean;
    /** Short, secret-free description of the last polling or delivery failure, if any. */
    lastError?: string;
}

/**
 * What the settings page may change. An empty or absent `botToken` means
 * "keep the currently stored secret" — the only way to read one back out is
 * to never send it in the first place.
 */
export interface ApiTelegramApprovalUpdateRequest {
    enabled: boolean;
    botToken?: string;
    chatId?: string;
    allowedUserId?: string;
}

export interface ApiTelegramApprovalTestResponse extends ApiOkResponse {
    reachable: boolean;
    detail?: string;
}

// --------------------------------------------------------------------- routes

/**
 * Every path the client-side router can land on. The server serves the same
 * shell for all of them and the Angular router decides from there, so the two
 * lists must agree — a route added on one side only would 404 on reload.
 */
export const API_TAB_ROUTES = ['approvals', 'selections', 'history', 'audit', 'telegram-approval'] as const;

export type ApiTabRoute = (typeof API_TAB_ROUTES)[number];
