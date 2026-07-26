import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { parseConfig, ConfigError } from '../src/config.js';
import { JsonlStore, storePath } from '../src/store/jsonlStore.js';
import { ReferenceStore } from '../src/store/referenceStore.js';
import { AuditLog } from '../src/store/auditLog.js';
import { __extractDocumentsForTest as extractDocuments } from '../src/sources/paperlessSource.js';
import { computeBindingHash, resourceStateHash } from '../src/core/orchestrator.js';
import { stableHash } from '../src/util/hash.js';
import { maskChatId, maskEmail } from '../src/targets/target.js';
import type { ActionPlan, ResourceRecord } from '../src/core/types.js';
import { makeConfig, makeResource, TEST_SECRET_TOKEN } from './helpers.js';

const dirs: string[] = [];
async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'ltg-store-'));
    dirs.push(dir);
    return dir;
}
after(async () => {
    for (const dir of dirs) {
        await rm(dir, { recursive: true, force: true });
    }
});

interface Row {
    id: string;
    value: number;
}

describe('JsonlStore', () => {
    it('übersteht einen Neustart und behält die letzte Version', async () => {
        const dir = await tempDir();
        const path = storePath(dir, 'rows');

        const first = new JsonlStore<Row>(path, (row) => row.id);
        await first.load();
        await first.put({ id: 'a', value: 1 });
        await first.put({ id: 'a', value: 2 });
        await first.put({ id: 'b', value: 3 });

        const second = new JsonlStore<Row>(path, (row) => row.id);
        await second.load();
        assert.deepEqual(second.get('a'), { id: 'a', value: 2 });
        assert.equal(second.all().length, 2);
    });

    it('entfernt gelöschte Schlüssel dauerhaft', async () => {
        const dir = await tempDir();
        const path = storePath(dir, 'rows');
        const store = new JsonlStore<Row>(path, (row) => row.id);
        await store.load();
        await store.put({ id: 'a', value: 1 });
        await store.delete('a');

        const reloaded = new JsonlStore<Row>(path, (row) => row.id);
        await reloaded.load();
        assert.equal(reloaded.get('a'), undefined);
    });

    it('schreibt beim Verdichten nur noch die lebenden Datensätze', async () => {
        const dir = await tempDir();
        const path = storePath(dir, 'rows');
        const store = new JsonlStore<Row>(path, (row) => row.id);
        await store.load();
        for (let index = 0; index < 20; index += 1) {
            await store.put({ id: 'a', value: index });
        }
        await store.compact();

        const lines = (await readFile(path, 'utf8')).trim().split('\n');
        assert.equal(lines.length, 1);
        assert.deepEqual(JSON.parse(lines[0]!), { id: 'a', value: 19 });
    });

    it('meldet eine beschädigte Datei statt still weiterzulaufen', async () => {
        const dir = await tempDir();
        const path = storePath(dir, 'rows');
        await writeFile(path, '{"id":"a","value":1}\nkaputt\n', 'utf8');
        const store = new JsonlStore<Row>(path, (row) => row.id);
        await assert.rejects(() => store.load(), /Beschädigte Zeile 2/);
    });

    it('verweigert Zugriff vor dem Laden', async () => {
        const dir = await tempDir();
        const store = new JsonlStore<Row>(storePath(dir, 'rows'), (row) => row.id);
        assert.throws(() => store.all(), /wurde nicht geladen/);
    });
});

