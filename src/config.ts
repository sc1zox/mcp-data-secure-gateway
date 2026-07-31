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
    /**
     * Maximum time without connection, headers or response bytes. This is not
     * a total inference deadline: every stream fragment resets the watchdog.
     */
    idleTimeoutMs: z.number().int().min(1000).max(3_600_000).default(300000),
    /** Deterministic judgements are easier to audit. */
    temperature: z.number().min(0).max(2).default(0),
    /** Context window to request from the runtime. */
    numCtx: z.number().int().min(2048).max(131072).default(16384),
    /** Whether reasoning/thinking output is requested from the model. Defaults to false. */
    think: z.boolean().default(false),
    /** Maximum tokens to generate per response. Defaults to 384. */
    numPredict: z.number().int().min(1).max(8192).default(384),
    /** Keep alive duration for Ollama model in memory. Defaults to 30m. */
    keepAlive: z.string().default('30m')
});

/**
 * What a single target is allowed to have done to its oversized attachments.
 *
 * Defaults to `disabled` on purpose: adding this feature must not change what
 * an existing configuration does. A target only starts transforming anything
 * once someone writes `mode` into its config, and `disabled` keeps the plan's
 * `optimization` field absent, which keeps its binding hash unchanged.
 */
const targetOptimizationSchema = z
    .object({
        /**
         * `balanced` permits lossless restructuring and the moderate rung.
         * `compact` additionally permits the aggressive one — never silently:
         * this is the ceiling the user approves along with the action.
         */
        mode: z.enum(['disabled', 'balanced', 'compact']).default('disabled'),
        pdf: z.boolean().default(true),
        jpeg: z.boolean().default(true)
    })
    .default({});

/**
 * Engine-side settings shared by every target: what the gateway may spend on
 * itself while optimizing, and which tools it uses to do it. Kept apart from
 * the per-target block because these bound the local process, whereas the
 * target block bounds what the user consented to.
 */
const attachmentOptimizationSchema = z
    .object({
        enabled: z.boolean().default(true),
        limits: z
            .object({
                maxSingleInputBytes: z.number().int().min(1).default(52_428_800),
                maxTotalInputBytes: z.number().int().min(1).default(104_857_600),
                maxWorkingBytes: z.number().int().min(1).default(314_572_800),
                timeBudgetMs: z.number().int().min(1000).max(600_000).default(30_000)
            })
            .default({}),
        execution: z
            .object({
                /** Ghostscript is memory-hungry; one at a time by default. */
                maxConcurrentPdfJobs: z.number().int().min(1).max(8).default(1),
                maxConcurrentJpegJobs: z.number().int().min(1).max(8).default(2)
            })
            .default({}),
        pdf: z
            .object({
                enabled: z.boolean().default(true),
                /** The lossless qpdf rung. Cheap, so on by default. */
                qpdfStructuralOptimization: z.boolean().default(true),
                /**
                 * Whether `qpdf --check` warnings (exit 3) disqualify a
                 * derivative. Structural errors (exit 2) always do, regardless.
                 * Off by default because exit 2 is the code that means
                 * "broken"; how often real Ghostscript output lands on 3 is
                 * unmeasured and belongs to the profile calibration.
                 */
                rejectOnWarnings: z.boolean().default(false),
                /** Ghostscript rungs the engine offers at all. */
                profiles: z
                    .array(z.enum(['balanced', 'compact']))
                    .default(['balanced', 'compact']),
                qpdfCommand: z.string().min(1).default('qpdf'),
                ghostscriptCommand: z.string().min(1).default('gs')
            })
            .default({}),
        jpeg: z
            .object({
                enabled: z.boolean().default(true),
                /** Decode-bomb guard: a tiny file can declare huge dimensions. */
                maxPixels: z.number().int().min(1).default(80_000_000),
                maxChannels: z.number().int().min(1).max(4).default(4),
                profiles: z
                    .array(z.enum(['balanced', 'compact']))
                    .default(['balanced', 'compact'])
            })
            .default({})
    })
    .default({});

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
        .default(14_542_294),
    optimization: targetOptimizationSchema
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
        .default(50 * 1024 * 1024),
    optimization: targetOptimizationSchema
});

const targetSchema = z.discriminatedUnion('kind', [mailTargetSchema, telegramTargetSchema]);

const requiredLocalSecret = z
    .string()
    .min(32)
    .max(1024)
    .refine((value) => value === value.trim(), 'Secret darf keine äußeren Leerzeichen enthalten.');

