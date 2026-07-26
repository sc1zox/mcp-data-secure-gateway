import type { SourceConfig } from '../config.js';
import type { InternalResource } from '../core/types.js';
import { sha256Text } from '../util/hash.js';
import { createLogger, describeError, type Logger } from '../util/log.js';
import { McpSourceClient, binaryOf, jsonOf, textOf, type McpToolResult } from './mcpSourceClient.js';
import {
    SourceResourceMissingError,
    SourceUnavailableError,
    type PrivateSource,
    type SourceFile
} from './source.js';

/** Parameter names seen across Paperless MCP implementations, in preference order. */
const QUERY_PARAMS = ['query', 'search', 'q', 'searchQuery', 'text', 'title'];
const LIMIT_PARAMS = ['limit', 'page_size', 'pageSize', 'count', 'max_results'];
const ID_PARAMS = ['id', 'documentId', 'document_id', 'doc_id', 'pk'];

/** Keys a document record may carry its own id under. */
const ID_KEYS = ['id', 'pk', 'document_id', 'documentId'];

/** Keys the extracted text may arrive under. */
const CONTENT_KEYS = ['content', 'text', 'ocr', 'plain_text'];

/**
 * Tool names that list the tag vocabulary, in preference order. Optional: used
 * only to turn tag ids into tag names, and skipped when the server offers none.
 */
const TAG_TOOLS = ['list_tags', 'get_tags', 'tags', 'list_all_tags'];

/**
 * Adapter for Paperless behind the existing Paperless MCP server.
 *
 * Everything Paperless-specific stops here: ids, tags, correspondents and OCR
 * text are mapped onto the abstract `InternalResource` model that a future DAV
 * source will produce as well. The gateway core above this file cannot tell the
 * difference, which is what keeps the source layer exchangeable.
 *
 * Response parsing is deliberately forgiving. The MCP server is a third-party
 * component that may wrap Paperless payloads in `results`, `documents` or a bare
 * array, and may or may not populate `structuredContent`.
 */
export class PaperlessSource implements PrivateSource {
    readonly id: string;
    readonly label: string;
    private readonly client: McpSourceClient;
    private readonly log: Logger;
    /** Tag id -> name, loaded on first use. Present but empty means "asked, none". */
    private tagNameCache?: Map<string, string>;

    constructor(private readonly config: SourceConfig, logger?: Logger) {
        this.id = config.id;
        this.label = config.label;
        this.log = (logger ?? createLogger('source')).child(config.id);
        this.client = new McpSourceClient(config.id, config.transport, logger);
    }

    async connect(): Promise<void> {
        await this.client.connect();
        for (const [purpose, toolName] of Object.entries(this.config.tools)) {
            if (!this.client.hasTool(toolName)) {
                // Not fatal: a server may only offer a subset, and search alone is
                // still useful. Surface it now rather than at approval time.
                this.log.warn('Konfiguriertes Werkzeug fehlt auf dem Quellserver', {
                    purpose,
                    configured: toolName,
                    available: this.client.tools()
                });
            }
        }
    }

    async close(): Promise<void> {
        await this.client.close();
    }

    isAvailable(): boolean {
        return this.client.isAvailable();
    }

    async search(query: string, limit: number): Promise<InternalResource[]> {
        const toolName = this.config.tools.search;
        const args: Record<string, unknown> = {};
        const queryParam = this.client.resolveParamName(toolName, QUERY_PARAMS);
        if (!queryParam) {
            throw new SourceUnavailableError(
                this.id,
                `Werkzeug ${toolName} deklariert keinen erkennbaren Suchparameter (${this.client
                    .paramNames(toolName)
                    .join(', ')}).`
            );
        }
        args[queryParam] = query;
        const limitParam = this.client.resolveParamName(toolName, LIMIT_PARAMS);
        if (limitParam) {
            args[limitParam] = Math.min(limit, this.config.maxCandidates);
        }

        const result = await this.client.callTool(toolName, args);
        const documents = extractDocuments(result).slice(0, Math.min(limit, this.config.maxCandidates));
        const detailed = await this.hydrate(documents);
        this.log.debug('Suche ausgeführt', { candidates: detailed.length });
        const tagNames = await this.tagNames();
        return detailed
            .map((document) => this.toInternalResource(document, tagNames))
            .filter((resource): resource is InternalResource => resource !== undefined);
    }

