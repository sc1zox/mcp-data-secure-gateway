/**
 * Bringing an approved set of originals under a target's size budget.
 *
 * Runs after the user's decision and before the transport, and owns exactly one
 * question: which of the allowed transformations, applied to which files, in
 * which order, is enough. It knows nothing about qpdf flags or Sharp options —
 * those live behind `FormatOptimizer` — and nothing about SMTP or Telegram,
 * which supply only a number of bytes.
 *
 * Three properties are worth stating because the code is arranged around them
 * rather than checking for them afterwards:
 *
 *  - **Fail-closed.** Every path that does not reach the budget returns a
 *    failure. There is no branch that returns the originals because optimizing
 *    them did not work; an oversized original never travels.
 *  - **No cascading loss.** Every candidate is produced from `input.bytes`, the
 *    original, never from a derivative already accepted. `compact` after
 *    `balanced` would otherwise be a second lossy encode of an already lossy
 *    image, which looks far worse than one `compact` pass for no extra saving.
 *  - **Stop at sufficient.** The moment the running total fits, the run ends.
 *    A file that never needed to be touched is never touched (AK-13, AK-8).
 */
import { sha256Bytes } from '../util/hash.js';
import { profileRank, type ApprovedTransformPolicy, type TransformProfile } from '../core/types.js';
import { withWorkspace } from './processRunner.js';
import {
    JPEG_MIME,
    PDF_MIME,
    OptimizationTimeoutError,
    OptimizerUnavailableError,
    type AttachmentAuditRecord,
    type DeliveredAttachment,
    type FormatOptimizer,
    type FormatSignature,
    type OptimizationContext,
    type OptimizationInput,
    type OptimizationLimits,
    type OptimizationOutcome
} from './types.js';

/**
 * The fixed order of work, weakest and cheapest first.
 *
 * Lossless PDF restructuring before any image is touched; then the JPEG rung
 * that is barely visible; only then Ghostscript on PDFs, which is the expensive
 * and lossy one. `compact` rungs come last and only if the policy allows them.
 * The story calls this the MVP recommendation and requires it to be versioned
 * and deterministic — changing this array changes which files get degraded, so
 * it belongs next to `POLICY_VERSION` in spirit even though it is not a number.
 */
export const STAGES: ReadonlyArray<{ mimeType: string; profile: TransformProfile }> = [
    { mimeType: PDF_MIME, profile: 'structural' },
    { mimeType: JPEG_MIME, profile: 'balanced' },
    { mimeType: PDF_MIME, profile: 'balanced' },
    { mimeType: JPEG_MIME, profile: 'compact' },
    { mimeType: PDF_MIME, profile: 'compact' }
];

/** Per-file state carried through the run. */
interface Slot {
    /** Position in the approved attachment order. Ties break on this. */
    index: number;
    input: OptimizationInput;
    /** Bytes currently intended for delivery: the original, or the best derivative. */
    current: Uint8Array;
    /** Set once a derivative was accepted. */
    accepted?: { profile: TransformProfile; optimizer: string; toolVersion: string; durationMs: number };
    /** Result of the format preflight; undefined for unsupported formats. */
    transformable: boolean;
    signature?: FormatSignature;
}

export class AttachmentOptimizationPipeline {
    private readonly byFormat = new Map<string, FormatOptimizer>();

    constructor(optimizers: FormatOptimizer[]) {
        for (const optimizer of optimizers) {
            this.byFormat.set(optimizer.mimeType, optimizer);
        }
    }

    /**
     * Reports which tools are usable, for the boot log. Purely informational —
     * a missing tool is not a startup failure, it is a per-action refusal later,
     * because the gateway is perfectly useful for everything that fits already.
     */
    async probe(): Promise<Array<{ mimeType: string; optimizer: string; available: boolean; version: string; detail?: string }>> {
        const report = [];
        for (const optimizer of this.byFormat.values()) {
            const availability = await optimizer.available();
            report.push({
                mimeType: optimizer.mimeType,
                optimizer: optimizer.optimizer,
                available: availability.available,
                version: availability.version,
                detail: availability.detail
            });
        }
        return report;
    }

