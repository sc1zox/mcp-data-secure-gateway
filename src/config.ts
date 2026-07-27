import { readFileSync, existsSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { z } from 'zod';

/**
 * Configuration is local, explicit and closed.
 *
 * Two rules are enforced here rather than at call sites, because they are
 * security invariants and not preferences:
 *  - targets are a fixed list read from this file; a target can only ever
 *    reach the destinations this file allows for it — for most targets that
 *    means one fixed recipient, and `allowDynamicRecipient` is the one
 *    explicit, per-target opt-in that lets an action name a destination
 *    within that target, always subject to local approval of the exact
 *    address shown (invariant 6),
 *  - the local model has no remote alternative; there is no field for one
 *    (invariant 10).
 */

const stdioSourceTransport = z.object({
    kind: z.literal('stdio'),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    /** Extra environment for the child process, e.g. the Paperless API token. */
    env: z.record(z.string()).default({}),
    cwd: z.string().optional()
});

const httpSourceTransport = z.object({
    kind: z.literal('http'),
    /** Streamable-HTTP endpoint of an already running MCP server. */
    url: z.string().url(),
    /** Sent as `Authorization: Bearer <token>` if present. */
    bearerToken: z.string().optional(),
    headers: z.record(z.string()).default({})
});

const sourceTransport = z.discriminatedUnion('kind', [stdioSourceTransport, httpSourceTransport]);

const paperlessSourceSchema = z.object({
    id: z.literal('paperless'),
    kind: z.literal('paperless-mcp'),
    label: z.string().default('Paperless'),
    enabled: z.boolean().default(true),
    transport: sourceTransport,
    /**
     * Tool names on the Paperless MCP server. Overridable because the existing
     * server is not ours and may name its tools differently.
     */
    tools: z
        .object({
            search: z.string().default('search_documents'),
            get: z.string().default('get_document'),
            download: z.string().default('download_document')
        })
        .default({}),
    /**
     * Base URL of the Paperless web interface, e.g. `https://paperless.lan`.
     *
     * Purely a convenience for the local approval UI: with it set, a candidate
     * or a prepared action gets a link that opens the real document in
     * Paperless, so the user can look at the thing itself instead of deciding
     * from a title and an excerpt. Optional, and local-only — the egress guard
     * refuses any payload towards Hermes that contains a URL at all.
     */
    webBaseUrl: z.string().url().optional(),
    /** Upper bound on candidates pulled from the source per search. */
    maxCandidates: z.number().int().min(1).max(50).default(8),
    /** How much text per candidate is handed to the local model. */
    excerptChars: z.number().int().min(200).max(20000).default(2500),
    /**
     * How much document text the local model sees when writing a redacted
     * summary. Larger than `excerptChars` on purpose — telling candidates apart
     * needs a glance, summarising needs the document — and still bounded, both
     * by the model's context window and because an unbounded prompt is an
     * unbounded local runtime.
     */
    summaryChars: z.number().int().min(1000).max(200000).default(20000)
});

const localModelSchema = z.object({
    /** Base URL of the existing Ollama-compatible endpoint. */
    baseUrl: z.string().url(),
    model: z.string().min(1),
    /** Optional bearer token if the endpoint sits behind auth. */
    bearerToken: z.string().optional(),
    requestTimeoutMs: z.number().int().min(1000).max(600000).default(120000),
    /** Deterministic judgements are easier to audit. */
    temperature: z.number().min(0).max(2).default(0),
    /** Context window to request from the runtime. */
    numCtx: z.number().int().min(2048).max(131072).default(16384)
});

const mailTargetSchema = z.object({
    /**
     * No longer a single fixed literal: `allowDynamicRecipient` lets more than
     * one SMTP target exist side by side (e.g. `private_mail` fixed,
     * `job_application_mail` dynamic), each with its own id.
     */
    id: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[a-z][a-z0-9_]*$/, 'id muss klein geschrieben sein und darf nur a-z, 0-9 und _ enthalten.'),
    kind: z.literal('smtp'),
    enabled: z.boolean().default(true),
    label: z.string().default('Private E-Mail'),
    purpose: z.string().default('Versand an das eigene private E-Mail-Postfach.'),
    smtp: z.object({
        host: z.string().min(1),
        port: z.number().int().min(1).max(65535).default(587),
        secure: z.boolean().default(false),
        user: z.string().min(1),
        password: z.string().min(1)
    }),
    from: z.string().email(),
    /**
     * The recipient, fixed at config time. Required unless
     * `allowDynamicRecipient` is set — in that case there is no fixed address
     * at all and the recipient comes from the approved action instead.
     */
    to: z.string().email().optional(),
    /**
     * Opt-in only: lets `prepare_action` name a recipient for this target
     * specifically (e.g. varying job-application addresses). The address is
     * never used without being shown, in full and unmasked, in the local
     * approval view first — see invariant 6. Leave this false for anything
     * that should stay a truly fixed destination.
     */
    allowDynamicRecipient: z.boolean().default(false),
    /** Per-message attachment count limit. Enforced before any originals are read. */
    maxAttachments: z.number().int().min(1).max(50).default(10),
    maxAttachmentBytes: z
        .number()
        .int()
        .min(1)
        // A 20 MiB SMTP message limit applies after base64 and MIME framing.
        // floor((20 MiB - 1 MiB) / 1.37) leaves conservative headroom.
        .default(14_542_294)
});

