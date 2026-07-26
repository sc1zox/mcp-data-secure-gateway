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
        const documents = extractDocuments(result);
        this.log.debug('Suche ausgeführt', { candidates: documents.length });
        return documents
            .slice(0, Math.min(limit, this.config.maxCandidates))
            .map((document) => this.toInternalResource(document))
            .filter((resource): resource is InternalResource => resource !== undefined);
    }

    async fetchMetadata(nativeId: string): Promise<InternalResource | undefined> {
        const toolName = this.config.tools.get;
        const idParam = this.client.resolveParamName(toolName, ID_PARAMS) ?? 'id';
        let result: McpToolResult;
        try {
            result = await this.client.callTool(toolName, { [idParam]: coerceId(nativeId) });
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
        const documents = extractDocuments(result);
        const document = documents[0];
        if (!document) {
            return undefined;
        }
        return this.toInternalResource(document);
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

    /** Maps a raw Paperless document object onto the abstract resource model. */
    private toInternalResource(document: Record<string, unknown>): InternalResource | undefined {
        const nativeId = firstString(document, ['id', 'pk', 'document_id', 'documentId']);
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
        const content = firstString(document, ['content', 'text', 'ocr', 'plain_text']);

        const attributes: Record<string, string | string[]> = {};
        const correspondent = firstString(document, ['correspondent_name', 'correspondent']);
        if (correspondent) {
            attributes.Korrespondent = correspondent;
        }
        const documentType = firstString(document, ['document_type_name', 'document_type', 'documentType']);
        if (documentType) {
            attributes.Dokumenttyp = documentType;
        }
        const tags = extractTags(document);
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

function extractTags(document: Record<string, unknown>): string[] {
    for (const key of ['tag_names', 'tagNames', 'tags']) {
        const value = document[key];
        if (Array.isArray(value)) {
            return value
                .map((entry) => {
                    if (typeof entry === 'string') {
                        return entry;
                    }
                    if (isRecord(entry) && typeof entry.name === 'string') {
                        return entry.name;
                    }
                    return undefined;
                })
                .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
        }
    }
    return [];
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