    async run(
        inputs: OptimizationInput[],
        budgetBytes: number,
        policy: ApprovedTransformPolicy,
        limits: OptimizationLimits
    ): Promise<OptimizationOutcome> {
        const originalsTotal = inputs.reduce((sum, item) => sum + item.bytes.byteLength, 0);

        // SourceGuard. About protecting this process, not about the target:
        // refusing to load 900 MiB of scans into memory is a different decision
        // from refusing to mail 20 MiB of them.
        const oversized = inputs.find((item) => item.bytes.byteLength > limits.maxSingleInputBytes);
        if (oversized) {
            return {
                ok: false,
                reason: 'attachment_input_too_large',
                detail: `Eine Datei überschreitet mit ${oversized.bytes.byteLength} Bytes das Einzellimit von ${limits.maxSingleInputBytes} Bytes.`
            };
        }
        if (originalsTotal > limits.maxTotalInputBytes) {
            return {
                ok: false,
                reason: 'attachment_input_too_large',
                detail: `Die Anhänge überschreiten mit ${originalsTotal} Bytes das Verarbeitungslimit von ${limits.maxTotalInputBytes} Bytes.`
            };
        }

        // BudgetEvaluator. The no-op path: AK-1 requires that nothing is called
        // and nothing changes, so this returns before a workspace even exists.
        if (originalsTotal <= budgetBytes) {
            return { ok: true, optimised: false, attachments: inputs.map(untouched) };
        }

        return withWorkspace((workspaceDir) =>
            this.optimise(inputs, budgetBytes, policy, limits, {
                deadlineAt: Date.now() + limits.timeBudgetMs,
                workspaceDir
            })
        );
    }

    private async optimise(
        inputs: OptimizationInput[],
        budgetBytes: number,
        policy: ApprovedTransformPolicy,
        limits: OptimizationLimits,
        ctx: OptimizationContext
    ): Promise<OptimizationOutcome> {
        const slots: Slot[] = inputs.map((input, index) => ({
            index,
            input,
            current: input.bytes,
            transformable: false
        }));
        const originalsTotal = inputs.reduce((sum, item) => sum + item.bytes.byteLength, 0);
        let heldTotal = 0;
        // Set when a stage could have helped but its tools are missing. Kept
        // apart from an ordinary shortfall so the audit can say "install qpdf"
        // rather than "the documents are too big".
        let blockedByMissingTool: string | undefined;
        // Same idea for the other reason a candidate never gets produced: the
        // gateway refusing to hold that much at once. "Raise maxWorkingBytes"
        // and "these documents cannot be made smaller" call for opposite
        // responses, so they must not arrive as the same message.
        let blockedByWorkingSet = false;

        const stages = STAGES.filter(
            (stage) =>
                policy.formats.includes(stage.mimeType) &&
                profileRank(stage.profile) <= profileRank(policy.maxProfile) &&
                this.byFormat.has(stage.mimeType)
        );

        const total = (): number => slots.reduce((sum, slot) => sum + slot.current.byteLength, 0);

        // FormatPreflight, once per file. Encrypted, signed and interactive PDFs
        // are settled here and never enter a stage (AK-4).
        for (const slot of slots) {
            const optimizer = this.byFormat.get(slot.input.mimeType);
            if (!optimizer || !policy.formats.includes(slot.input.mimeType)) {
                continue;
            }
            try {
                const verdict = await optimizer.preflight(slot.input, ctx);
                slot.transformable = verdict.transformable;
                slot.signature = verdict.signature;
            } catch (error) {
                if (error instanceof OptimizationTimeoutError) {
                    return timeout();
                }
                if (error instanceof OptimizerUnavailableError) {
                    blockedByMissingTool = optimizer.optimizer;
                    continue;
                }
                // An unreadable file is not a crash; it is a file that stays as
                // it is. If the budget needs it, the run fails below.
                slot.transformable = false;
            }
        }

        for (const stage of stages) {
            if (total() <= budgetBytes) {
                break;
            }
            const optimizer = this.byFormat.get(stage.mimeType)!;
            if (!optimizer.profiles.includes(stage.profile)) {
                continue;
            }

            const candidates = slots
                .filter((slot) => slot.input.mimeType === stage.mimeType && slot.transformable)
                // Biggest first: the fewest files degraded for the most saving.
                // Equal sizes fall back to the approved order, so the choice is
                // reproducible rather than dependent on sort stability (AK-15).
                .sort((a, b) => b.current.byteLength - a.current.byteLength || a.index - b.index);
            if (candidates.length === 0) {
                continue;
            }

            const availability = await optimizer.available();
            if (!availability.available) {
                blockedByMissingTool = optimizer.optimizer;
                continue;
            }

            for (const slot of candidates) {
                if (total() <= budgetBytes) {
                    break;
                }
                if (Date.now() >= ctx.deadlineAt) {
                    return timeout();
                }
                // Headroom for one more output of roughly the input's size.
                if (originalsTotal + heldTotal + slot.input.bytes.byteLength > limits.maxWorkingBytes) {
                    blockedByWorkingSet = true;
                    continue;
                }

                let candidate;
                try {
                    // Always from the original. Never from `slot.current`.
                    candidate = await optimizer.produce(slot.input, stage.profile, slot.signature, ctx);
                } catch (error) {
                    if (error instanceof OptimizationTimeoutError) {
                        return timeout();
                    }
                    if (error instanceof OptimizerUnavailableError) {
                        blockedByMissingTool = optimizer.optimizer;
                        break;
                    }
                    // AK-18: a failed optimizer costs its candidate, not the run.
                    continue;
                }
                if (!candidate) {
                    continue;
                }
                // AK-11: bigger than what we already hold is not an improvement,
                // whichever rung produced it.
                if (candidate.bytes.byteLength >= slot.current.byteLength) {
                    continue;
                }
                heldTotal += candidate.bytes.byteLength - (slot.accepted ? slot.current.byteLength : 0);
                slot.current = candidate.bytes;
                slot.accepted = {
                    profile: candidate.profile,
                    optimizer: candidate.optimizer,
                    toolVersion: candidate.toolVersion,
                    durationMs: candidate.durationMs
                };
            }
        }

        const finalTotal = total();
        if (finalTotal > budgetBytes) {
            if (blockedByMissingTool) {
                return {
                    ok: false,
                    reason: 'attachment_optimizer_unavailable',
                    detail: `Das Werkzeug ${blockedByMissingTool} ist nicht verfügbar; die Anhänge bleiben mit ${finalTotal} Bytes über dem Limit von ${budgetBytes} Bytes.`
                };
            }
            if (blockedByWorkingSet) {
                return {
                    ok: false,
                    reason: 'attachment_input_too_large',
                    detail: `Das Arbeitsvolumen von ${limits.maxWorkingBytes} Bytes reichte nicht aus, um weitere Kandidaten zu erzeugen; die Anhänge bleiben mit ${finalTotal} Bytes über dem Limit von ${budgetBytes} Bytes.`
                };
            }
            return {
                ok: false,
                reason: 'attachment_budget_not_reached',
                detail: `Die Anhänge bleiben nach der Optimierung mit ${finalTotal} Bytes über dem Limit von ${budgetBytes} Bytes.`
            };
        }

        return {
            ok: true,
            optimised: slots.some((slot) => slot.accepted !== undefined),
            attachments: slots.map(deliverableOf)
        };
    }
}

