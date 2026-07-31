/**
 * The vocabulary of the attachment optimization pipeline.
 *
 * Two things are deliberately separated here and must stay separated. An
 * *original* is what the user approved: its digest is in the plan and is
 * re-checked before anything touches it. A *delivered* attachment is what the
 * transport actually receives, which may be a smaller derivative of an original
 * produced under the approved `ApprovedTransformPolicy`. Every type below names
 * which of the two it is about, because a function that blurs them is a function
 * that can send bytes nobody bounded.
 */
import type { ApprovedTransformPolicy, TransformProfile } from '../core/types.js';

export const PDF_MIME = 'application/pdf';
export const JPEG_MIME = 'image/jpeg';

/** One approved original, on its way into the pipeline. */
export interface OptimizationInput {
    filename: string;
    mimeType: string;
    bytes: Uint8Array;
    /** Digest of `bytes`, already verified against the plan by the caller. */
    sha256: string;
}

/**
 * Ceilings on what the gateway is willing to do to itself while optimizing.
 *
 * These are about protecting the local process — memory, disk, CPU, wall clock
 * — and are entirely separate from the target's `maxAttachmentBytes`, which is
 * about what the destination will accept. A 30 MiB scan is well within these
 * and still far over a 14 MiB mail budget; that gap is exactly the case this
 * whole pipeline exists for.
 */
export interface OptimizationLimits {
    /** Largest single original the pipeline will accept. */
    maxSingleInputBytes: number;
    /** Largest total set of originals the pipeline will accept. */
    maxTotalInputBytes: number;
    /** Ceiling on originals plus every candidate held at once. */
    maxWorkingBytes: number;
    /** Wall clock for the whole run, across every file and every profile. */
    timeBudgetMs: number;
}

/**
 * Why a run produced nothing sendable.
 *
 * Internal on purpose. None of these reaches Hermes: the public vocabulary for
 * a failed execution is `ActionStatusReason`, and every one of these maps to
 * `delivery_failed` there. They exist so the audit trail and the local outcome
 * can say which of five quite different things went wrong, which
 * `delivery_failed` alone cannot.
 */
export type OptimizationFailureReason =
    /** An original exceeded `maxSingleInputBytes` or the set exceeded `maxTotalInputBytes`. */
    | 'attachment_input_too_large'
    /** Every allowed profile ran and the set is still over the target budget. */
    | 'attachment_budget_not_reached'
    /** A required local tool (qpdf, Ghostscript, Sharp) is missing or unusable. */
    | 'attachment_optimizer_unavailable'
    /** A tool ran but produced nothing valid, and the budget needed it. */
    | 'attachment_optimization_failed'
    /** `timeBudgetMs` elapsed with the budget not yet reached. */
    | 'attachment_optimization_timeout';

/**
 * What actually left the machine, per file.
 *
 * Recorded after the transformation rather than before it, so `outputSha256` is
 * the digest of the real bytes the target received and not of something that
 * was planned. For an untouched file the two digests are equal and
 * `wasOptimized` is false — the story requires that to be visible rather than
 * inferred.
 */
export interface AttachmentAuditRecord {
    originalFilename: string;
    originalMimeType: string;
    originalBytes: number;
    originalSha256: string;
    outputBytes: number;
    outputSha256: string;
    wasOptimized: boolean;
    /** Which adapter produced the output, e.g. `qpdf`. Absent when untouched. */
    optimizer?: string;
    /** Which rung was used. Absent when untouched. */
    profile?: TransformProfile;
    /** Version string of the tool that produced it, for reproducibility. */
    toolVersion?: string;
    /** Time spent producing this file's accepted output. Zero when untouched. */
    durationMs: number;
}

/** An original or its accepted derivative, with the record of which it is. */
export interface DeliveredAttachment {
    filename: string;
    mimeType: string;
    bytes: Uint8Array;
    audit: AttachmentAuditRecord;
}

export type OptimizationOutcome =
    | {
          ok: true;
          attachments: DeliveredAttachment[];
          /** False on the no-op path, where no optimizer was invoked at all. */
          optimised: boolean;
      }
    | { ok: false; reason: OptimizationFailureReason; detail: string };

/** Whether a format's tools are usable, and what to record about them. */
export interface ToolAvailability {
    available: boolean;
    /** e.g. `qpdf 11.9.0, gs 10.07.1`. Shown in the audit and at boot. */
    version: string;
    /** Content-free explanation when unavailable. */
    detail?: string;
}

/**
 * Format facts taken from the original before any transformation, and compared
 * against afterwards. A PDF derivative that lost a page is not a smaller
 * version of the document, it is a different document.
 */
export type FormatSignature = Record<string, number | string>;

export interface PreflightVerdict {
    /** False for encrypted, signed, interactive or unreadable files (AK-4). */
    transformable: boolean;
    /** Short, content-free reason when not transformable. For the audit. */
    reason?: string;
    signature?: FormatSignature;
}

/** A validated derivative, ready for the pipeline's size arithmetic. */
export interface Candidate {
    bytes: Uint8Array;
    profile: TransformProfile;
    optimizer: string;
    toolVersion: string;
    durationMs: number;
}

/** Workspace and deadline shared by everything in one pipeline run. */
export interface OptimizationContext {
    /** Absolute time (ms since epoch) the whole run must be finished by. */
    deadlineAt: number;
    /** Private temporary directory for this run. Removed by the caller. */
    workspaceDir: string;
}

/**
 * A format adapter.
 *
 * The pipeline knows only this shape — never a Ghostscript flag, a qpdf
 * subcommand or a Sharp option. That boundary is what lets the pipeline's
 * ordering and budget logic be tested with doubles on a machine where neither
 * qpdf nor Ghostscript is installed, which the story's Definition of Done
 * requires.
 *
 * `produce` returns a candidate only if that candidate is *format-valid*: it
 * re-opened, it is still the right format, and it still matches the original's
 * signature. Whether a valid candidate is also useful — smaller than what we
 * hold, and helpful towards the budget — is the pipeline's decision, not the
 * adapter's.
 */
export interface FormatOptimizer {
    readonly mimeType: string;
    /** Name recorded in the audit, e.g. `qpdf`, `ghostscript`, `sharp`. */
    readonly optimizer: string;
    /** The rungs this adapter offers, weakest first. */
    readonly profiles: readonly TransformProfile[];
    /** Probed once and cached; a missing tool is a clean unavailability. */
    available(): Promise<ToolAvailability>;
    preflight(input: OptimizationInput, ctx: OptimizationContext): Promise<PreflightVerdict>;
    /**
     * Produces one candidate at exactly `profile`, always from `input.bytes`.
     * Never from a previously accepted candidate — that is what stops the
     * `Original → balanced → compact` double-encoding the story forbids.
     * Returns undefined when the tool produced nothing valid.
     */
    produce(
        input: OptimizationInput,
        profile: TransformProfile,
        signature: FormatSignature | undefined,
        ctx: OptimizationContext
    ): Promise<Candidate | undefined>;
}

/** Thrown by an adapter when the whole run's wall clock has run out. */
export class OptimizationTimeoutError extends Error {}

/** Thrown by an adapter when its tools are not installed or not usable. */
export class OptimizerUnavailableError extends Error {}

export type { ApprovedTransformPolicy, TransformProfile };
