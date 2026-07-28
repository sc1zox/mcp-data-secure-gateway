import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { ConfigError, parseConfig } from '../src/config.js';
import { makeConfig } from './helpers.js';

describe('Konfiguration: lokale Secrets', () => {
    it('verlangt UI-Token und Telegram-Verschlüsselungsschlüssel', () => {
        const raw = structuredClone(makeConfig()) as unknown as Record<string, unknown>;
        raw.approval = {
            host: '127.0.0.1',
            port: 8787,
            actionTtlSeconds: 1800,
            referenceTtlSeconds: 3600,
            selectionTtlSeconds: 1800
        };
        assert.throws(() => parseConfig(raw), ConfigError);
    });

    it('verlangt getrennte Secrets', () => {
        const raw = structuredClone(makeConfig()) as unknown as Record<string, unknown>;
        raw.approval = {
            ...(raw.approval as Record<string, unknown>),
            uiToken: 'same-secret-with-at-least-thirty-two-characters',
            telegramSettingsKey: 'same-secret-with-at-least-thirty-two-characters'
        };
        assert.throws(() => parseConfig(raw), /unterschiedlich/);
    });
});

describe('Konfiguration: Zeitlimit-Migration', () => {
    it('verwirft requestTimeoutMs mit einem Hinweis auf idleTimeoutMs', () => {
        const raw = structuredClone(makeConfig()) as unknown as Record<string, unknown>;
        (raw.localModel as Record<string, unknown>).requestTimeoutMs = 120000;

        assert.throws(
            () => parseConfig(raw),
            (error: unknown) =>
                error instanceof ConfigError &&
                /localModel\.requestTimeoutMs/.test(error.message) &&
                /localModel\.idleTimeoutMs/.test(error.message)
        );
    });
});
