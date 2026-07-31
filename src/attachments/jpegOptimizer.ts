/**
 * JPEG adapter, built on Sharp with the mozjpeg encoder.
 *
 * Sharp is loaded lazily rather than at import time, and a failure to load is a
 * clean `OptimizerUnavailableError` rather than an exception during boot. That
 * matters because Sharp ships a native binary: on a machine where its install
 * step was skipped or its libvips build does not match, the gateway must still
 * start and must still deliver everything that already fits. Losing JPEG
 * compression is a degraded feature; failing to start is a dead gateway.
 *
 * Two things happen in a deliberate order in `produce`. The EXIF orientation is
 * applied to the pixels *first*, and only then is the metadata dropped — Sharp
 * discards metadata by default, so a strip before the rotate would leave a
 * portrait photo lying on its side with nothing left to say it should not be
 * (AK-8). Everything private goes with it: GPS coordinates, camera model,
 * capture time, XMP.
 */
import type { TransformProfile } from '../core/types.js';
import { JPEG_LADDER, JPEG_PROFILES } from './profiles.js';
import {
    JPEG_MIME,
    OptimizationTimeoutError,
    OptimizerUnavailableError,
    type Candidate,
    type FormatOptimizer,
    type FormatSignature,
    type OptimizationContext,
    type OptimizationInput,
    type PreflightVerdict,
    type ToolAvailability
} from './types.js';

/** The module namespace, as `import('sharp')` resolves it. */
type SharpImport = typeof import('sharp');
/** The callable factory itself, which is where `versions` lives. */
type SharpFactory = SharpImport['default'];

export interface JpegGuards {
    /** Refuse decode bombs: a small file can claim enormous dimensions. */
    maxPixels: number;
    /** RGB plus alpha is the most a sane photograph has; CMYK is 4 as well. */
    maxChannels: number;
}

export const DEFAULT_JPEG_GUARDS: JpegGuards = { maxPixels: 80_000_000, maxChannels: 4 };

export class JpegOptimizer implements FormatOptimizer {
    readonly mimeType = JPEG_MIME;
    readonly optimizer = 'sharp';
    readonly profiles: readonly TransformProfile[];

    private availability?: ToolAvailability;
    private sharp?: SharpFactory;
    private readonly guards: JpegGuards;
    private readonly load: () => Promise<SharpImport>;

    constructor(
        options: {
            guards?: JpegGuards;
            /** Rungs this instance offers. Narrowed by the engine configuration. */
            profiles?: readonly TransformProfile[];
            /** Injectable so tests can exercise the adapter without real Sharp. */
            load?: () => Promise<SharpImport>;
        } = {}
    ) {
        this.guards = options.guards ?? DEFAULT_JPEG_GUARDS;
        this.profiles = options.profiles ?? JPEG_LADDER;
        this.load = options.load ?? (() => import('sharp'));
    }

    async available(): Promise<ToolAvailability> {
        if (this.availability) {
            return this.availability;
        }
        try {
            const sharp = await this.loadSharp();
            this.availability = {
                available: true,
                version: `sharp ${sharp.versions.sharp}, libvips ${sharp.versions.vips}`
            };
        } catch {
            this.availability = {
                available: false,
                version: '',
                detail: 'Sharp konnte nicht geladen werden.'
            };
        }
        return this.availability;
    }

    private async loadSharp(): Promise<SharpFactory> {
        if (!this.sharp) {
            const loaded = await this.load();
            // Under ESM the namespace is not callable and the factory sits on
            // `default`; under CJS interop the module itself is the factory.
            // Take whichever of the two can actually be called.
            const candidate: unknown = loaded.default ?? loaded;
            this.sharp = candidate as SharpFactory;
        }
        return this.sharp;
    }

