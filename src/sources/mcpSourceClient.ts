import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { SourceTransportConfig } from '../config.js';
import { SourceUnavailableError } from './source.js';
import { createLogger, describeError, type Logger } from '../util/log.js';

/**
 * MCP client used to talk to an internal source server, e.g. the existing
 * Paperless MCP server.
 *
 * This client sits entirely on the private side of the boundary. The tools it
 * discovers are never re-exported: the gateway calls them itself and hands only
 * abstracted results outwards (invariant 2). The wrapper exists so a source
 * adapter can call `callTool` without caring whether the server is a child
 * process on this machine or an already running HTTP endpoint.
 */
export class McpSourceClient {
    private client?: Client;
    private transport?: Transport;
    private available = false;
    private discoveredTools: string[] = [];
    private readonly toolInputProperties = new Map<string, string[]>();
    private readonly log: Logger;

    constructor(
        private readonly sourceId: string,
        private readonly config: SourceTransportConfig,
        logger?: Logger
    ) {
        this.log = (logger ?? createLogger('source')).child(sourceId);
    }

    async connect(): Promise<void> {
        this.transport = this.createTransport();
        this.client = new Client(
            { name: 'local-trust-gateway', version: '0.1.0' },
            { capabilities: {} }
        );
        try {
            await this.client.connect(this.transport);
            const tools = await this.client.listTools();
            this.discoveredTools = tools.tools.map((tool) => tool.name);
            this.toolInputProperties.clear();
            for (const tool of tools.tools) {
                const properties = (tool.inputSchema as { properties?: Record<string, unknown> } | undefined)
                    ?.properties;
                this.toolInputProperties.set(tool.name, properties ? Object.keys(properties) : []);
            }
            this.available = true;
            this.log.info('Quelle verbunden', {
                transport: this.config.kind,
                tools: this.discoveredTools
            });
        } catch (error) {
            this.available = false;
            throw new SourceUnavailableError(
                this.sourceId,
                `Verbindung zur Quelle ${this.sourceId} fehlgeschlagen: ${describeError(error)}`
            );
        }
    }

    private createTransport(): Transport {
        if (this.config.kind === 'stdio') {
            return new StdioClientTransport({
                command: this.config.command,
                args: this.config.args,
                // The child process inherits only a vetted baseline plus the
                // variables this source explicitly needs, so unrelated secrets in
                // the gateway's environment are not handed to a third-party server.
                env: { ...getDefaultEnvironment(), ...this.config.env },
                cwd: this.config.cwd,
                stderr: 'pipe'
            });
        }
        const headers: Record<string, string> = { ...this.config.headers };
        if (this.config.bearerToken) {
            headers.Authorization = `Bearer ${this.config.bearerToken}`;
        }
        return new StreamableHTTPClientTransport(new URL(this.config.url), {
            requestInit: { headers }
        });
    }

    async close(): Promise<void> {
        this.available = false;
        try {
            await this.client?.close();
        } catch (error) {
            this.log.warn('Fehler beim Schließen der Quellverbindung', { error: describeError(error) });
        }
        this.client = undefined;
        this.transport = undefined;
    }

    isAvailable(): boolean {
        return this.available;
    }

    /** Names of the tools the source server offers. Local diagnostics only. */
    tools(): string[] {
        return [...this.discoveredTools];
    }

    hasTool(name: string): boolean {
        return this.discoveredTools.includes(name);
    }

    /**
     * Picks the first of `candidates` that the tool actually declares as an input
     * property. The Paperless MCP server is a third-party component, so its
     * parameter names are discovered rather than assumed; when a server ships no
     * input schema the first candidate is used as the documented default.
     */
    resolveParamName(toolName: string, candidates: string[]): string | undefined {
        const declared = this.toolInputProperties.get(toolName);
        if (!declared || declared.length === 0) {
            return candidates[0];
        }
        return candidates.find((candidate) => declared.includes(candidate));
    }

