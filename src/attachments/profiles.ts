/**
 * The versioned profile catalogue.
 *
 * These are the actual numbers behind the words `balanced` and `compact`, kept
 * in one file because the approval binds `policyVersion` and nothing else about
 * them. A user who approved an action under version `1` approved *these* values;
 * if any number below changes, `POLICY_VERSION` must change with it, or a
 * pending action prepared yesterday would execute under settings nobody agreed
 * to.
 *
 * Ghostscript's own presets (`/ebook`, `/screen`) are deliberately not used.
 * They are a moving target across Ghostscript releases and they bundle
 * decisions — colour conversion, font handling — that the story wants stated
 * explicitly. Every flag here is set on purpose.
 *
 * NOT YET CALIBRATED. The story's Phase 8 requires these to be measured against
 * a real corpus of certificates, scans and application documents before they are
 * marked stable. The values below are defensible starting points chosen so that
 * body text at 200 dpi stays comfortably legible; they are not measured, and
 * `README.md` says so as well.
 */
import type { ApprovedTransformPolicy, TransformProfile } from '../core/types.js';
import { JPEG_MIME, PDF_MIME } from './types.js';

/** Bump on any change to the numbers in this file. Bound into every approval. */
export const POLICY_VERSION = '2026-07-31.2';

/** A Ghostscript rung: how far images may be reduced when rewriting a PDF. */
export interface PdfProfile {
    /** Downsampling target for colour and greyscale images, in dpi. */
    imageResolutionDpi: number;
    /** Downsampling target for 1-bit images, which tolerate far more, in dpi. */
    monoResolutionDpi: number;
    /** JPEG quality Ghostscript uses when re-encoding embedded images. */
    imageQuality: number;
}

export const PDF_PROFILES: Record<'balanced' | 'compact', PdfProfile> = {
    // Keeps scanned body text sharp; roughly "good enough to read and to print
    // one copy of", which is what a certificate attached to an application is
    // for.
    balanced: { imageResolutionDpi: 200, monoResolutionDpi: 300, imageQuality: 78 },
    // Visibly softer on photographs, still legible for text. Only reached when
    // the target's policy allows `compact` and `balanced` was not enough.
    compact: { imageResolutionDpi: 120, monoResolutionDpi: 200, imageQuality: 62 }
};

/** A Sharp rung: quality and the longest edge the image is allowed to keep. */
export interface JpegProfile {
    quality: number;
    /** Longest edge in pixels. The image is only ever shrunk, never enlarged. */
    maxEdgePixels: number;
}

export const JPEG_PROFILES: Record<'balanced' | 'compact', JpegProfile> = {
    // 2600 px on the long edge still prints an A4 page at ~220 dpi.
    balanced: { quality: 82, maxEdgePixels: 2600 },
    compact: { quality: 68, maxEdgePixels: 1800 }
};

/**
 * Ghostscript's command line for one profile.
 *
 * Built as an array and handed to `ProcessRunner` unshelled, so `input` and
 * `output` are values rather than text that could be reinterpreted. Both are
 * workspace paths the gateway generated.
 */
