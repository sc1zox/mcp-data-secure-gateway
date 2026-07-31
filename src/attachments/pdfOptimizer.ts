/**
 * PDF adapter: qpdf for preflight, structural rewriting and validation;
 * Ghostscript for the actual image-level reduction.
 *
 * The division of labour is not arbitrary. qpdf understands PDF structure and
 * will tell you honestly that a file is encrypted or that a rewrite came out
 * damaged; it will not resample an embedded 600-dpi scan, which is where the
 * bytes actually are. Ghostscript will resample that scan, but it does so by
 * rewriting the entire document, which is a change big enough that its output
 * has to be re-validated by something that was not involved in producing it.
 * So qpdf checks Ghostscript's work.
 *
 * Everything here is conservative in one direction: when in doubt about whether
 * a PDF can be safely rewritten, it is left alone. A file that stays whole and
 * makes the action fail is a recoverable annoyance; a signed contract whose
 * signature was silently invalidated in transit is not.
 */
import { readFile, writeFile } from 'node:fs/promises';
import type { TransformProfile } from '../core/types.js';
import { ProcessSpawnError, ProcessTimeoutError, workspacePath, type ProcessRunner } from './processRunner.js';
import { PDF_LADDER, PDF_PROFILES, ghostscriptArgs, qpdfStructuralArgs } from './profiles.js';
import {
    OptimizationTimeoutError,
    OptimizerUnavailableError,
    PDF_MIME,
    type Candidate,
    type FormatOptimizer,
    type FormatSignature,
    type OptimizationContext,
    type OptimizationInput,
    type PreflightVerdict,
    type ToolAvailability
} from './types.js';

const PDF_MAGIC = '%PDF-';

/**
 * Structure tokens that mean "this document does something a plain rewrite
 * would break". Scanned for rather than parsed, and read from a qpdf-expanded
 * copy so a token hidden inside a compressed object stream is still visible.
 *
 * Deliberately over-broad. `/AcroForm` appears in plenty of PDFs that have no
 * real interactivity left, and skipping those costs a little compression;
 * missing a signature costs the signature.
 */
const INTERACTIVE_MARKERS: ReadonlyArray<{ token: string; reason: string }> = [
    { token: '/Sig', reason: 'signiert' },
    { token: '/DocMDP', reason: 'signiert' },
    { token: '/XFA', reason: 'xfa_formular' },
    { token: '/AcroForm', reason: 'formular' },
    { token: '/EmbeddedFiles', reason: 'eingebettete_dateien' },
    { token: '/Collection', reason: 'portfolio' }
];

/** Per-process ceiling, so one stuck child cannot eat the whole run's budget. */
const MAX_PROCESS_MS = 120_000;

export interface PdfOptimizerOptions {
    qpdfCommand?: string;
    ghostscriptCommand?: string;
    /**
     * Whether a `qpdf --check` that reports warnings (exit 3) disqualifies a
     * derivative. Structural errors (exit 2) always disqualify, regardless.
     *
     * Off by default, on the reasoning that exit 3 is qpdf's "readable, with
     * remarks" and exit 2 its "broken", so exit 2 is the signal that maps to
     * "do not send this". How often Ghostscript output actually lands on 3 has
     * not been measured here — that belongs to the profile calibration the
     * story defers to Phase 8. Both settings are covered by tests against a
     * scripted runner; neither has been observed against a real qpdf on this
     * machine, because qpdf is not installed on it.
     */
    rejectOnWarnings?: boolean;
    /** Rungs this instance offers. Narrowed by the engine configuration. */
    profiles?: readonly TransformProfile[];
}

export class PdfOptimizer implements FormatOptimizer {
    readonly mimeType = PDF_MIME;
    readonly optimizer = 'qpdf+ghostscript';
    readonly profiles: readonly TransformProfile[];

