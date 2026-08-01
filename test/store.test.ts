import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { parseConfig, ConfigError } from '../src/config.js';
import { JsonlStore, storePath } from '../src/store/jsonlStore.js';
import { ReferenceStore } from '../src/store/referenceStore.js';
import { AuditLog } from '../src/store/auditLog.js';
import {
    PaperlessSource,
    __extractDocumentsForTest as extractDocuments
} from '../src/sources/paperlessSource.js';
import { computeBindingHash, resourceStateHash } from '../src/core/orchestrator.js';
import { stableHash } from '../src/util/hash.js';
import { maskChatId } from '../src/targets/target.js';
import type { ResourceRecord, SendResourcePlan, SummariseResourcePlan } from '../src/core/types.js';
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

describe('Audit-Aufbewahrung', () => {
    async function trailWith(events: Array<{ ts: string; type: string }>, dir: string): Promise<void> {
        const lines = events
            .map((event, index) => JSON.stringify({ eventId: `e${index}`, ...event }))
            .join('\n');
        await writeFile(join(dir, 'audit.jsonl'), `${lines}\n`, 'utf8');
    }

    function daysAgo(days: number): string {
        return new Date(Date.now() - days * 86_400_000).toISOString();
    }

    it('entfernt Einträge außerhalb des Aufbewahrungsfensters', async () => {
        const dir = await tempDir();
        await trailWith(
            [
                { ts: daysAgo(120), type: 'gateway_started' },
                { ts: daysAgo(91), type: 'action_prepared' },
                { ts: daysAgo(3), type: 'action_approved' }
            ],
            dir
        );

        const audit = new AuditLog(join(dir, 'audit.jsonl'), { retentionDays: 90, maxEntries: 1000 });
        await audit.init();

        const remaining = await audit.tail();
        assert.deepEqual(
            remaining.map((event) => event.type),
            ['action_approved']
        );
    });

    it('deckelt die Anzahl der Einträge und behält die jüngsten', async () => {
        const dir = await tempDir();
        await trailWith(
            [
                { ts: daysAgo(3), type: 'gateway_started' },
                { ts: daysAgo(2), type: 'action_prepared' },
                { ts: daysAgo(1), type: 'action_approved' }
            ],
            dir
        );

        const audit = new AuditLog(join(dir, 'audit.jsonl'), { retentionDays: 90, maxEntries: 2 });
        await audit.init();

        const remaining = await audit.tail();
        assert.deepEqual(
            remaining.map((event) => event.type),
            ['action_approved', 'action_prepared']
        );
    });

    it('lässt das Protokoll unangetastet, wenn keine Aufbewahrung konfiguriert ist', async () => {
        const dir = await tempDir();
        await trailWith([{ ts: daysAgo(5000), type: 'gateway_started' }], dir);

        const audit = new AuditLog(join(dir, 'audit.jsonl'));
        await audit.init();

        assert.equal((await audit.tail()).length, 1);
    });

    it('schreibt nach dem Rotieren weiter an dieselbe Datei an', async () => {
        const dir = await tempDir();
        await trailWith([{ ts: daysAgo(120), type: 'gateway_started' }], dir);

        const audit = new AuditLog(join(dir, 'audit.jsonl'), { retentionDays: 90, maxEntries: 1000 });
        await audit.init();
        await audit.record('action_prepared', { actionId: 'act_1' });

        const remaining = await audit.tail();
        assert.deepEqual(
            remaining.map((event) => event.type),
            ['action_prepared']
        );
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
    const plan: SendResourcePlan = {
        kind: 'send_resource',
        targetId: 'private_mail',
        recipientDisplay: 'i**@example.org',
        dynamicRecipient: false,
        subject: 'Betreff',
        body: 'Text',
        attachments: [{ filename: 'a.pdf', mimeType: 'application/pdf', byteSize: 10, sha256: 'ab'.repeat(32) }],
        authoredByAgent: { subject: false, body: false }
    };

    const summaryPlan: SummariseResourcePlan = {
        kind: 'summarize_resource',
        summary: 'Ein Schreiben von [REDACTED_ORG] zu einer laufenden Sache.',
        summarySha256: 'ef'.repeat(32),
        redactions: ['REDACTED_ORG'],
        model: 'test-model'
    };

    it('ist stabil gegenüber der Schlüsselreihenfolge', () => {
        assert.equal(stableHash({ a: 1, b: 2 }), stableHash({ b: 2, a: 1 }));
    });

    it('ändert sich, wenn das Ziel wechselt', () => {
        const a = computeBindingHash('res_1', 'state', plan);
        const b = computeBindingHash('res_1', 'state', { ...plan, targetId: 'private_telegram' });
        assert.notEqual(a, b);
    });

    it('ändert sich, wenn sich der Zustand der Ressource ändert', () => {
        const a = computeBindingHash('res_1', 'state-alt', plan);
        const b = computeBindingHash('res_1', 'state-neu', plan);
        assert.notEqual(a, b);
    });

    it('ändert sich, wenn ein Anhang ausgetauscht wird', () => {
        const a = computeBindingHash('res_1', 'state', plan);
        const b = computeBindingHash('res_1', 'state', {
            ...plan,
            attachments: [{ ...plan.attachments[0]!, sha256: 'cd'.repeat(32) }]
        });
        assert.notEqual(a, b);
    });

    it('bindet Mitgliedschaft, Reihenfolge und Zustand der vollständigen Ressourcenmenge', () => {
        const first = [
            { resourceRef: 'res_1', resourceStateHash: 'state-a' },
            { resourceRef: 'res_2', resourceStateHash: 'state-b' }
        ];
        const reversed = [first[1]!, first[0]!];
        const changed = [first[0]!, { ...first[1]!, resourceStateHash: 'state-c' }];

        const baseline = computeBindingHash(first, plan);
        assert.notEqual(baseline, computeBindingHash(first.slice(0, 1), plan));
        assert.notEqual(baseline, computeBindingHash(reversed, plan));
        assert.notEqual(baseline, computeBindingHash(changed, plan));
    });

    it('ändert sich, wenn der Nachrichtentext geändert wird', () => {
        const a = computeBindingHash('res_1', 'state', plan);
        const b = computeBindingHash('res_1', 'state', { ...plan, body: 'anderer Text' });
        assert.notEqual(a, b);
    });

    it('ändert sich, wenn der Text einer Zusammenfassung geändert wird', () => {
        const a = computeBindingHash('res_1', 'state', summaryPlan);
        const b = computeBindingHash('res_1', 'state', { ...summaryPlan, summary: 'Etwas anderes.' });
        assert.notEqual(a, b);
    });

    it('unterscheidet eine Zusammenfassung von einer Übertragung', () => {
        assert.notEqual(
            computeBindingHash('res_1', 'state', plan),
            computeBindingHash('res_1', 'state', summaryPlan)
        );
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

/**
 * The search tool is a list endpoint and answers unevenly: one candidate arrives
 * with its OCR text, the next with none, and tags come back as bare ids. Judging
 * that as-is is how a document nobody could read gets picked over one whose text
 * names the very thing that was searched for.
 */
describe('Paperless: Kandidaten nachladen', () => {
    type Handler = (tool: string, args: Record<string, unknown>) => unknown;

    function stubbed(handler: Handler, knownTools?: string[]) {
        const source = new PaperlessSource(makeConfig().sources[0]!);
        const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
        (source as unknown as { client: unknown }).client = {
            hasTool: (name: string) => (knownTools ? knownTools.includes(name) : true),
            resolveParamName: (_tool: string, candidates: string[]) => candidates[0],
            async callTool(tool: string, args: Record<string, unknown>) {
                calls.push({ tool, args });
                const payload = handler(tool, args);
                if (payload instanceof Error) {
                    throw payload;
                }
                return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
            }
        };
        return { source, calls };
    }

    const TAGS = [
        { id: 3, name: 'Altklausur' },
        { id: 9, name: 'Künstliche Intelligenz' },
        { id: 1, name: 'Studium' }
    ];

    /** Search answers thin, `get` answers fully — the shape that caused the miss. */
    const handler: Handler = (tool, args) => {
        if (tool === 'search_documents') {
            return { results: [{ id: 39, title: 'Altklausur', tags: [3, 9, 1] }] };
        }
        if (tool === 'list_tags') {
            return TAGS;
        }
        return {
            id: args.id,
            title: 'Altklausur',
            modified: '2026-01-09T15:30:55.000Z',
            tags: [3, 9, 1],
            content: 'Prüfungsumschlag: Einführung in Künstliche Intelligenz SS25.'
        };
    };

    it('holt Inhalt und Schlagwörter nach, die die Suche nicht mitgeliefert hat', async () => {
        const { source, calls } = stubbed(handler);
        const [resource] = await source.search('altklausur ki', 8);

        assert.ok(resource);
        assert.match(resource.excerpt ?? '', /Einführung in Künstliche Intelligenz SS25/);
        assert.deepEqual(resource.attributes?.Schlagwörter, [
            'Altklausur',
            'Künstliche Intelligenz',
            'Studium'
        ]);
        assert.ok(calls.some((call) => call.tool === 'get_document' && call.args.id === 39));
    });

    it('lässt unauflösbare Schlagwort-Kennungen weg, statt Zahlen als Merkmal zu zeigen', async () => {
        // No tag tool on the server: ids stay ids, and an id is not information.
        const { source } = stubbed(handler, ['search_documents', 'get_document']);
        const [resource] = await source.search('altklausur ki', 8);

        assert.ok(resource);
        assert.equal(resource.attributes?.Schlagwörter, undefined);
        assert.match(resource.excerpt ?? '', /Künstliche Intelligenz/);
    });

    it('behält einen Kandidaten, dessen Nachladen fehlschlägt', async () => {
        const { source } = stubbed((tool, args) =>
            tool === 'get_document' ? new Error('Zeitüberschreitung') : handler(tool, args)
        );
        const [resource] = await source.search('altklausur ki', 8);

        assert.ok(resource);
        assert.equal(resource.title, 'Altklausur');
        assert.equal(resource.excerpt, undefined);
    });
});

describe('Maskierung der Chat-Kennung', () => {
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
            approval: {
                uiToken: 'test-ui-token-with-at-least-thirty-two-characters',
            },
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

    it('setzt für SMTP ein MIME-sicheres Standardlimit und respektiert explizite Overrides', () => {
        const defaultConfig = makeConfig();
        const defaultTarget = defaultConfig.targets[0]!;
        assert.equal(defaultTarget.kind, 'smtp');
        assert.equal(defaultTarget.maxAttachmentBytes, 14_542_294);

        const configured = makeConfig({
            targets: [
                {
                    id: 'private_mail',
                    kind: 'smtp',
                    smtp: { host: 'h', user: 'u', password: 'p' },
                    from: 'a@b.de',
                    to: 'c@d.de',
                    maxAttachmentBytes: 30 * 1024 * 1024
                }
            ]
        });
        const configuredTarget = configured.targets[0]!;
        assert.equal(configuredTarget.kind, 'smtp');
        assert.equal(configuredTarget.maxAttachmentBytes, 30 * 1024 * 1024);
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
