/**
 * Domain model of the Local Trust Gateway.
 *
 * The naming convention marks the trust boundary:
 *
 *  - `Internal*` types may contain native ids, paths, URLs, credentials-adjacent
 *    data and raw content. They must never be serialised towards Hermes.
 *  - `Public*` types are the only shapes that cross the boundary. They are built
 *    exclusively in `core/egress.ts`.
 */

export type ResourceType = 'document' | 'calendar_event' | 'contact' | 'other';

/** Points at a real resource inside a real private source. Local only. */
export interface InternalLocator {
    /** Id of the registered source, e.g. `paperless`. */
    sourceId: string;
    /** Native identifier inside that source, e.g. a Paperless document id. */
    nativeId: string;
    /**
     * Additional source-specific addressing (DAV href, collection, revision).
     * Opaque to the gateway core, never leaves the machine.
     */
    nativeExtra?: Record<string, unknown>;
}

/**
 * A resource as the source described it, before any abstraction. Held in memory
 * during a search and, for the selected candidate, persisted in the reference
 * store. `excerpt` and `fullText` exist purely so the local model can judge.
 */
export interface InternalResource {
    locator: InternalLocator;
    /** Human title as it appears in the source. Shown locally and, once vetted, to Hermes as a label. */
    title: string;
    type: ResourceType;
    createdAt?: string;
    modifiedAt?: string;
    mimeType?: string;
    byteSize?: number;
    /** Source-side classification, e.g. Paperless tags / correspondent / document type. */
    attributes?: Record<string, string | string[]>;
    /** Short local-only text sample used for semantic judgement. */
    excerpt?: string;
    /**
     * Version marker from the source (modified timestamp, etag, checksum).
     * Part of the resource state: if it changes, an existing approval dies.
     */
    stateToken: string;
}

/** A stored, referencable resource. The mapping ref -> locator lives only here. */
export interface ResourceRecord {
    /** Opaque reference, the only handle Hermes ever sees. */
    ref: string;
    locator: InternalLocator;
    /** Vetted, non-revealing label approved for egress by the local model. */
    safeLabel: string;
    type: ResourceType;
    /** Hash over the resource state at reference time. */
    stateHash: string;
    stateToken: string;
    /** Purpose the reference was minted for. Reusing it for another purpose is refused. */
    purpose: string;
    /** The search text this reference came from, so the user can re-pick locally. */
    originQuery: string;
    createdAt: string;
    expiresAt: string;
    /** Local-only snapshot of the descriptive fields, for the approval view. */
    localSummary: LocalResourceSummary;
}

/** Full local detail about a referenced resource, for the approval UI only. */
export interface LocalResourceSummary {
    title: string;
    sourceId: string;
    sourceLabel: string;
    nativeIdDisplay: string;
    mimeType?: string;
    byteSize?: number;
    createdAt?: string;
    modifiedAt?: string;
    attributes?: Record<string, string | string[]>;
    excerpt?: string;
}

/**
 * What an action does if the user releases it.
 *
 * `send_resource` hands the original document to a configured target.
 * `summarize_resource` hands a locally written, redacted text back to the cloud
 * agent — the document itself stays here.
 */
export type ActionKind = 'send_resource' | 'summarize_resource';

export type ActionStatus =
    | 'awaiting_local_approval'
    | 'selection_required'
    | 'executing'
    | 'completed'
    | 'rejected'
    | 'failed'
    | 'expired';

/** Terminal states never transition again. */
export const TERMINAL_ACTION_STATUSES: readonly ActionStatus[] = [
    'completed',
    'rejected',
    'failed',
    'expired'
];

/** One file that would leave the machine as part of an action. */
export interface PlannedAttachment {
    filename: string;
    mimeType: string;
    byteSize: number;
    /** Digest of the exact bytes that were planned. Re-checked before sending. */
    sha256: string;
}

/**
 * The frozen plan: precisely what leaves the machine if the user approves.
 * Every field here is covered by the binding hash — including `recipientAddress`,
 * so an approval binds to one exact address and cannot be replayed against another.
 */