    private availability?: ToolAvailability;
    private readonly qpdfCommand: string;
    private readonly ghostscriptCommand: string;
    private readonly rejectOnWarnings: boolean;

    constructor(
        private readonly runner: ProcessRunner,
        options: PdfOptimizerOptions = {}
    ) {
        this.qpdfCommand = options.qpdfCommand ?? 'qpdf';
        this.ghostscriptCommand = options.ghostscriptCommand ?? 'gs';
        this.rejectOnWarnings = options.rejectOnWarnings ?? false;
        this.profiles = options.profiles ?? PDF_LADDER;
    }

    async available(): Promise<ToolAvailability> {
        if (this.availability) {
            return this.availability;
        }
        const qpdf = await this.version(this.qpdfCommand, ['--version']);
        const ghostscript = await this.version(this.ghostscriptCommand, ['--version']);
        const missing = [
            qpdf === undefined ? this.qpdfCommand : undefined,
            ghostscript === undefined ? this.ghostscriptCommand : undefined
        ].filter((entry): entry is string => entry !== undefined);
        this.availability = missing.length
            ? {
                  available: false,
                  version: '',
                  detail: `Nicht installiert: ${missing.join(', ')}.`
              }
            : { available: true, version: `qpdf ${qpdf}, ghostscript ${ghostscript}` };
        return this.availability;
    }

    private async version(command: string, args: string[]): Promise<string | undefined> {
        try {
            const result = await this.runner.run({ command, args, timeoutMs: 10_000 });
            if (result.code !== 0) {
                return undefined;
            }
            const line = `${result.stdout}${result.stderr}`.split('\n')[0]?.trim() ?? '';
            // qpdf answers "qpdf version 11.9.0", gs answers a bare "10.07.1".
            return /(\d+\.\d+(?:\.\d+)?)/.exec(line)?.[1] ?? line.slice(0, 40);
        } catch {
            return undefined;
        }
    }

    /**
     * Decides whether this PDF may be rewritten at all, and records the one
     * property every derivative is checked against afterwards: the page count.
     */
    async preflight(input: OptimizationInput, ctx: OptimizationContext): Promise<PreflightVerdict> {
        await this.requireTools();
        if (!hasPdfMagic(input.bytes)) {
            return { transformable: false, reason: 'kein_pdf' };
        }

        const source = workspacePath(ctx.workspaceDir, '.pdf');
        await writeFile(source, input.bytes);

        // Exit 0 means encrypted, and an encrypted PDF is left alone: rewriting
        // one requires its password, and guessing is not a feature.
        const encrypted = await this.exec(['--is-encrypted', source], ctx);
        if (encrypted.code === 0) {
            return { transformable: false, reason: 'verschluesselt' };
        }

        const pages = await this.exec(['--show-npages', source], ctx);
        if (pages.code !== 0) {
            return { transformable: false, reason: 'nicht_lesbar' };
        }
        const pageCount = Number.parseInt(pages.stdout.trim(), 10);
        if (!Number.isInteger(pageCount) || pageCount <= 0) {
            return { transformable: false, reason: 'seitenzahl_unbekannt' };
        }

        // Expand object streams so the marker scan below sees the whole object
        // structure. Content streams stay compressed (`--stream-data=preserve`),
        // which keeps this from inflating a scan to many times its size.
        const expanded = workspacePath(ctx.workspaceDir, '.expanded.pdf');
        const expansion = await this.exec(
            ['--object-streams=disable', '--stream-data=preserve', source, expanded],
            ctx
        );
        // A file qpdf cannot even rewrite losslessly is not one to hand to
        // Ghostscript.
        if (expansion.code !== 0 && expansion.code !== 3) {
            return { transformable: false, reason: 'nicht_verarbeitbar' };
        }
        const structure = await readFile(expanded).catch(() => undefined);
        const haystack = (structure ?? input.bytes).toString('latin1');
        for (const marker of INTERACTIVE_MARKERS) {
            if (haystack.includes(marker.token)) {
                return { transformable: false, reason: marker.reason };
            }
        }

        return { transformable: true, signature: { pages: pageCount } };
    }