    async preflight(input: OptimizationInput, ctx: OptimizationContext): Promise<PreflightVerdict> {
        this.assertTime(ctx);
        const sharp = await this.require();
        try {
            const metadata = await sharp(Buffer.from(input.bytes), {
                limitInputPixels: this.guards.maxPixels
            }).metadata();
            if (metadata.format !== 'jpeg') {
                return { transformable: false, reason: 'kein_jpeg' };
            }
            const width = metadata.width ?? 0;
            const height = metadata.height ?? 0;
            if (width <= 0 || height <= 0 || width * height > this.guards.maxPixels) {
                return { transformable: false, reason: 'abmessungen_unzulaessig' };
            }
            if ((metadata.channels ?? 0) > this.guards.maxChannels) {
                return { transformable: false, reason: 'zu_viele_kanaele' };
            }
            // Orientations 5..8 transpose the image, so the dimensions a viewer
            // sees are the stored ones swapped. Record what will exist after
            // `rotate()`, because that is what the derivative is compared to.
            const transposed = (metadata.orientation ?? 1) >= 5;
            return {
                transformable: true,
                signature: {
                    width: transposed ? height : width,
                    height: transposed ? width : height
                }
            };
        } catch {
            return { transformable: false, reason: 'nicht_dekodierbar' };
        }
    }

    async produce(
        input: OptimizationInput,
        profile: TransformProfile,
        signature: FormatSignature | undefined,
        ctx: OptimizationContext
    ): Promise<Candidate | undefined> {
        this.assertTime(ctx);
        if (profile !== 'balanced' && profile !== 'compact') {
            return undefined;
        }
        const sharp = await this.require();
        const settings = JPEG_PROFILES[profile];
        const startedAt = Date.now();

        let bytes: Buffer;
        try {
            bytes = await sharp(Buffer.from(input.bytes), { limitInputPixels: this.guards.maxPixels })
                // Bake the EXIF orientation into the pixels before anything else.
                .rotate()
                .resize({
                    width: settings.maxEdgePixels,
                    height: settings.maxEdgePixels,
                    fit: 'inside',
                    // A small photo must never be blown up in the name of
                    // making it smaller.
                    withoutEnlargement: true
                })
                // CMYK and Display-P3 inputs leave as sRGB, so what the
                // recipient sees is what the approver saw.
                .toColorspace('srgb')
                .jpeg({
                    quality: settings.quality,
                    mozjpeg: true,
                    // Implied by mozjpeg, stated because the story names them.
                    optimizeCoding: true,
                    trellisQuantisation: true,
                    progressive: true
                })
                // No `withMetadata()`: EXIF, GPS, XMP and the camera model are
                // dropped by omission, which is the default and is what we want.
                .toBuffer();
        } catch {
            return undefined;
        }

        if (!(await this.validate(bytes, signature))) {
            return undefined;
        }
        const availability = await this.available();
        return {
            bytes: new Uint8Array(bytes),
            profile,
            optimizer: this.optimizer,
            toolVersion: availability.version,
            durationMs: Date.now() - startedAt
        };
    }

    /**
     * Re-decodes the encoder's own output with a fresh reader. Producing bytes
     * and trusting them because the encoder did not throw is not a check; this
     * is the step that catches a truncated or half-written buffer before it can
     * become an attachment (AK-12).
     */
    private async validate(bytes: Buffer, signature: FormatSignature | undefined): Promise<boolean> {
        if (bytes.byteLength === 0) {
            return false;
        }
        const sharp = await this.require();
        try {
            const metadata = await sharp(bytes, { limitInputPixels: this.guards.maxPixels }).metadata();
            if (metadata.format !== 'jpeg') {
                return false;
            }
            const width = metadata.width ?? 0;
            const height = metadata.height ?? 0;
            if (width <= 0 || height <= 0 || (metadata.channels ?? 0) > this.guards.maxChannels) {
                return false;
            }
            // Resizing may shrink, never grow. A derivative larger than the
            // original in either axis means something went wrong upstream.
            const expectedWidth = signature?.width;
            const expectedHeight = signature?.height;
            if (typeof expectedWidth === 'number' && width > expectedWidth) {
                return false;
            }
            if (typeof expectedHeight === 'number' && height > expectedHeight) {
                return false;
            }
            return true;
        } catch {
            return false;
        }
    }

    private async require(): Promise<SharpFactory> {
        const availability = await this.available();
        if (!availability.available) {
            throw new OptimizerUnavailableError(availability.detail ?? 'Sharp ist nicht verfügbar.');
        }
        return this.loadSharp();
    }

    private assertTime(ctx: OptimizationContext): void {
        if (Date.now() >= ctx.deadlineAt) {
            throw new OptimizationTimeoutError('Zeitbudget aufgebraucht.');
        }
    }
}
