import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { ApprovalServer } from './approval/server.js';
import { ConfigError, loadConfig, type GatewayConfig } from './config.js';
import { EgressGuard } from './core/egress.js';
import { Orchestrator } from './core/orchestrator.js';
import { Judge } from './judge/judge.js';
import { OllamaClient } from './judge/ollamaClient.js';
import { createHermesServer, serveHttp, serveStdio } from './mcp/hermesServer.js';
import { SourceRegistry } from './sources/registry.js';
import { TargetRegistry } from './targets/registry.js';
import { AuditLog } from './store/auditLog.js';
import { ActionStore } from './store/actionStore.js';
import { ReferenceStore } from './store/referenceStore.js';
import { SelectionStore } from './store/selectionStore.js';
import { createLogger, describeError, setLogLevel } from './util/log.js';

const SWEEP_INTERVAL_MS = 30_000;

/**
 * Boots the Local Trust Gateway.
 *
 * Startup order matters: the audit log opens first so that any later failure is
 * itself recorded, the egress guard learns the configured secrets before any
 * request can be served, and the Hermes-facing interface is the last thing
 * enabled — the gateway does not accept requests before its local side is ready
 * to gate them.
 */
async function main(): Promise<void> {
    const log = createLogger('gateway');
    const { config, path: configPath } = loadConfig(process.argv[2]);
    setLogLevel(config.logLevel);
    log.info('Konfiguration geladen', { configPath });

    const dataDir = isAbsolute(config.dataDir) ? config.dataDir : resolve(process.cwd(), config.dataDir);
    await mkdir(dataDir, { recursive: true });

    const audit = new AuditLog(join(dataDir, 'audit.jsonl'));
    await audit.init();

    // Register every secret before anything can be serialised outwards.
    const guard = new EgressGuard();
    registerSecrets(guard, config);

    const references = new ReferenceStore(dataDir, audit);
    const actions = new ActionStore(dataDir, audit);
    const selections = new SelectionStore(dataDir, audit);
    await references.load();
    await actions.load();
    await selections.load();

    const sources = await SourceRegistry.fromConfig(config, createLogger('sources'));
    const targets = TargetRegistry.fromConfig(config, createLogger('targets'));
    const judge = new Judge(new OllamaClient(config.localModel, createLogger('judge')), audit, createLogger('judge'));
    await judge.probe();

    const orchestrator = new Orchestrator(
        config,
        sources,
        targets,
        judge,
        references,
        actions,
        selections,
        audit,
        guard,
        createLogger('orchestrator')
    );

    const uiToken = config.approval.uiToken ?? (await ensureUiToken(dataDir));
    guard.registerSecret(uiToken);
    const approval = new ApprovalServer(config, orchestrator, audit, uiToken, createLogger('approval'));
    await approval.start();

    // Printed to stderr so it is visible even when stdout carries MCP traffic.
    process.stderr.write(
        `\nFreigabeoberfläche: ${approval.url()}\n` +
            `Ziele: ${targets.describeAll().map((target) => target.id).join(', ')}\n` +
            `Quellen: ${sources.all().map((source) => `${source.id}${source.isAvailable() ? '' : ' (nicht verbunden)'}`).join(', ')}\n\n`
    );

    const sweepTimer = setInterval(() => {
        void orchestrator.sweep().catch((error) => {
            log.warn('Aufräumen fehlgeschlagen', { error: describeError(error) });
        });
    }, SWEEP_INTERVAL_MS);
    sweepTimer.unref();

    await audit.record('gateway_started', {
        detail: {
            configPath,
            transport: config.hermesInterface.transport,
            targets: targets.describeAll().map((target) => target.id),
            sources: sources.all().map((source) => ({ id: source.id, available: source.isAvailable() })),
            model: config.localModel.model
        }
    });

    // A server instance binds to exactly one transport, so each transport — and
    // each HTTP session — gets its own. They all share the one orchestrator, which
    // is where the state and the trust boundary live.
    const mcpLogger = createLogger('mcp');
    const newServer = (): ReturnType<typeof createHermesServer> => createHermesServer(orchestrator, mcpLogger);
    let httpHandle: { close: () => Promise<void> } | undefined;
    const transport = config.hermesInterface.transport;

    if (transport === 'http' || transport === 'both') {
        httpHandle = await serveHttp(newServer, config, mcpLogger);
    }
    if (transport === 'stdio' || transport === 'both') {
        await serveStdio(newServer(), mcpLogger);
    }

    let shuttingDown = false;
    const shutdown = async (signal: string): Promise<void> => {
        if (shuttingDown) {
            return;
        }
        shuttingDown = true;
        log.info('Beende Gateway', { signal });
        clearInterval(sweepTimer);
        await audit.record('gateway_stopped', { detail: { signal } });
        await httpHandle?.close();
        await approval.stop();
        await sources.closeAll();
        await targets.closeAll();
        process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

/**
 * Teaches the egress guard which strings must never appear in a response to
 * Hermes. Missing one here weakens only the last line of defence — the public
 * payloads are built by whitelist — but it is cheap insurance.
 */
function registerSecrets(guard: EgressGuard, config: GatewayConfig): void {
    guard.registerSecret(config.hermesInterface.http.bearerToken);
    guard.registerSecret(config.localModel.bearerToken);
    guard.registerSecret(config.approval.uiToken);
    for (const source of config.sources) {
        // The source's web address exists only for links in the local UI. It is
        // registered here so that a payload towards Hermes carrying it fails the
        // guard by name, not merely by looking URL-shaped.
        guard.registerSecret(source.webBaseUrl);
        if (source.transport.kind === 'http') {
            guard.registerSecret(source.transport.bearerToken);
            guard.registerSecret(source.transport.url);
        } else {
            for (const value of Object.values(source.transport.env)) {
                guard.registerSecret(value);
            }
        }
    }
    for (const target of config.targets) {
        if (target.kind === 'smtp') {
            guard.registerSecret(target.smtp.password);
            guard.registerSecret(target.smtp.user);
            guard.registerSecret(target.smtp.host);
            guard.registerSecret(target.to);
            guard.registerSecret(target.from);
        } else {
            guard.registerSecret(target.botToken);
            guard.registerSecret(target.chatId);
        }
    }
}

/**
 * Reads the approval UI token, generating one on first start. Kept in the data
 * directory rather than the config so the config file can stay in version
 * control without carrying a credential.
 */
async function ensureUiToken(dataDir: string): Promise<string> {
    const tokenPath = join(dataDir, 'ui-token');
    if (existsSync(tokenPath)) {
        const existing = (await readFile(tokenPath, 'utf8')).trim();
        if (existing.length >= 32) {
            return existing;
        }
    }
    const token = randomBytes(24).toString('base64url');
    await writeFile(tokenPath, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
    return token;
}

main().catch((error) => {
    if (error instanceof ConfigError) {
        process.stderr.write(`\nKonfigurationsfehler:\n${error.message}\n\n`);
        process.exit(2);
    }
    process.stderr.write(`\nStart fehlgeschlagen: ${describeError(error)}\n\n`);
    process.exit(1);
});