export interface SendResourcePlan {
    kind: 'send_resource';
    targetId: string;
    /**
     * Destination as shown locally. Masked (e.g. `c***@example.org`) for a
     * fixed target; the full, unmasked address for a dynamic-recipient target,
     * because the point there is that the user reads the exact address before
     * approving.
     */
    recipientDisplay: string;
    /** Whether this action's target let the request name the recipient. */
    dynamicRecipient: boolean;
    /** The literal address to deliver to. Only set when `dynamicRecipient` is true. */
    recipientAddress?: string;
    subject?: string;
    body: string;
    attachments: PlannedAttachment[];
    /**
     * Which parts of the message the cloud agent wrote rather than the gateway.
     *
     * `prepare_action` may supply a subject and a body verbatim — that is the
     * point when the outgoing message is meant to read like ordinary post and
     * not like a machine notice. Recording the provenance per field is what lets
     * the approval view say so, and because it sits inside the plan it is
     * covered by the binding hash: the text cannot be swapped for agent-written
     * text after the user read it as locally composed.
     */
    authoredByAgent: { subject: boolean; body: boolean };
}

/**
 * The closed set of placeholders a redacted summary may contain.
 *
 * Closed on purpose. A free-form placeholder vocabulary would let the local
 * model write `[Max Mustermann, geb. 1980]` and call it redaction; with a fixed
 * list the gateway can check afterwards that nothing else in square brackets
 * survived, and the approval view can name exactly which categories of detail
 * the model claims to have removed.
 */
export const REDACTION_PLACEHOLDERS = [
    'REDACTED_NAME',
    'REDACTED_ORG',
    'REDACTED_ADDRESS',
    'REDACTED_CONTACT',
    'REDACTED_DATE',
    'REDACTED_AMOUNT',
    'REDACTED_ID',
    'REDACTED_HEALTH',
    'REDACTED_CREDENTIAL',
    'REDACTED_OTHER'
] as const;

export type RedactionPlaceholder = (typeof REDACTION_PLACEHOLDERS)[number];

/**
 * The frozen plan of a summary: the exact characters that would be handed to the
 * cloud agent, and nothing else.
 *
 * There is no target and no recipient here, and that is a property rather than an
 * omission — a summarising action cannot be talked into reaching an SMTP target,
 * because the shape it carries has nowhere to put one. The single route out is
 * `get_summary`, and that route only opens on a status the user's approval sets.
 */
export interface SummariseResourcePlan {
    kind: 'summarize_resource';
    /** The redacted text, verbatim. Exactly this leaves, or nothing does. */
    summary: string;
    /** Digest of `summary`, re-checked before handing it over. */
    summarySha256: string;
    /** Which placeholder categories the summary actually contains. */
    redactions: RedactionPlaceholder[];
    /** Model that wrote it, so the approval view can name the author. */
    model: string;
    /** What the agent said it needed the summary for; part of the prompt. */
    focus?: string;
}

export type ActionPlan = SendResourcePlan | SummariseResourcePlan;

/**
 * The configured target an action delivers to, if it delivers to one at all.
 * A summarising action answers the requester instead, so it has no target — the
 * audit trail records that as an absence rather than as a placeholder name.
 */
export function targetIdOf(plan: ActionPlan): string | undefined {
    return plan.kind === 'send_resource' ? plan.targetId : undefined;
}

/**
 * What the local model actually had in front of it when it judged.
 *
 * A verdict about a document and a verdict about a document's title look
 * identical once written down — both come back as fluent German with a
 * confidence next to it. This records which one it was, so the approval view can
 * say so and the user can weigh the sentence accordingly.
 */
export interface JudgementBasis {
    /**
     * `fulltext` — the document's extracted text, as far as the source gave it.
     * `excerpt` — only the short sample a search returns.
     * `none` — metadata alone; the model never saw a character of the document.
     */
    kind: 'fulltext' | 'excerpt' | 'none';
    /** Characters of document text the model saw. Zero for `none`. */
    textChars: number;
    /**
     * Whether the model states it read the content and found it consistent with
     * the title, the characteristics and the purpose.
     *
     * Forced to false when there was no text: a claim to have checked something
     * unreadable is not a check, and the gateway records what happened rather
     * than what the model said happened.
     */
    contentChecked: boolean;
}

