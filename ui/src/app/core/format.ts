import type { ApiAttributes } from '@gateway/contract';

/**
 * Presentation helpers.
 *
 * All of them take the "unknown" case seriously and return a visible dash rather
 * than an empty string or the word `undefined`. On a screen whose purpose is to
 * state exactly what is about to leave the machine, "this field has no value" and
 * "this field failed to render" must not look the same.
 */

export const UNKNOWN = '–';

export function formatBytes(bytes: number | undefined): string {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes)) {
        return UNKNOWN;
    }
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KiB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

export function formatTime(iso: string | undefined): string {
    if (!iso) {
        return UNKNOWN;
    }
    const parsed = new Date(iso);
    // An unparseable timestamp is shown verbatim: the raw value is more useful
    // for figuring out what went wrong than a placeholder that hides it.
    return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString('de-DE');
}

/** Coarse relative time for log tables, where the exact second rarely matters. */
export function formatRelative(iso: string | undefined, now: number): string {
    if (!iso) {
        return UNKNOWN;
    }
    const then = Date.parse(iso);
    if (Number.isNaN(then)) {
        return iso;
    }
    const seconds = Math.round((now - then) / 1000);
    if (seconds < 60) {
        return 'gerade eben';
    }
    if (seconds < 3600) {
        return `vor ${Math.floor(seconds / 60)} min`;
    }
    if (seconds < 86400) {
        return `vor ${Math.floor(seconds / 3600)} h`;
    }
    return formatTime(iso);
}

export interface Countdown {
    text: string;
    /** Milliseconds left; negative once lapsed. */
    remainingMs: number;
    expired: boolean;
    /** Under two minutes: approving may well fail before the click lands. */
    urgent: boolean;
}

export function countdown(expiresAt: string, now: number): Countdown {
    const remainingMs = Date.parse(expiresAt) - now;
    if (Number.isNaN(remainingMs)) {
        return { text: UNKNOWN, remainingMs: 0, expired: false, urgent: false };
    }
    if (remainingMs <= 0) {
        return { text: 'abgelaufen', remainingMs, expired: true, urgent: true };
    }
    const totalSeconds = Math.floor(remainingMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const text =
        minutes >= 60
            ? `${Math.floor(minutes / 60)} h ${minutes % 60} min`
            : minutes > 0
              ? `${minutes} min ${seconds} s`
              : `${seconds} s`;
    return { text, remainingMs, expired: false, urgent: remainingMs < 120_000 };
}

/** Flattens source-side classification into one readable line. */
export function formatAttributes(attributes: ApiAttributes | undefined): string {
    if (!attributes) {
        return '';
    }
    return Object.entries(attributes)
        .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
        .join(' · ');
}

export function formatConfidence(confidence: number): string {
    return `${Math.round(confidence * 100)} %`;
}

/**
 * `application/pdf` as `PDF`.
 *
 * Used where a media type appears inside a German sentence rather than in a
 * technical list — "nur PDF und JPEG" reads as a sentence, "nur application/pdf
 * und image/jpeg" reads as a config file. The exact type is still shown
 * verbatim next to every individual attachment.
 */
export function shortFormat(mimeType: string): string {
    const subtype = mimeType.split('/')[1] ?? mimeType;
    return subtype.toUpperCase();
}