describe('ReferenceStore', () => {
    async function makeStore(): Promise<ReferenceStore> {
        const dir = await tempDir();
        const audit = new AuditLog(join(dir, 'audit.jsonl'));
        await audit.init();
        const store = new ReferenceStore(dir, audit);
        await store.load();
        return store;
    }

    function record(overrides: Partial<ResourceRecord> = {}): ResourceRecord {
        const resource = makeResource();
        return {
            ref: 'res_aaaaaaaaaaaa',
            locator: resource.locator,
            safeLabel: 'Aktueller Lebenslauf',
            type: 'document',
            stateHash: resourceStateHash(resource),
            stateToken: resource.stateToken,
            purpose: 'Bewerbung auf eine Stelle',
            originQuery: 'lebenslauf',
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            localSummary: {
                title: resource.title,
                sourceId: 'fake',
                sourceLabel: 'Testquelle',
                nativeIdDisplay: '4711'
            },
            ...overrides
        };
    }

    it('löst eine gültige Referenz auf', async () => {
        const store = await makeStore();
        await store.mint(record());
        assert.ok(store.resolve('res_aaaaaaaaaaaa'));
    });

    it('löst eine abgelaufene Referenz nicht auf', async () => {
        const store = await makeStore();
        await store.mint(record({ expiresAt: new Date(Date.now() - 1000).toISOString() }));
        assert.equal(store.resolve('res_aaaaaaaaaaaa'), undefined);
    });

    it('bindet die Referenz an ihren Zweck', async () => {
        const store = await makeStore();
        await store.mint(record());
        assert.ok(store.resolveForPurpose('res_aaaaaaaaaaaa', 'Bewerbung auf eine Stelle'));
        assert.ok(store.resolveForPurpose('res_aaaaaaaaaaaa', '  BEWERBUNG auf eine   Stelle '));
        assert.equal(store.resolveForPurpose('res_aaaaaaaaaaaa', 'Etwas anderes'), undefined);
    });

    it('entfernt abgelaufene Referenzen beim Aufräumen', async () => {
        const store = await makeStore();
        await store.mint(record({ expiresAt: new Date(Date.now() - 1000).toISOString() }));
        assert.equal(await store.pruneExpired(), 1);
        assert.equal(store.all().length, 0);
    });
});

describe('Bindungs-Hash', () => {
    const plan: ActionPlan = {
        kind: 'send_resource',
        targetId: 'private_mail',
        recipientDisplay: 'i**@example.org',
        subject: 'Betreff',
        body: 'Text',
        attachments: [{ filename: 'a.pdf', mimeType: 'application/pdf', byteSize: 10, sha256: 'ab'.repeat(32) }]
    };

    it('ist stabil gegenüber der Schlüsselreihenfolge', () => {
        assert.equal(stableHash({ a: 1, b: 2 }), stableHash({ b: 2, a: 1 }));
    });

    it('ändert sich, wenn das Ziel wechselt', () => {
        const a = computeBindingHash('res_1', 'state', 'private_mail', plan);
        const b = computeBindingHash('res_1', 'state', 'private_telegram', plan);
        assert.notEqual(a, b);
    });

    it('ändert sich, wenn sich der Zustand der Ressource ändert', () => {
        const a = computeBindingHash('res_1', 'state-alt', 'private_mail', plan);
        const b = computeBindingHash('res_1', 'state-neu', 'private_mail', plan);
        assert.notEqual(a, b);
    });

    it('ändert sich, wenn ein Anhang ausgetauscht wird', () => {
        const a = computeBindingHash('res_1', 'state', 'private_mail', plan);
        const b = computeBindingHash('res_1', 'state', 'private_mail', {
            ...plan,
            attachments: [{ ...plan.attachments[0]!, sha256: 'cd'.repeat(32) }]
        });
        assert.notEqual(a, b);
    });

    it('ändert sich, wenn der Nachrichtentext geändert wird', () => {
        const a = computeBindingHash('res_1', 'state', 'private_mail', plan);
        const b = computeBindingHash('res_1', 'state', 'private_mail', { ...plan, body: 'anderer Text' });
        assert.notEqual(a, b);
    });

    it('erkennt eine geänderte Ressource über den Zustands-Hash', () => {
        const before = resourceStateHash(makeResource());
        const after = resourceStateHash(makeResource({ stateToken: 'modified:2026-07-01T00:00:00.000Z' }));
        assert.notEqual(before, after);
    });
});