    async produce(
        input: OptimizationInput,
        profile: TransformProfile,
        signature: FormatSignature | undefined,
        ctx: OptimizationContext
    ): Promise<Candidate | undefined> {
        await this.requireTools();
        const startedAt = Date.now();
        const source = workspacePath(ctx.workspaceDir, '.pdf');
        const output = workspacePath(ctx.workspaceDir, '.out.pdf');
        // Always the original bytes — the pipeline hands them in and the
        // candidate is written from them, never from a previous derivative.
        await writeFile(source, input.bytes);

        if (profile === 'structural') {
            const result = await this.exec(qpdfStructuralArgs(source, output), ctx);
            if (result.code !== 0 && result.code !== 3) {
                return undefined;
            }
        } else {
            const settings = PDF_PROFILES[profile];
            const result = await this.run(
                this.ghostscriptCommand,
                ghostscriptArgs(settings, source, output),
                ctx,
                'ghostscript'
            );
            if (result.code !== 0) {
                return undefined;
            }
        }

        const bytes = await readFile(output).catch(() => undefined);
        if (!bytes || bytes.byteLength === 0 || !hasPdfMagic(bytes)) {
            return undefined;
        }
        if (!(await this.validate(output, signature, ctx))) {
            return undefined;
        }

        const availability = await this.available();
        return {
            bytes: new Uint8Array(bytes),
            profile,
            optimizer: profile === 'structural' ? 'qpdf' : 'ghostscript',
            toolVersion: availability.version,
            durationMs: Date.now() - startedAt
        };
    }

    /**
     * The second opinion on a derivative. Structural integrity from `--check`,
     * and the page count against the original's — a rewrite that dropped a page
     * is smaller for exactly the wrong reason.
     */
    private async validate(
        path: string,
        signature: FormatSignature | undefined,
        ctx: OptimizationContext
    ): Promise<boolean> {
        const check = await this.exec(['--check', path], ctx);
        if (check.code === 2 || (this.rejectOnWarnings && check.code !== 0)) {
            return false;
        }
        if (check.code !== 0 && check.code !== 3) {
            return false;
        }
        const expectedPages = signature?.pages;
        if (typeof expectedPages !== 'number') {
            return true;
        }
        const pages = await this.exec(['--show-npages', path], ctx);
        return pages.code === 0 && Number.parseInt(pages.stdout.trim(), 10) === expectedPages;
    }

    private async requireTools(): Promise<void> {
        const availability = await this.available();
        if (!availability.available) {
            throw new OptimizerUnavailableError(availability.detail ?? 'PDF-Werkzeuge fehlen.');
        }
    }

    private exec(args: string[], ctx: OptimizationContext) {
        return this.run(this.qpdfCommand, args, ctx, 'qpdf');
    }

    private async run(command: string, args: string[], ctx: OptimizationContext, lane: string) {
        const remaining = ctx.deadlineAt - Date.now();
        if (remaining <= 0) {
            throw new OptimizationTimeoutError('Zeitbudget aufgebraucht.');
        }
        try {
            return await this.runner.run({
                command,
                args,
                lane,
                timeoutMs: Math.min(remaining, MAX_PROCESS_MS)
            });
        } catch (error) {
            if (error instanceof ProcessTimeoutError) {
                throw new OptimizationTimeoutError(`${command} überschritt das Zeitbudget.`);
            }
            if (error instanceof ProcessSpawnError) {
                throw new OptimizerUnavailableError(`${command} ist nicht ausführbar.`);
            }
            throw error;
        }
    }
}

function hasPdfMagic(bytes: Uint8Array): boolean {
    return Buffer.from(bytes.subarray(0, 5)).toString('latin1') === PDF_MAGIC;
}