function timeout(): OptimizationOutcome {
    return {
        ok: false,
        reason: 'attachment_optimization_timeout',
        detail: 'Das Zeitbudget für die Anhangsoptimierung wurde überschritten.'
    };
}

/**
 * A file nothing was done to. Both digests are the original's, by construction.
 *
 * Exported because the executor needs the same shape on the path where no
 * policy exists at all and the pipeline is never entered: the audit records
 * what was delivered in one format, whether or not anything was optimized.
 */
export function untouchedDelivery(input: OptimizationInput): DeliveredAttachment {
    return untouched(input);
}

function untouched(input: OptimizationInput): DeliveredAttachment {
    const audit: AttachmentAuditRecord = {
        originalFilename: input.filename,
        originalMimeType: input.mimeType,
        originalBytes: input.bytes.byteLength,
        originalSha256: input.sha256,
        outputBytes: input.bytes.byteLength,
        outputSha256: input.sha256,
        wasOptimized: false,
        durationMs: 0
    };
    return { filename: input.filename, mimeType: input.mimeType, bytes: input.bytes, audit };
}

function deliverableOf(slot: Slot): DeliveredAttachment {
    if (!slot.accepted) {
        return untouched(slot.input);
    }
    const audit: AttachmentAuditRecord = {
        originalFilename: slot.input.filename,
        originalMimeType: slot.input.mimeType,
        originalBytes: slot.input.bytes.byteLength,
        originalSha256: slot.input.sha256,
        outputBytes: slot.current.byteLength,
        // Computed here, from the bytes that are about to be handed over —
        // this is the digest of what was really sent, which is the whole point
        // of auditing the output separately from the plan.
        outputSha256: sha256Bytes(slot.current),
        wasOptimized: true,
        optimizer: slot.accepted.optimizer,
        profile: slot.accepted.profile,
        toolVersion: slot.accepted.toolVersion,
        durationMs: slot.accepted.durationMs
    };
    return {
        // The filename never changes. A `lebenslauf.pdf` that arrives as
        // `lebenslauf-compressed.pdf` is a different thing to the person
        // receiving it than the one the sender approved.
        filename: slot.input.filename,
        mimeType: slot.input.mimeType,
        bytes: slot.current,
        audit
    };
}
