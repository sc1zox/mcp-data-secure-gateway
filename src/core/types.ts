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

export type ActionKind = 'send_resource';

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
 * Every field here is covered by the binding hash.
 */
export interface ActionPlan {
    kind: ActionKind;
    targetId: string;
    /** Redacted destination as shown locally, e.g. `c***@example.org`. */
    recipientDisplay: string;
    subject?: string;
    body: string;
    attachments: PlannedAttachment[];
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
    | 'delivered';

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
}

export interface SelectionCandidate {
    /** Index-based local handle; never egressed. */
    candidateId: string;
    resource: InternalResource;
}

/** A configured, fixed egress destination. */
export interface TargetDescriptor {
    /** Abstract name Hermes uses, e.g. `private_mail`. */
    id: string;
    /** Human label for the local UI. */
    label: string;
    /** What this target is for; Hermes may read this to pick sensibly. */
    purpose: string;
    /** Redacted destination for the approval view. */
    recipientDisplay: string;
    /** Whether the target can carry file attachments. */
    supportsAttachments: boolean;
    /** Upper bound on attachment size in bytes, if the transport imposes one. */
    maxAttachmentBytes?: number;
}