const approvalSchema = z.object({
    /** Loopback only by default: the approval UI is not a network service. */
    host: z.string().default('127.0.0.1'),
    port: z.number().int().min(1).max(65535).default(8787),
    /** Shared secret for the local UI, supplied through an environment placeholder. */
    uiToken: requiredLocalSecret,
    /** Prepared actions die if nobody decides within this window. */
    actionTtlSeconds: z.number().int().min(60).max(86400).default(1800),
    /** References expire independently; a stale ref cannot be revived. */
    referenceTtlSeconds: z.number().int().min(60).max(86400).default(3600),
    /** Pending selections expire too. */
    selectionTtlSeconds: z.number().int().min(60).max(86400).default(1800),
    /**
     * How many actions may await a decision at once.
     *
     * Not a performance knob. The realistic attack on a human gate is volume:
     * a queue nobody can read carefully is a queue that gets waved through, so
     * the queue is kept short enough to stay readable.
     */
    maxOpenActions: z.number().int().min(1).max(100).default(5),
    /** Actions the agent may have prepared inside `rateLimitWindowSeconds`. */
    maxPreparedPerWindow: z.number().int().min(1).max(1000).default(10),
    rateLimitWindowSeconds: z.number().int().min(10).max(86400).default(600)
});

/**
 * How much of the local trail is kept.
 *
 * Both bounds apply and whichever bites first wins. A trail that grows without
 * end is not a stronger record, it is an unmanaged store of who the user deals
 * with — the retention window is what keeps invariant 14 ("alles lokal
 * nachvollziehbar") from turning into "alles dauerhaft gesammelt".
 */
const auditSchema = z.object({
    /** Entries older than this are dropped on startup and during housekeeping. */
    retentionDays: z.number().int().min(1).max(3650).default(90),
    /** Hard ceiling on the number of entries, applied after the age window. */
    maxEntries: z.number().int().min(100).max(1_000_000).default(50_000)
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
    approval: approvalSchema,
    audit: auditSchema.default({}),
    hermesInterface: hermesInterfaceSchema.default({}),
    attachmentOptimization: attachmentOptimizationSchema
});

export type GatewayConfig = z.infer<typeof configSchema>;
export type SourceConfig = z.infer<typeof paperlessSourceSchema>;
export type TargetConfig = z.infer<typeof targetSchema>;
export type MailTargetConfig = z.infer<typeof mailTargetSchema>;
export type TelegramTargetConfig = z.infer<typeof telegramTargetSchema>;
export type AttachmentOptimizationConfig = z.infer<typeof attachmentOptimizationSchema>;
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
    if (
        raw &&
        typeof raw === 'object' &&
        !Array.isArray(raw) &&
        'localModel' in raw
    ) {
        const localModel = (raw as { localModel?: unknown }).localModel;
        if (
            localModel &&
            typeof localModel === 'object' &&
            !Array.isArray(localModel) &&
            'requestTimeoutMs' in localModel
        ) {
            throw new ConfigError(
                'localModel.requestTimeoutMs wird nicht mehr unterstützt; ersetzen Sie es durch localModel.idleTimeoutMs.'
            );
        }
    }
    const expanded = expandEnv(raw);
    const result = configSchema.safeParse(expanded);
    if (!result.success) {
        const issues = result.error.issues
            .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
            .join('\n');
        throw new ConfigError(`Konfiguration ist ungültig:\n${issues}`);
    }
    const config = result.data;

    // Not a matter of taste: `numPredict` tokens are reserved out of the same
    // window the prompt has to fit into, so a budget at or above `numCtx`
    // leaves no room for a prompt at all and every judgement fails at runtime.
    if (config.localModel.numPredict >= config.localModel.numCtx) {
        throw new ConfigError(
            `localModel.numPredict (${config.localModel.numPredict}) muss kleiner als ` +
                `localModel.numCtx (${config.localModel.numCtx}) sein; sonst bleibt kein ` +
                'Platz für den Prompt.'
        );
    }
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
    // A target that promises optimization while the engine is switched off would
    // bind a policy into every approval that nothing can ever honour, and then
    // fail every oversized send with a misleading reason.
    const optimizingTargets = config.targets.filter(
        (target) => target.enabled && target.optimization.mode !== 'disabled'
    );
    if (!config.attachmentOptimization.enabled && optimizingTargets.length > 0) {
        throw new ConfigError(
            `attachmentOptimization.enabled ist false, aber folgende Ziele fordern eine Optimierung an: ` +
                `${optimizingTargets.map((target) => target.id).join(', ')}.`
        );
    }
    const { limits } = config.attachmentOptimization;
    if (limits.maxSingleInputBytes > limits.maxTotalInputBytes) {
        throw new ConfigError(
            `attachmentOptimization.limits.maxSingleInputBytes (${limits.maxSingleInputBytes}) darf ` +
                `maxTotalInputBytes (${limits.maxTotalInputBytes}) nicht überschreiten.`
        );
    }
    if (limits.maxTotalInputBytes > limits.maxWorkingBytes) {
        throw new ConfigError(
            `attachmentOptimization.limits.maxTotalInputBytes (${limits.maxTotalInputBytes}) darf ` +
                `maxWorkingBytes (${limits.maxWorkingBytes}) nicht überschreiten.`
        );
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