    /**
     * Fills the gaps a search result leaves, by re-reading every candidate
     * through the `get` tool.
     *
     * The search tool is a list endpoint: it answers "which documents match",
     * not "what is in them". In practice its records arrive uneven — one
     * candidate carries its OCR text, the next carries none, and tags come back
     * as bare ids where the list view never resolved them. Handing that straight
     * to the local model produced the failure this exists to prevent: a document
     * with no readable content was picked over one whose text named the very
     * thing that was searched for, because with nothing to read the only thing
     * left to match on was the title.
     *
     * Paperless holds the full record either way, so the gateway asks for it.
     * Bounded by `maxCandidates`, and a candidate whose detail call fails keeps
     * the fields the search gave it rather than dropping out of the list.
     */
    private async hydrate(
        documents: Array<Record<string, unknown>>
    ): Promise<Array<Record<string, unknown>>> {
        if (documents.length === 0 || !this.client.hasTool(this.config.tools.get)) {
            return documents;
        }
        return Promise.all(
            documents.map(async (document) => {
                const nativeId = firstString(document, ID_KEYS);
                if (!nativeId) {
                    return document;
                }
                try {
                    const detail = await this.getDocument(nativeId);
                    return detail ? mergeDocuments(document, detail) : document;
                } catch (error) {
                    // A single unreadable candidate must not hide the others.
                    this.log.warn('Kandidat konnte nicht nachgeladen werden', {
                        nativeId,
                        error: describeError(error)
                    });
                    return document;
                }
            })
        );
    }

    async fetchMetadata(nativeId: string): Promise<InternalResource | undefined> {
        let document: Record<string, unknown> | undefined;
        try {
            document = await this.getDocument(nativeId);
        } catch (error) {
            if (error instanceof SourceUnavailableError) {
                throw error;
            }
            this.log.warn('Metadaten konnten nicht gelesen werden', {
                nativeId,
                error: describeError(error)
            });
            return undefined;
        }
        if (!document) {
            return undefined;
        }
        return this.toInternalResource(document, await this.tagNames());
    }

    /** The raw document record behind one id, as the `get` tool returned it. */
    private async getDocument(nativeId: string): Promise<Record<string, unknown> | undefined> {
        const toolName = this.config.tools.get;
        const idParam = this.client.resolveParamName(toolName, ID_PARAMS) ?? 'id';
        const result: McpToolResult = await this.client.callTool(toolName, {
            [idParam]: coerceId(nativeId)
        });
        return extractDocuments(result)[0];
    }

    async fetchOriginal(nativeId: string): Promise<SourceFile> {
        const toolName = this.config.tools.download;
        const idParam = this.client.resolveParamName(toolName, ID_PARAMS) ?? 'id';
        const result = await this.client.callTool(toolName, { [idParam]: coerceId(nativeId) });
        const binary = binaryOf(result);
        if (!binary || binary.bytes.byteLength === 0) {
            throw new SourceResourceMissingError(
                `Quelle ${this.id} lieferte keine Dateidaten für ${nativeId}. Antwort: ${truncate(
                    textOf(result),
                    200
                )}`
            );
        }
        const metadata = await this.fetchMetadata(nativeId);
        const filename = pickFilename(metadata, binary.mimeType, nativeId);
        return {
            filename,
            mimeType: binary.mimeType ?? metadata?.mimeType ?? 'application/octet-stream',
            bytes: binary.bytes
        };
    }

    /**
     * The document's OCR text, for local summarising.
     *
     * Paperless already holds the extracted text, so this is the same `get` call
     * the metadata path uses — read at `summaryChars` rather than at the much
     * shorter `excerptChars`, because a summary is supposed to have seen the
     * document. Nothing here downloads the original: the bytes stay in Paperless
     * until an approved `send_resource` action asks for them.
     */
    async fetchText(nativeId: string): Promise<string | undefined> {
        const document = await this.getDocument(nativeId);
        if (!document) {
            return undefined;
        }
        const content = firstString(document, CONTENT_KEYS);
        if (!content) {
            return undefined;
        }
        const normalised = content.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
        if (normalised.length === 0) {
            return undefined;
        }
        return normalised.length <= this.config.summaryChars
            ? normalised
            : `${normalised.slice(0, this.config.summaryChars)}…`;
    }

    /**
     * Deep link into the Paperless web interface, for the local approval UI.
     *
     * Only produced for numeric ids, which is what Paperless uses: refusing
     * anything else means a value that arrived from the MCP server can never be
     * pasted into a URL the user is invited to click.
     */
    webUrl(nativeId: string): string | undefined {
        if (!this.config.webBaseUrl || !/^\d+$/.test(nativeId)) {
            return undefined;
        }
        return `${this.config.webBaseUrl.replace(/\/+$/, '')}/documents/${nativeId}/details`;
    }