/** Verdict of the local model, recorded with the action for later review. */
export interface JudgementRecord {
    /** Model identifier that produced the verdict, e.g. `qwen3.5:9b`. */
    model: string;
    /** 0..1 confidence that the chosen resource matches intent and purpose. */
    confidence: number;
    /** Plain-language reason, in German, shown in the approval view. */
    reasoning: string;
    /** Whether the model considers the content sensitive beyond the stated purpose. */
    sensitivity: 'low' | 'medium' | 'high';
    /** Open points the user should decide on. Non-empty means "do not rush". */
    uncertainties: string[];
    /**
     * What the verdict rests on. Optional because actions stored before this
     * existed have no answer, and inventing one for them would defeat the point.
     */
    basis?: JudgementBasis;
    createdAt: string;
}

export interface ActionRecord {
    actionId: string;
    resourceRef: string;
    /** Copied from the reference at prepare time; an approval is void if it drifts. */
    resourceStateHash: string;
    purpose: string;
    plan: ActionPlan;
    /** Hash over (resourceRef, resourceStateHash, targetId, plan). Pins the approval. */
    bindingHash: string;
    judgement: JudgementRecord;
    status: ActionStatus;
    /** Machine-readable reason for the current status, safe for egress. */
    statusReason?: ActionStatusReason;
    createdAt: string;
    expiresAt: string;
    decidedAt?: string;
    executedAt?: string;
    /** Short local note about the outcome, e.g. delivery id. Not egressed verbatim. */
    localOutcome?: string;
}

/**
 * Closed set of reasons Hermes may learn. Deliberately coarse: it explains the
 * workflow without describing the content or the user's motives.
 */
export type ActionStatusReason =
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
    /** A summary the user released; it may now be collected with `get_summary`. */
    | 'summary_released';

/** A search that the local model could not resolve to a single resource. */
export interface SelectionRequest {
    selectionId: string;
    query: string;
    purpose: string;
    /** Candidates in local detail; the user picks one in the local UI. */
    candidates: SelectionCandidate[];
    /** Why the model refused to decide. */
    reasoning: string;
    createdAt: string;
    expiresAt: string;
    status: 'open' | 'resolved' | 'cancelled' | 'expired';
    /** Reference minted once the user picked. */
    resolvedRef?: string;
    /**
     * The action this selection was opened from, if any.
     *
     * Set when the user asked for a different resource from the approval view.
     * That action is then parked in `selection_required` rather than thrown
     * away, so confirming the resource it already pointed at brings it back
     * instead of forcing Hermes to prepare the whole thing again.
     */
    originActionId?: string;
}

export interface SelectionCandidate {
    /** Index-based local handle; never egressed. */
    candidateId: string;
    resource: InternalResource;
}

/** A configured egress destination — fixed, or dynamic within its own scope. */
export interface TargetDescriptor {
    /** Abstract name Hermes uses, e.g. `private_mail`. */
    id: string;
    /** Human label for the local UI. */
    label: string;
    /** What this target is for; Hermes may read this to pick sensibly. */
    purpose: string;
    /**
     * Redacted destination for the approval view, or a placeholder note when
     * the target is dynamic-recipient (there is nothing fixed to redact).
     */
    recipientDisplay: string;
    /**
     * True only for the small, explicit set of targets configured with
     * `allowDynamicRecipient`. Tells Hermes it must (and may) supply a
     * `recipient` in `prepare_action`; every other target rejects one.
     */
    dynamicRecipient: boolean;
    /** Whether the target can carry file attachments. */
    supportsAttachments: boolean;
    /** Upper bound on attachment size in bytes, if the transport imposes one. */
    maxAttachmentBytes?: number;
}
