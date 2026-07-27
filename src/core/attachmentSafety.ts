/**
 * Source-side attachment metadata safety.
 *
 * Unlike `agentInput.ts`, the values checked here come from a private source
 * (filename, media type as the source reported them), not from Hermes. They
 * still flow into MIME headers and the approval page's HTML, so the same
 * rejection-over-sanitisation stance applies: a value that fails this check is
 * refused rather than displayed in a cleaned-up form that would differ from
 * what the source actually gave.
 */
import type { SourceFile } from '../sources/source.js';

/**
 * Filenames and media types are sent as message metadata and rendered in the
 * approval page. Reject invisible controls and path-shaped names rather than
 * trying to display a sanitised value that differs from what the source gave.
 */
export function isSafeAttachment(file: SourceFile): boolean {
    if (
        !file ||
        typeof file.filename !== 'string' ||
        typeof file.mimeType !== 'string' ||
        !(file.bytes instanceof Uint8Array)
    ) {
        return false;
    }
    const filename = file.filename.normalize('NFC');
    const mimeType = file.mimeType.trim();
    return !(
        filename.length === 0 ||
        filename.length > 255 ||
        filename !== file.filename ||
        filename.trim() !== filename ||
        filename === '.' ||
        filename === '..' ||
        /[/\\]/.test(filename) ||
        /[^\P{C}]/u.test(filename) ||
        mimeType.length === 0 ||
        mimeType.length > 200 ||
        /[^\P{C}]/u.test(mimeType) ||
        !/^[^\s/;]+\/[^\s/;]+(?:\s*;\s*[^\r\n]+)?$/.test(mimeType)
    );
}