const telegramTargetSchema = z.object({
    id: z.literal('private_telegram'),
    kind: z.literal('telegram'),
    enabled: z.boolean().default(true),
    label: z.string().default('Privater Telegram-Chat'),
    purpose: z.string().default('Versand in den eigenen privaten Telegram-Chat.'),
    botToken: z.string().min(1),
    /** The one and only chat. Not overridable at runtime. */
    chatId: z.string().min(1),
    apiBaseUrl: z.string().url().default('https://api.telegram.org'),
    maxAttachments: z.number().int().min(1).max(50).default(10),
    maxAttachmentBytes: z
        .number()
        .int()
        .min(1)
        .default(50 * 1024 * 1024)
});

const targetSchema = z.discriminatedUnion('kind', [mailTargetSchema, telegramTargetSchema]);

const approvalSchema = z.object({
    /** Loopback only by default: the approval UI is not a network service. */
    host: z.string().default('127.0.0.1'),
    port: z.number().int().min(1).max(65535).default(8787),
    /**
     * Shared secret for the local UI. Generated on first start if absent and
     * written to the data directory, so the URL alone is not enough.
     */
    uiToken: z.string().optional(),
    /** Prepared actions die if nobody decides within this window. */
    actionTtlSeconds: z.number().int().min(60).max(86400).default(1800),
    /** References expire independently; a stale ref cannot be revived. */
    referenceTtlSeconds: z.number().int().min(60).max(86400).default(3600),
    /** Pending selections expire too. */
    selectionTtlSeconds: z.number().int().min(60).max(86400).default(1800)
});

const hermesInterfaceSchema = z.object({
    /** stdio when Hermes spawns the gateway; http when it connects over the network. */
    transport: z.enum(['stdio', 'http', 'both']).default('stdio'),
    http: z
        .object({
            host: z.string().default('127.0.0.1'),
            port: z.number().int().min(1).max(65535).default(8788),
            path: z.string().default('/mcp'),
            /**
             * Required for the HTTP transport. Without it the gateway refuses to
             * listen: an unauthenticated MCP endpoint is an open door to the
             * whole private-source surface.
             */
            bearerToken: z.string().optional(),
            /** Host header allow-list, checked before the MCP layer sees the request. */
            allowedHosts: z.array(z.string()).default([])
        })
        .default({})
});

