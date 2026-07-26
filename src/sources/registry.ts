import type { GatewayConfig } from '../config.js';
import { createLogger, describeError, type Logger } from '../util/log.js';
import { PaperlessSource } from './paperlessSource.js';
import type { PrivateSource } from './source.js';

/**
 * Holds the configured private sources.
 *
 * Adding a source later — Baikal/DAV is the intended next one — means
 * implementing `PrivateSource` and adding one case to `createSource`. Nothing
 * else in the gateway, and nothing at all on the Hermes side, needs to change.
 */
export class SourceRegistry {
    private readonly sources = new Map<string, PrivateSource>();
    private readonly log: Logger;

    constructor(logger?: Logger) {
        this.log = logger ?? createLogger('sources');
    }

    static async fromConfig(config: GatewayConfig, logger?: Logger): Promise<SourceRegistry> {
        const registry = new SourceRegistry(logger);
        for (const sourceConfig of config.sources) {
            if (!sourceConfig.enabled) {
                continue;
            }
            registry.register(createSource(sourceConfig, logger));
        }
        await registry.connectAll();
        return registry;
    }

    register(source: PrivateSource): void {
        if (this.sources.has(source.id)) {
            throw new Error(`Quelle ${source.id} ist doppelt konfiguriert.`);
        }
        this.sources.set(source.id, source);
    }

    /**
     * Connects every source. A failing source is logged and left unavailable
     * rather than aborting startup: the user should still be able to reach the
     * approval UI and the audit trail when one backend is down.
     */
    private async connectAll(): Promise<void> {
        for (const source of this.sources.values()) {
            try {
                await source.connect();
            } catch (error) {
                this.log.error('Quelle konnte nicht verbunden werden', {
                    sourceId: source.id,
                    error: describeError(error)
                });
            }
        }
    }

    get(sourceId: string): PrivateSource | undefined {
        return this.sources.get(sourceId);
    }

    all(): PrivateSource[] {
        return [...this.sources.values()];
    }

    available(): PrivateSource[] {
        return this.all().filter((source) => source.isAvailable());
    }

    async closeAll(): Promise<void> {
        for (const source of this.sources.values()) {
            await source.close();
        }
    }
}

function createSource(config: GatewayConfig['sources'][number], logger?: Logger): PrivateSource {
    switch (config.kind) {
        case 'paperless-mcp':
            return new PaperlessSource(config, logger);
    }
}