    /** Input property names a tool declares. Local diagnostics only. */
    paramNames(toolName: string): string[] {
        return [...(this.toolInputProperties.get(toolName) ?? [])];
    }

    /**
     * Invokes a source tool and returns the raw MCP result. Transport failures
     * flip the availability flag so the orchestrator can report
     * `source_unavailable` instead of retrying blindly.
     */
    async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
        if (!this.client) {
            throw new SourceUnavailableError(this.sourceId, `Quelle ${this.sourceId} ist nicht verbunden.`);
        }
        if (this.discoveredTools.length > 0 && !this.hasTool(name)) {
            throw new SourceUnavailableError(
                this.sourceId,
                `Quelle ${this.sourceId} kennt das Werkzeug ${name} nicht. Verfügbar: ${this.discoveredTools.join(', ')}`
            );
        }
        let result: unknown;
        try {
            result = await this.client.callTool({ name, arguments: args });
        } catch (error) {
            this.available = false;
            throw new SourceUnavailableError(
                this.sourceId,
                `Aufruf von ${name} an Quelle ${this.sourceId} fehlgeschlagen: ${describeError(error)}`
            );
        }
        const typed = result as McpToolResult;
        if (typed.isError) {
            // A tool-level error means the server answered, so the source itself
            // is still up; this is a per-call failure.
            throw new SourceToolError(`Werkzeug ${name} meldete einen Fehler: ${textOf(typed)}`);
        }
        this.available = true;
        return typed;
    }
}

export class SourceToolError extends Error {}

export interface McpToolResult {
    content?: Array<Record<string, unknown>>;
    structuredContent?: unknown;
    isError?: boolean;
}

/** Concatenates all text parts of a tool result. */
export function textOf(result: McpToolResult): string {
    return (result.content ?? [])
        .filter((part) => part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text as string)
        .join('\n');
}

/**
 * Extracts a structured payload from a tool result.
 *
 * MCP servers written by different people disagree about where JSON belongs:
 * some populate `structuredContent`, most stringify into a text part. Both are
 * accepted; anything else yields undefined so the caller can fall back to text.
 */
export function jsonOf(result: McpToolResult): unknown {
    if (result.structuredContent !== undefined && result.structuredContent !== null) {
        return result.structuredContent;
    }
    const text = textOf(result).trim();
    if (text.length === 0) {
        return undefined;
    }
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

/**
 * Extracts binary content from a tool result, accepting the shapes an MCP server
 * may use for a file: a `resource` part with a base64 `blob`, an image/audio
 * part with `data`, or a bare base64 text part.
 */
export function binaryOf(result: McpToolResult): { bytes: Uint8Array; mimeType?: string } | undefined {
    for (const part of result.content ?? []) {
        const resource = part.resource as Record<string, unknown> | undefined;
        if (part.type === 'resource' && resource && typeof resource.blob === 'string') {
            return {
                bytes: decodeBase64(resource.blob),
                mimeType: typeof resource.mimeType === 'string' ? resource.mimeType : undefined
            };
        }
        if (typeof part.data === 'string' && (part.type === 'image' || part.type === 'audio' || part.type === 'blob')) {
            return {
                bytes: decodeBase64(part.data),
                mimeType: typeof part.mimeType === 'string' ? part.mimeType : undefined
            };
        }
    }
    const structured = jsonOf(result);
    if (structured && typeof structured === 'object') {
        const record = structured as Record<string, unknown>;
        const base64 = record.content ?? record.data ?? record.blob ?? record.base64;
        if (typeof base64 === 'string') {
            return {
                bytes: decodeBase64(base64),
                mimeType: typeof record.mimeType === 'string' ? record.mimeType : undefined
            };
        }
    }
    return undefined;
}

function decodeBase64(value: string): Uint8Array {
    // Tolerate data URIs, which some servers return instead of raw base64.
    const payload = value.startsWith('data:') ? value.slice(value.indexOf(',') + 1) : value;
    return new Uint8Array(Buffer.from(payload, 'base64'));
}