export const configSchema = z.object({
    /** Where reference store, action store and audit log live. */
    dataDir: z.string().default('./data'),
    logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    sources: z.array(paperlessSourceSchema).min(1),
    localModel: localModelSchema,
    targets: z.array(targetSchema).min(1),
    approval: approvalSchema.default({}),
    hermesInterface: hermesInterfaceSchema.default({})
});

export type GatewayConfig = z.infer<typeof configSchema>;
export type SourceConfig = z.infer<typeof paperlessSourceSchema>;
export type TargetConfig = z.infer<typeof targetSchema>;
export type MailTargetConfig = z.infer<typeof mailTargetSchema>;
export type TelegramTargetConfig = z.infer<typeof telegramTargetSchema>;
export type LocalModelConfig = z.infer<typeof localModelSchema>;
export type SourceTransportConfig = z.infer<typeof sourceTransport>;

export class ConfigError extends Error {}

/**
 * Substitutes `${ENV_VAR}` placeholders so secrets can stay in the environment
 * instead of the config file. An unset variable is an error rather than an
 * empty string, because a silently empty SMTP password would surface as a
 * confusing delivery failure much later.
 */
function expandEnv(value: unknown, path: string[] = []): unknown {
    if (typeof value === 'string') {
        return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
            const resolved = process.env[name];
            if (resolved === undefined) {
                throw new ConfigError(
                    `Umgebungsvariable ${name} ist nicht gesetzt (verwendet in ${path.join('.') || 'config'}).`
                );
            }
            return resolved;
        });
    }
    if (Array.isArray(value)) {
        return value.map((item, index) => expandEnv(item, [...path, String(index)]));
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>).map(([key, item]) => [
                key,
                expandEnv(item, [...path, key])
            ])
        );
    }
    return value;
}

export function parseConfig(raw: unknown): GatewayConfig {
    const expanded = expandEnv(raw);
    const result = configSchema.safeParse(expanded);
    if (!result.success) {
        const issues = result.error.issues
            .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
            .join('\n');
        throw new ConfigError(`Konfiguration ist ungültig:\n${issues}`);
    }
    const config = result.data;

    if (config.hermesInterface.transport !== 'stdio' && !config.hermesInterface.http.bearerToken) {
        throw new ConfigError(
            'hermesInterface.http.bearerToken ist zwingend erforderlich, wenn der HTTP-Transport aktiv ist.'
        );
    }
    if (config.targets.filter((target) => target.enabled).length === 0) {
        throw new ConfigError('Mindestens ein Ziel muss aktiviert sein.');
    }
    for (const target of config.targets) {
        if (target.kind === 'smtp' && !target.allowDynamicRecipient && !target.to) {
            throw new ConfigError(
                `Ziel ${target.id}: 'to' ist erforderlich, solange allowDynamicRecipient nicht gesetzt ist.`
            );
        }
    }
    if (config.sources.filter((source) => source.enabled).length === 0) {
        throw new ConfigError('Mindestens eine Quelle muss aktiviert sein.');
    }
    return config;
}

export function resolveConfigPath(explicitPath?: string): string {
    const candidates = [
        explicitPath,
        process.env.GATEWAY_CONFIG,
        resolve(process.cwd(), 'config/gateway.config.json')
    ].filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0);

    for (const candidate of candidates) {
        const absolute = isAbsolute(candidate) ? candidate : resolve(process.cwd(), candidate);
        if (existsSync(absolute)) {
            return absolute;
        }
    }
    throw new ConfigError(
        `Keine Konfigurationsdatei gefunden. Geprüft: ${candidates.join(', ')}. ` +
            'Vorlage: config/gateway.config.example.json'
    );
}

export function loadConfig(explicitPath?: string): { config: GatewayConfig; path: string } {
    const path = resolveConfigPath(explicitPath);
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
        throw new ConfigError(
            `Konfigurationsdatei ${path} konnte nicht gelesen werden: ${
                error instanceof Error ? error.message : String(error)
            }`
        );
    }
    return { config: parseConfig(parsed), path };
}