    /**
     * The tag vocabulary as id -> name, loaded once and kept.
     *
     * Paperless list responses name some tags and leave others as ids, and an id
     * is not information: shown in the approval view it is noise, and put in
     * front of the local model it is worse than noise, because "Schlagwörter:
     * Altklausur, 9, 1" reads like classification while saying nothing. With a
     * tag tool the ids become names; without one they are dropped.
     *
     * Failure is not fatal and not retried — tags enrich a judgement, they do
     * not carry it, and a source that cannot list tags is still usable.
     */
    private async tagNames(): Promise<Map<string, string>> {
        if (this.tagNameCache) {
            return this.tagNameCache;
        }
        const names = new Map<string, string>();
        this.tagNameCache = names;
        const toolName = TAG_TOOLS.find((candidate) => this.client.hasTool(candidate));
        if (!toolName) {
            this.log.debug('Quellserver bietet kein Werkzeug zum Auflisten der Schlagwörter', {
                probed: TAG_TOOLS
            });
            return names;
        }
        try {
            const result = await this.client.callTool(toolName, {});
            for (const entry of collectDocuments(jsonOf(result))) {
                const id = firstString(entry, ['id', 'pk']);
                const name = typeof entry.name === 'string' ? entry.name.trim() : undefined;
                if (id && name && name.length > 0) {
                    names.set(id, name);
                }
            }
            this.log.debug('Schlagwörter geladen', { tool: toolName, count: names.size });
        } catch (error) {
            this.log.warn('Schlagwörter konnten nicht geladen werden', {
                tool: toolName,
                error: describeError(error)
            });
        }
        return names;
    }

    /** Maps a raw Paperless document object onto the abstract resource model. */
    private toInternalResource(
        document: Record<string, unknown>,
        tagNames: Map<string, string>
    ): InternalResource | undefined {
        const nativeId = firstString(document, ID_KEYS);
        if (!nativeId) {
            this.log.warn('Dokument ohne erkennbare Kennung übersprungen', {
                keys: Object.keys(document)
            });
            return undefined;
        }
        const title =
            firstString(document, ['title', 'name', 'original_file_name', 'originalFileName']) ??
            `Dokument ${nativeId}`;
        const created = firstString(document, ['created', 'created_date', 'createdDate', 'added']);
        const modified = firstString(document, ['modified', 'updated', 'modified_date']);
        const content = firstString(document, CONTENT_KEYS);

        const attributes: Record<string, string | string[]> = {};
        // A bare id where a name belongs is dropped rather than displayed: the
        // approval view and the model prompt are for things a person can read.
        const correspondent = namedValue(firstString(document, ['correspondent_name', 'correspondent']));
        if (correspondent) {
            attributes.Korrespondent = correspondent;
        }
        const documentType = namedValue(
            firstString(document, ['document_type_name', 'document_type', 'documentType'])
        );
        if (documentType) {
            attributes.Dokumenttyp = documentType;
        }
        const tags = extractTags(document, tagNames);
        if (tags.length > 0) {
            attributes.Schlagwörter = tags;
        }
        const archiveSerial = firstString(document, ['archive_serial_number', 'asn']);
        if (archiveSerial) {
            attributes['Archiv-Nr.'] = archiveSerial;
        }

        return {
            locator: { sourceId: this.id, nativeId },
            title,
            type: 'document',
            createdAt: created,
            modifiedAt: modified,
            mimeType: firstString(document, ['mime_type', 'mimeType', 'content_type']),
            byteSize: firstNumber(document, ['file_size', 'filesize', 'size', 'byte_size']),
            attributes: Object.keys(attributes).length > 0 ? attributes : undefined,
            excerpt: content ? truncate(content, this.config.excerptChars) : undefined,
            stateToken: stateTokenFor({ nativeId, modified, created, content, title })
        };
    }
}

/**
 * Version marker for change detection. Paperless does not expose an etag through
 * every MCP server, so this falls back through modified date, creation date and
 * finally a digest of title plus content. The fallback matters: without a state
 * token an approval could not be invalidated when the document changes
 * (invariant 12), so a weaker token is better than none.
 */
function stateTokenFor(parts: {
    nativeId: string;
    modified?: string;
    created?: string;
    content?: string;
    title: string;
}): string {
    if (parts.modified) {
        return `modified:${parts.modified}`;
    }
    return `digest:${sha256Text(
        `${parts.nativeId}|${parts.created ?? ''}|${parts.title}|${parts.content ?? ''}`
    ).slice(0, 32)}`;
}

/** Pulls the document list out of whatever envelope the server used. */
function extractDocuments(result: McpToolResult): Array<Record<string, unknown>> {
    const payload = jsonOf(result);
    const found = collectDocuments(payload);
    return found;
}