describe('Paperless-Antwortformate', () => {
    function textResult(payload: unknown) {
        return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
    }

    it('liest eine Liste unter results', () => {
        const documents = extractDocuments(textResult({ results: [{ id: 1, title: 'A' }] }));
        assert.equal(documents.length, 1);
    });

    it('liest ein blankes Array', () => {
        assert.equal(extractDocuments(textResult([{ id: 1 }, { id: 2 }])).length, 2);
    });

    it('liest ein einzelnes Dokumentobjekt', () => {
        assert.equal(extractDocuments(textResult({ id: 7, title: 'Einzeln' })).length, 1);
    });

    it('liest strukturierte Inhalte', () => {
        const documents = extractDocuments({ structuredContent: { documents: [{ id: 3 }] } });
        assert.equal(documents.length, 1);
    });

    it('gibt bei unlesbarer Antwort eine leere Liste zurück', () => {
        assert.deepEqual(extractDocuments({ content: [{ type: 'text', text: 'kein JSON' }] }), []);
    });
});

describe('Maskierung der Ziele', () => {
    it('maskiert eine E-Mail-Adresse', () => {
        assert.equal(maskEmail('christian@example.org'), 'c********@example.org');
        assert.equal(maskEmail('kaputt'), '***');
    });

    it('maskiert eine Chat-Kennung', () => {
        assert.equal(maskChatId('123456789'), '***789');
        assert.equal(maskChatId('12'), '***');
    });
});

describe('Konfiguration', () => {
    it('akzeptiert eine gültige Minimalkonfiguration', () => {
        assert.ok(makeConfig());
    });

    it('verlangt ein Token, wenn der HTTP-Transport aktiv ist', () => {
        assert.throws(
            () => makeConfig({ hermesInterface: { transport: 'http', http: { port: 8788 } } }),
            ConfigError
        );
    });

    it('akzeptiert den HTTP-Transport mit Token', () => {
        assert.ok(
            makeConfig({
                hermesInterface: { transport: 'http', http: { port: 8788, bearerToken: 'x'.repeat(32) } }
            })
        );
    });

    it('verlangt mindestens ein aktives Ziel', () => {
        assert.throws(
            () =>
                makeConfig({
                    targets: [
                        {
                            id: 'private_mail',
                            kind: 'smtp',
                            enabled: false,
                            smtp: { host: 'h', user: 'u', password: 'p' },
                            from: 'a@b.de',
                            to: 'c@d.de'
                        }
                    ]
                }),
            ConfigError
        );
    });

    it('setzt Umgebungsvariablen ein', () => {
        process.env.LTG_TEST_TOKEN = TEST_SECRET_TOKEN;
        const config = parseConfig({
            sources: [
                {
                    id: 'paperless',
                    kind: 'paperless-mcp',
                    transport: {
                        kind: 'stdio',
                        command: 'node',
                        env: { PAPERLESS_API_TOKEN: '${LTG_TEST_TOKEN}' }
                    }
                }
            ],
            localModel: { baseUrl: 'http://127.0.0.1:11434', model: 'qwen3.5:9b' },
            targets: [
                {
                    id: 'private_mail',
                    kind: 'smtp',
                    smtp: { host: 'h', user: 'u', password: 'p' },
                    from: 'a@b.de',
                    to: 'c@d.de'
                }
            ]
        });
        const transport = config.sources[0]!.transport;
        assert.ok(transport.kind === 'stdio');
        assert.equal(transport.env.PAPERLESS_API_TOKEN, TEST_SECRET_TOKEN);
        delete process.env.LTG_TEST_TOKEN;
    });

    it('meldet eine fehlende Umgebungsvariable als Fehler', () => {
        assert.throws(
            () =>
                parseConfig({
                    sources: [
                        {
                            id: 'paperless',
                            kind: 'paperless-mcp',
                            transport: { kind: 'stdio', command: 'node', env: { X: '${LTG_DEFINITELY_UNSET}' } }
                        }
                    ],
                    localModel: { baseUrl: 'http://127.0.0.1:11434', model: 'q' },
                    targets: [
                        {
                            id: 'private_mail',
                            kind: 'smtp',
                            smtp: { host: 'h', user: 'u', password: 'p' },
                            from: 'a@b.de',
                            to: 'c@d.de'
                        }
                    ]
                }),
            /LTG_DEFINITELY_UNSET/
        );
    });
});
