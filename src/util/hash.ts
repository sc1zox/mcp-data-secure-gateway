import { createHash, timingSafeEqual } from 'node:crypto';

/** Hex-encoded SHA-256 of a byte buffer. */
export function sha256Bytes(data: Uint8Array): string {
    return createHash('sha256').update(data).digest('hex');
}

/** Hex-encoded SHA-256 of a UTF-8 string. */
export function sha256Text(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Stable hash over a JSON-like value: object keys are sorted recursively so
 * that two structurally equal values always produce the same digest. Used for
 * the binding hash that pins an approval to one exact action.
 */
export function stableHash(value: unknown): string {
    return sha256Text(canonicalize(value));
}

export function canonicalize(value: unknown): string {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value ?? null);
    }
    if (Array.isArray(value)) {
        return `[${value.map(canonicalize).join(',')}]`;
    }
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
}

/** Constant-time comparison of two hex digests or tokens of equal length. */
export function safeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    if (bufA.length !== bufB.length) {
        return false;
    }
    return timingSafeEqual(bufA, bufB);
}