export function ghostscriptArgs(profile: PdfProfile, input: string, output: string): string[] {
    return [
        '-sDEVICE=pdfwrite',
        // 1.7 is universally readable and does not force Ghostscript to
        // downgrade transparency or newer font formats into something larger.
        '-dCompatibilityLevel=1.7',
        '-dNOPAUSE',
        '-dBATCH',
        '-dQUIET',
        // Restricts the interpreter's access to the file system. Default since
        // 9.50, stated anyway: this is the flag that stops a crafted PDF from
        // reading paths of its choosing.
        '-dSAFER',
        '-dNOOUTERSAVE',
        // The single biggest win on documents that embed the same logo or scan
        // fragment on every page.
        '-dDetectDuplicateImages=true',
        '-dCompressFonts=true',
        '-dSubsetFonts=true',
        // Ghostscript only downsamples when the image exceeds the target
        // resolution by `DownsampleThreshold`, which defaults to 1.5. That
        // default silently turns "max 200 dpi" into "max 300 dpi", and a 290-dpi
        // scan then passes through untouched — measured, not assumed: with the
        // default the balanced profile came out *larger* than its input. 1.0
        // makes the stated resolution mean what it says.
        '-dDownsampleColorImages=true',
        '-dColorImageDownsampleType=/Bicubic',
        `-dColorImageResolution=${profile.imageResolutionDpi}`,
        '-dColorImageDownsampleThreshold=1.0',
        '-dDownsampleGrayImages=true',
        '-dGrayImageDownsampleType=/Bicubic',
        `-dGrayImageResolution=${profile.imageResolutionDpi}`,
        '-dGrayImageDownsampleThreshold=1.0',
        '-dDownsampleMonoImages=true',
        '-dMonoImageDownsampleThreshold=1.0',
        // Subsampling rather than averaging: on 1-bit scans, averaging turns
        // crisp glyph edges into grey mush at exactly the sizes that matter.
        '-dMonoImageDownsampleType=/Subsample',
        `-dMonoImageResolution=${profile.monoResolutionDpi}`,
        // Auto-filtering lets Ghostscript pick per image and makes results hard
        // to predict; the story asks for explicit image compression.
        '-dAutoFilterColorImages=false',
        '-dColorImageFilter=/DCTEncode',
        '-dAutoFilterGrayImages=false',
        '-dGrayImageFilter=/DCTEncode',
        '-dMonoImageFilter=/CCITTFaxEncode',
        // Defaults to true, and while true an already-JPEG image is copied
        // verbatim and `JPEGQ` below is ignored entirely. Off, so the quality
        // this profile declares is the quality that is actually applied — which
        // is the whole point of having a profile.
        '-dPassThroughJPEGImages=false',
        `-dJPEGQ=${profile.imageQuality}`,
        // Normalise to sRGB so a CMYK scan does not travel as CMYK and render
        // differently wherever it lands.
        '-dColorConversionStrategy=/sRGB',
        '-dProcessColorModel=/DeviceRGB',
        '-sOutputFile=' + output,
        input
    ];
}

/**
 * qpdf's structural pass: recompress streams and build object streams, without
 * touching a single pixel. Lossless, and often several percent on a PDF that
 * was written by a naive producer.
 */
export function qpdfStructuralArgs(input: string, output: string): string[] {
    return [
        '--object-streams=generate',
        '--compress-streams=y',
        '--recompress-flate',
        '--compression-level=9',
        '--stream-data=compress',
        // Never repair silently into something structurally different.
        '--warning-exit-0',
        input,
        output
    ];
}

/** The rungs each format offers, weakest first. Order is the ladder. */
export const PDF_LADDER: readonly TransformProfile[] = ['structural', 'balanced', 'compact'];
export const JPEG_LADDER: readonly TransformProfile[] = ['balanced', 'compact'];

/**
 * Turns a target's configuration into the policy that gets frozen into its
 * actions' plans — and returns `undefined` when the target optimizes nothing.
 *
 * The `undefined` is not a convenience. `canonicalize` drops undefined fields
 * before hashing, so a target with `mode: "disabled"` produces plans whose
 * binding hash is byte-identical to what it was before optimization existed.
 * Returning an object that merely says "disabled" would change every hash and
 * make every pending action unapprovable on upgrade.
 */
export function buildTransformPolicy(input: {
    mode: 'disabled' | 'balanced' | 'compact';
    pdf: boolean;
    jpeg: boolean;
}): ApprovedTransformPolicy | undefined {
    if (input.mode === 'disabled') {
        return undefined;
    }
    const formats = [input.pdf ? PDF_MIME : undefined, input.jpeg ? JPEG_MIME : undefined]
        .filter((entry): entry is string => entry !== undefined)
        // Sorted so two configurations that permit the same formats produce the
        // same hash regardless of the order they were written in.
        .sort();
    if (formats.length === 0) {
        return undefined;
    }
    return { policyVersion: POLICY_VERSION, maxProfile: input.mode, formats };
}
