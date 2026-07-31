/**
 * Builds the optimization pipeline from configuration.
 *
 * Kept in its own file so that `pipeline.ts` — the part with the actual
 * decision logic, and the part the tests drive hardest — never imports the
 * config schema. The pipeline takes adapters; this decides which adapters exist.
 */
import type { AttachmentOptimizationConfig } from '../config.js';
import type { TransformProfile } from '../core/types.js';
import { JpegOptimizer } from './jpegOptimizer.js';
import { PdfOptimizer } from './pdfOptimizer.js';
import { AttachmentOptimizationPipeline } from './pipeline.js';
import { ProcessRunner } from './processRunner.js';
import type { FormatOptimizer, OptimizationLimits } from './types.js';

export interface OptimizationService {
    pipeline: AttachmentOptimizationPipeline;
    limits: OptimizationLimits;
}

/**
 * Returns undefined when the engine is switched off entirely, which is how the
 * executor learns to skip the whole step rather than being handed a pipeline
 * that refuses everything.
 */
export function createOptimizationService(
    config: AttachmentOptimizationConfig
): OptimizationService | undefined {
    if (!config.enabled) {
        return undefined;
    }

    const runner = new ProcessRunner({
        ghostscript: config.execution.maxConcurrentPdfJobs,
        qpdf: config.execution.maxConcurrentPdfJobs
    });

    const optimizers: FormatOptimizer[] = [];
    if (config.pdf.enabled) {
        // The lossless qpdf rung is a separate switch from the Ghostscript
        // rungs, because it is the one that costs nothing in quality.
        const profiles: TransformProfile[] = [
            ...(config.pdf.qpdfStructuralOptimization ? (['structural'] as const) : []),
            ...config.pdf.profiles
        ];
        optimizers.push(
            new PdfOptimizer(runner, {
                qpdfCommand: config.pdf.qpdfCommand,
                ghostscriptCommand: config.pdf.ghostscriptCommand,
                rejectOnWarnings: config.pdf.rejectOnWarnings,
                profiles
            })
        );
    }
    if (config.jpeg.enabled) {
        optimizers.push(
            new JpegOptimizer({
                guards: { maxPixels: config.jpeg.maxPixels, maxChannels: config.jpeg.maxChannels },
                profiles: config.jpeg.profiles
            })
        );
    }
    if (optimizers.length === 0) {
        return undefined;
    }

    return {
        pipeline: new AttachmentOptimizationPipeline(optimizers),
        limits: {
            maxSingleInputBytes: config.limits.maxSingleInputBytes,
            maxTotalInputBytes: config.limits.maxTotalInputBytes,
            maxWorkingBytes: config.limits.maxWorkingBytes,
            timeBudgetMs: config.limits.timeBudgetMs
        }
    };
}
