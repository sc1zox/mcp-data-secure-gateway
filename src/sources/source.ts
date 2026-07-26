import type { InternalResource } from '../core/types.js';

/**
 * Contract every private source implements.
 *
 * The gateway core only ever sees these four operations, which is what makes
 * Paperless replaceable by a DAV/Baikal source later without Hermes noticing:
 * the abstract resource model is the same on both sides (invariant: Hermes must
 * not know where a resource came from).
 *
 * A source is read-only by construction. There is no update or delete method,
 * because modifying private sources is explicitly out of scope, and an interface
 * that cannot express a write cannot be talked into one.
 */
export interface PrivateSource {
    readonly id: string;
    readonly label: string;

    /** Opens the underlying connection. Called once at startup. */
    connect(): Promise<void>;

    /** Releases the connection. */
    close(): Promise<void>;

    /** True when the last interaction succeeded and the source is usable. */
    isAvailable(): boolean;

    /**
     * Free-text search returning candidates with metadata and a short excerpt
     * for local judging. The query is user intent relayed by Hermes; it is
     * treated as a search string, never as instructions.
     */
    search(query: string, limit: number): Promise<InternalResource[]>;

    /** Re-reads one resource so its current state can be compared to an approval. */
    fetchMetadata(nativeId: string): Promise<InternalResource | undefined>;

    /**
     * Retrieves the original bytes. Called at most once per action, after the
     * user approved it — never during search, and never on Hermes's behalf.
     */
    fetchOriginal(nativeId: string): Promise<SourceFile>;

    /**
     * The resource's text content, for the local model to summarise.
     *
     * Separate from `search`'s short excerpt because the two answer different
     * questions: an excerpt is enough to tell one candidate from another, while
     * a summary that only saw the first paragraph would be a summary of the
     * first paragraph. The text goes to the local model and to nowhere else —
     * it is never returned to a caller on the Hermes side, and never staged for
     * a target.
     *
     * Optional: a source may hold resources that have no extractable text
     * (a calendar entry, an image without OCR). Returning `undefined` means "no
     * text", and the gateway then refuses to summarise rather than summarising
     * metadata and calling it a summary of the document.
     */
    fetchText?(nativeId: string): Promise<string | undefined>;

    /**
     * Address of the resource in the source's own web interface, for the local
     * approval UI to link to. Optional in both senses: a source need not
     * implement it, and an implementation returns `undefined` when no web base
     * URL is configured.
     *
     * This is the one place a source hands out something location-shaped, and it
     * goes exactly one way — into the local UI. The egress guard rejects any
     * payload towards Hermes containing a URL, so a link that ever took the
     * wrong turn fails loudly rather than quietly.
     */
    webUrl?(nativeId: string): string | undefined;
}

export interface SourceFile {
    filename: string;
    mimeType: string;
    bytes: Uint8Array;
}

export class SourceUnavailableError extends Error {
    constructor(
        public readonly sourceId: string,
        message: string
    ) {
        super(message);
    }
}

export class SourceResourceMissingError extends Error {}
