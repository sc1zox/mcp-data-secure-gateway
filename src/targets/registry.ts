import type { GatewayConfig, TargetConfig } from '../config.js';
import type { TargetDescriptor } from '../core/types.js';
import type { Logger } from '../util/log.js';
import { MailTarget } from './mailTarget.js';
import { TelegramTarget } from './telegramTarget.js';
import type { EgressTarget } from './target.js';

/**
 * The closed set of egress destinations.
 *
 * Built once from the config file at startup and never mutated afterwards, so
 * "only locally configured targets can be used" holds by construction rather
 * than by validation at each call site (invariant 6). Lookup by id is the only
 * way to reach a target, and an unknown id is simply not found.
 */
export class TargetRegistry {
    private readonly targets = new Map<string, EgressTarget>();

    constructor(configs: TargetConfig[], logger?: Logger) {
        for (const config of configs) {
            if (!config.enabled) {
                continue;
            }
            const target = createTarget(config, logger);
            if (this.targets.has(target.id)) {
                throw new Error(`Ziel ${target.id} ist doppelt konfiguriert.`);
            }
            this.targets.set(target.id, target);
        }
    }

    static fromConfig(config: GatewayConfig, logger?: Logger): TargetRegistry {
        return new TargetRegistry(config.targets, logger);
    }

    get(targetId: string): EgressTarget | undefined {
        return this.targets.get(targetId);
    }

    has(targetId: string): boolean {
        return this.targets.has(targetId);
    }

    describeAll(): TargetDescriptor[] {
        return [...this.targets.values()].map((target) => target.describe());
    }

    async closeAll(): Promise<void> {
        for (const target of this.targets.values()) {
            if ('close' in target && typeof (target as { close?: unknown }).close === 'function') {
                await (target as { close: () => Promise<void> }).close();
            }
        }
    }
}

function createTarget(config: TargetConfig, logger?: Logger): EgressTarget {
    switch (config.kind) {
        case 'smtp':
            return new MailTarget(config, logger);
        case 'telegram':
            return new TelegramTarget(config, logger);
    }
}
