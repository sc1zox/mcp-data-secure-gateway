import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { ConfigError, parseConfig } from '../src/config.js';
import { estimateContextBudget } from '../src/judge/prompts.js';
import { makeConfig } from './helpers.js';

describe('Konfiguration: lokale Secrets', () => {
    it('verlangt ein UI-Token', () => {
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

    it('verlangt ein hinreichend langes UI-Token', () => {
        const raw = structuredClone(makeConfig()) as unknown as Record<string, unknown>;
        raw.approval = {
            ...(raw.approval as Record<string, unknown>),
            uiToken: 'zu-kurz'
        };
        assert.throws(() => parseConfig(raw), ConfigError);
    });
});

describe('Konfiguration: Token-Budget', () => {
    it('verwirft ein Ausgabebudget, das das ganze Kontextfenster belegt', () => {
        const raw = structuredClone(makeConfig()) as unknown as Record<string, unknown>;
        raw.localModel = {
            ...(raw.localModel as Record<string, unknown>),
            numCtx: 4096,
            numPredict: 4096
        };

        assert.throws(
            () => parseConfig(raw),
            (error: unknown) =>
                error instanceof ConfigError &&
                /numPredict/.test(error.message) &&
                /numCtx/.test(error.message)
        );
    });

    it('lässt ein Budget zu, das dem Prompt Platz lässt', () => {
        const raw = structuredClone(makeConfig()) as unknown as Record<string, unknown>;
        raw.localModel = {
            ...(raw.localModel as Record<string, unknown>),
            numCtx: 16384,
            numPredict: 2048
        };

        assert.equal(parseConfig(raw).localModel.numCtx, 16384);
    });

    it('erkennt ein Kontextfenster, das den Auswahl-Prompt nicht fasst', () => {
        const tooSmall = parseConfig({
            ...(structuredClone(makeConfig()) as unknown as Record<string, unknown>),
            localModel: {
                baseUrl: 'http://127.0.0.1:11434',
                model: 'qwen3.5:9b',
                numCtx: 4096,
                numPredict: 2048
            }
        });
        assert.equal(estimateContextBudget(tooSmall).fits, false);

        const roomy = parseConfig({
            ...(structuredClone(makeConfig()) as unknown as Record<string, unknown>),
            localModel: {
                baseUrl: 'http://127.0.0.1:11434',
                model: 'qwen3.5:9b',
                numCtx: 16384,
                numPredict: 2048
            }
        });
        assert.equal(estimateContextBudget(roomy).fits, true);
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