function collectDocuments(payload: unknown): Array<Record<string, unknown>> {
    if (Array.isArray(payload)) {
        return payload.filter(isRecord);
    }
    if (!isRecord(payload)) {
        return [];
    }
    for (const key of ['results', 'documents', 'items', 'data', 'document', 'hits']) {
        const nested = payload[key];
        if (nested !== undefined) {
            const collected = collectDocuments(nested);
            if (collected.length > 0) {
                return collected;
            }
        }
    }
    // A single document object returned directly.
    if ('id' in payload || 'pk' in payload || 'title' in payload) {
        return [payload];
    }
    return [];
}

/**
 * Merges a detail record over a search record, field by field.
 *
 * Detail wins, but only where it actually says something: a `get` response that
 * omits a field, or answers it with an empty string or an empty array, must not
 * erase what the search already knew. That asymmetry is the whole point of
 * merging instead of replacing.
 */
function mergeDocuments(
    base: Record<string, unknown>,
    detail: Record<string, unknown>
): Record<string, unknown> {
    const merged: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(detail)) {
        if (value === undefined || value === null) {
            continue;
        }
        if (typeof value === 'string' && value.trim().length === 0) {
            continue;
        }
        if (Array.isArray(value) && value.length === 0) {
            continue;
        }
        merged[key] = value;
    }
    return merged;
}

/**
 * Tag names for a document, with ids resolved where possible.
 *
 * Entries arrive as names, as objects carrying one, or as bare ids the list
 * endpoint never resolved. The first two are taken as they are; an id is looked
 * up and, if the vocabulary does not know it, left out.
 */
function extractTags(document: Record<string, unknown>, tagNames: Map<string, string>): string[] {
    // `tag_names` is a list of names by construction, so a numeric entry there is
    // a tag genuinely called "2024". Only the `tags` list mixes names with ids.
    for (const key of ['tag_names', 'tagNames']) {
        const value = document[key];
        if (Array.isArray(value)) {
            return cleanTags(value.map((entry) => (typeof entry === 'string' ? entry : undefined)));
        }
    }
    const tags = document.tags;
    if (!Array.isArray(tags)) {
        return [];
    }
    return cleanTags(
        tags.map((entry) => {
            if (isRecord(entry)) {
                return typeof entry.name === 'string'
                    ? entry.name
                    : tagNames.get(String(entry.id ?? entry.pk ?? ''));
            }
            if (typeof entry === 'number') {
                return tagNames.get(String(entry));
            }
            if (typeof entry !== 'string') {
                return undefined;
            }
            return /^\d+$/.test(entry.trim()) ? tagNames.get(entry.trim()) : entry;
        })
    );
}

function cleanTags(entries: Array<string | undefined>): string[] {
    return entries
        .map((entry) => entry?.trim())
        .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

/**
 * Keeps a value only if it reads as a name. A purely numeric correspondent or
 * document type is an unresolved foreign key, and showing it as a characteristic
 * of the document would be inventing a fact.
 */
function namedValue(value: string | undefined): string | undefined {
    if (!value) {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 && !/^\d+$/.test(trimmed) ? trimmed : undefined;
}

function pickFilename(
    metadata: InternalResource | undefined,
    mimeType: string | undefined,
    nativeId: string
): string {
    const base = metadata?.title?.trim();
    const safeBase = (base && base.length > 0 ? base : `dokument-${nativeId}`)
        // Strip anything that could traverse a path or confuse a mail client.
        .replace(/[\\/:*?"<>|\r\n]+/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
    const extension = extensionFor(mimeType ?? metadata?.mimeType);
    return safeBase.toLowerCase().endsWith(extension) ? safeBase : `${safeBase}${extension}`;
}

function extensionFor(mimeType: string | undefined): string {
    switch (mimeType) {
        case 'application/pdf':
            return '.pdf';
        case 'image/png':
            return '.png';
        case 'image/jpeg':
            return '.jpg';
        case 'image/tiff':
            return '.tiff';
        case 'text/plain':
            return '.txt';
        default:
            return '.bin';
    }
}

/** Paperless ids are numeric; MCP servers accept either but prefer numbers. */
function coerceId(nativeId: string): string | number {
    return /^\d+$/.test(nativeId) ? Number(nativeId) : nativeId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'string' && value.trim().length > 0) {
            return value;
        }
        if (typeof value === 'number' && Number.isFinite(value)) {
            return String(value);
        }
        if (isRecord(value) && typeof value.name === 'string') {
            return value.name;
        }
    }
    return undefined;
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'number' && Number.isFinite(value)) {
            return value;
        }
        if (typeof value === 'string' && /^\d+$/.test(value)) {
            return Number(value);
        }
    }
    return undefined;
}

function truncate(text: string, limit: number): string {
    const normalised = text.replace(/\s+/g, ' ').trim();
    return normalised.length <= limit ? normalised : `${normalised.slice(0, limit)}…`;
}

export { extractDocuments as __extractDocumentsForTest };
