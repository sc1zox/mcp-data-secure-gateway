import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';
import nodemailer from 'nodemailer';
import { computeBindingHash } from '../src/core/orchestrator.js';
import { MailTarget } from '../src/targets/mailTarget.js';
import { makeConfig, makeHarness, makeResource, waitForTerminal, type Harness } from './helpers.js';

const QUERY = 'meine Bewerbungsunterlagen';
const PURPOSE = 'Bewerbung auf eine Stelle';

const harnesses: Harness[] = [];
async function harness(...args: Parameters<typeof makeHarness>): Promise<Harness> {
    const created = await makeHarness(...args);
    harnesses.push(created);
    return created;
}

after(async () => {
    for (const created of harnesses) {
        await created.cleanup();
    }
});

const cv = makeResource({
    title: 'Lebenslauf 2026',
    locator: { sourceId: 'fake', nativeId: '4711' },
    stateToken: 'cv:v1',
    byteSize: 4
});
const letter = makeResource({
    title: 'Anschreiben',
    locator: { sourceId: 'fake', nativeId: '4712' },
    stateToken: 'letter:v1',
    byteSize: 3
});

async function referencesFor(
    created: Harness,
    resources = [cv, letter],
    purposes = resources.map(() => PURPOSE)
): Promise<string[]> {
    const references: string[] = [];
    for (const [index, resource] of resources.entries()) {
        created.source.resources = [resource];
        const found = await created.orchestrator.findResource({
            query: `${QUERY} ${index + 1}`,
            purpose: purposes[index]!
        });
        assert.ok(found.status === 'resolved');
        references.push(found.resource.reference);
    }
    created.source.resources = resources;
    return references;
}

function configureFiles(created: Harness): void {
    created.source.files.set('4711', {
        filename: 'lebenslauf.pdf',
        mimeType: 'application/pdf',
        bytes: new Uint8Array([1, 2, 3, 4])
    });
    created.source.files.set('4712', {
        filename: 'anschreiben.pdf',
        mimeType: 'application/pdf',
        bytes: new Uint8Array([5, 6, 7])
    });
}

describe('Mehrere Anhänge pro Aktion', () => {
    it('bereitet eine vollständige Ressourcenmenge vor und überträgt sie erst nach Freigabe', async () => {
        const created = await harness({ resources: [cv, letter] });
        configureFiles(created);
        const references = await referencesFor(created);

        const state = await created.orchestrator.prepareAction({
            references,
            target: 'private_mail',
            purpose: PURPOSE
        });

        assert.equal(state.status, 'awaiting_local_approval');
        assert.equal(created.target.delivered.length, 0);
        assert.doesNotMatch(JSON.stringify(state), /lebenslauf|anschreiben|4711|4712|fake/i);

        const view = created.orchestrator.localAction(state.action_id);
        assert.ok(view?.kind === 'send_resource');
        assert.deepEqual(
            view.resources.map((resource) => resource.ref),
            references
        );
        assert.deepEqual(
            view.resources.map((resource) => resource.title),
            ['Lebenslauf 2026', 'Anschreiben']
        );
        assert.deepEqual(
            view.egress.attachments.map((attachment) => attachment.filename),
            ['lebenslauf.pdf', 'anschreiben.pdf']
        );
        assert.equal(view.egress.totalBytes, 7);

        await created.orchestrator.approveAction(state.action_id);
        assert.equal(await waitForTerminal(created.orchestrator, state.action_id), 'completed');
        assert.deepEqual(
            created.target.delivered[0]?.attachments.map((attachment) => [
                attachment.filename,
                [...attachment.bytes]
            ]),
            [
                ['lebenslauf.pdf', [1, 2, 3, 4]],
                ['anschreiben.pdf', [5, 6, 7]]
            ]
        );
    });

    it('unterstützt den bisherigen einzelnen reference-Parameter unverändert', async () => {
        const created = await harness({ resources: [cv] });
        configureFiles(created);
        const [reference] = await referencesFor(created, [cv]);

        const state = await created.orchestrator.prepareAction({
            reference,
            target: 'private_mail',
            purpose: PURPOSE
        });
        const view = created.orchestrator.localAction(state.action_id);
        assert.ok(view?.kind === 'send_resource');
        assert.equal(view.resources.length, 1);
        assert.equal(view.egress.attachments.length, 1);

        await created.orchestrator.approveAction(state.action_id);
        assert.equal(await waitForTerminal(created.orchestrator, state.action_id), 'completed');
        assert.equal(created.target.delivered[0]?.attachments.length, 1);
    });

    it('führt einen gespeicherten Ein-Ressourcen-Datensatz aus der alten Form weiter aus', async () => {
        const created = await harness({ resources: [cv] });
        configureFiles(created);
        const [reference] = await referencesFor(created, [cv]);
        const state = await created.orchestrator.prepareAction({
            reference,
            target: 'private_mail',
            purpose: PURPOSE
        });
        const stored = created.actions.get(state.action_id);
        assert.ok(stored);
        stored.resourceBindings = undefined;
        stored.bindingHash = computeBindingHash(
            stored.resourceRef,
            stored.resourceStateHash,
            stored.plan
        );

        const view = created.orchestrator.localAction(state.action_id);
        assert.ok(view?.kind === 'send_resource');
        assert.equal(view.resources.length, 1);
        await created.orchestrator.approveAction(state.action_id);

        assert.equal(await waitForTerminal(created.orchestrator, state.action_id), 'completed');
        assert.equal(created.target.delivered[0]?.attachments.length, 1);
    });

    it('weist leere, doppelte, malformed und gleichzeitig alte/neue Eingaben ohne Aktion ab', async () => {
        const created = await harness({ resources: [cv, letter] });
        const references = await referencesFor(created);

        for (const input of [
            { references: [] },
            { references: [references[0]!, references[0]!] },
            { references: [references[0]!, 'not-a-resource'] },
            { reference: references[0], references }
        ]) {
            const state = await created.orchestrator.prepareAction({
                ...input,
                target: 'private_mail',
                purpose: PURPOSE
            });
            assert.equal(state.status, 'failed');
            assert.match(state.note, /ungültig/i);
            assert.doesNotMatch(JSON.stringify(state), /not-a-resource|4711|4712|fake/);
        }

        assert.equal(created.orchestrator.localPendingActions().length, 0);
        assert.equal(created.source.originalFetches.length, 0);
        assert.equal(created.target.delivered.length, 0);
    });

    it('prüft die Zweckbindung jeder einzelnen Referenz vor jedem Download', async () => {
        const created = await harness({ resources: [cv, letter] });
        const references = await referencesFor(
            created,
            [cv, letter],
            [PURPOSE, 'Nur zur lokalen Ablage']
        );

        const state = await created.orchestrator.prepareAction({
            references,
            target: 'private_mail',
            purpose: PURPOSE
        });

        assert.equal(state.status, 'failed');
        assert.match(state.note, /anderen Zweck/);
        assert.equal(created.source.originalFetches.length, 0);
        assert.equal(created.orchestrator.localPendingActions().length, 0);
    });

    it('behandelt die Größenbegrenzung als Grenze für die vollständige Menge', async () => {
        const created = await harness({
            resources: [cv, letter],
            targetDescriptor: { maxAttachmentBytes: 6 }
        });
        configureFiles(created);
        const references = await referencesFor(created);

        const state = await created.orchestrator.prepareAction({
            references,
            target: 'private_mail',
            purpose: PURPOSE
        });

        assert.equal(state.status, 'failed');
        assert.match(state.note, /Größenbegrenzung/);
        assert.equal(created.orchestrator.localPendingActions().length, 0);
        assert.equal(created.target.delivered.length, 0);
    });

    it('beachtet die lokal konfigurierte Höchstzahl von Anhängen', async () => {
        const created = await harness({
            resources: [cv, letter],
            targetDescriptor: { maxAttachments: 1 }
        });
        configureFiles(created);
        const references = await referencesFor(created);

        const state = await created.orchestrator.prepareAction({
            references,
            target: 'private_mail',
            purpose: PURPOSE
        });

        assert.equal(state.status, 'failed');
        assert.match(state.note, /ungültig/i);
        assert.equal(created.source.originalFetches.length, 0);
        assert.equal(created.orchestrator.localPendingActions().length, 0);
    });

    it('weist eine nicht mehr verfügbare Teilmenge zurück, bevor Originale geladen werden', async () => {
        const created = await harness({ resources: [cv, letter] });
        const references = await referencesFor(created);
        created.source.resources = [cv];

        const state = await created.orchestrator.prepareAction({
            references,
            target: 'private_mail',
            purpose: PURPOSE
        });

        assert.equal(state.status, 'failed');
        assert.equal(created.source.originalFetches.length, 0);
        assert.equal(created.orchestrator.localPendingActions().length, 0);
        assert.equal(created.target.delivered.length, 0);
        assert.doesNotMatch(JSON.stringify(state), /Anschreiben|4712|fake/);
    });

    it('weist unsichere Anhangsmetadaten zurück, ohne sie an Hermes auszugeben', async () => {
        const created = await harness({ resources: [cv, letter] });
        configureFiles(created);
        created.source.files.set('4712', {
            filename: '../../private/anschreiben.pdf',
            mimeType: 'application/pdf',
            bytes: new Uint8Array([5, 6, 7])
        });
        const references = await referencesFor(created);

        const state = await created.orchestrator.prepareAction({
            references,
            target: 'private_mail',
            purpose: PURPOSE
        });

        assert.equal(state.status, 'failed');
        assert.match(state.note, /ungültig/i);
        assert.doesNotMatch(JSON.stringify(state), /private|anschreiben|pdf|\.\./i);
        assert.equal(created.orchestrator.localPendingActions().length, 0);
    });

    it('revalidiert die vollständige Menge unmittelbar vor der Ausführung', async () => {
        const created = await harness({ resources: [cv, letter] });
        configureFiles(created);
        const references = await referencesFor(created);
        const state = await created.orchestrator.prepareAction({
            references,
            target: 'private_mail',
            purpose: PURPOSE
        });
        const view = created.orchestrator.localAction(state.action_id);
        assert.ok(view?.kind === 'send_resource');
        const beforeApproval = created.source.metadataFetches.length;

        created.source.resources = [
            makeResource({ ...cv, stateToken: 'cv:v2' }),
            letter
        ];
        await created.orchestrator.approveAction(state.action_id);
        assert.equal(await waitForTerminal(created.orchestrator, state.action_id), 'failed');

        assert.deepEqual(
            created.source.metadataFetches.slice(beforeApproval).sort(),
            ['4711', '4712'],
            'auch bei einer geänderten ersten Ressource wird die ganze Menge geprüft'
        );
        assert.equal(created.target.delivered.length, 0);
    });

    it('persistiert die geordnete Ressourcenbindung', async () => {
        const created = await harness({ resources: [cv, letter] });
        configureFiles(created);
        const references = await referencesFor(created);
        const state = await created.orchestrator.prepareAction({
            references,
            target: 'private_mail',
            purpose: PURPOSE
        });
        const stored = created.actions.get(state.action_id);
        assert.deepEqual(
            stored?.resourceBindings?.map((binding) => binding.resourceRef),
            references
        );
    });

    it('versendet nichts, wenn die bereitgestellten Bytes fehlen', async () => {
        const created = await harness({ resources: [cv, letter] });
        configureFiles(created);
        const references = await referencesFor(created);
        const state = await created.orchestrator.prepareAction({
            references,
            target: 'private_mail',
            purpose: PURPOSE
        });

        const view = created.orchestrator.localAction(state.action_id);
        assert.ok(view?.kind === 'send_resource');
        (
            created.orchestrator as unknown as { actionExecutor: { discard(actionId: string): void } }
        ).actionExecutor.discard(state.action_id);
        const fetchesBeforeApproval = created.source.originalFetches.length;

        await created.orchestrator.approveAction(state.action_id);
        assert.equal(await waitForTerminal(created.orchestrator, state.action_id), 'failed');
        assert.deepEqual(
            created.source.originalFetches.slice(fetchesBeforeApproval),
            [],
            'ohne bereitgestellte Bytes wird die Quelle nicht erneut gelesen'
        );
        assert.equal(created.target.delivered.length, 0);
    });
});

describe('Nodemailer-Übergabe', () => {
    it('übergibt mehrere Anhänge in einer Nachricht an Nodemailer', async () => {
        const config = makeConfig().targets[0]!;
        assert.equal(config.kind, 'smtp');
        const target = new MailTarget(config);
        const transport = nodemailer.createTransport({ jsonTransport: true });
        const messages: Array<Record<string, unknown>> = [];
        const sendMail = transport.sendMail.bind(transport);
        transport.sendMail = ((message: Record<string, unknown>) => {
            messages.push(message);
            return sendMail(message);
        }) as typeof transport.sendMail;
        (target as unknown as { transporter: typeof transport }).transporter = transport;

        const receipt = await target.deliver({
            subject: 'Unterlagen',
            body: 'Anbei.',
            attachments: [
                {
                    filename: 'lebenslauf.pdf',
                    mimeType: 'application/pdf',
                    bytes: new Uint8Array([1, 2, 3])
                },
                {
                    filename: 'anschreiben.txt',
                    mimeType: 'text/plain',
                    bytes: new Uint8Array([4, 5])
                }
            ]
        });

        assert.ok(receipt.reference);
        assert.equal(messages.length, 1);
        const attachments = messages[0]?.['attachments'] as Array<{
            filename: string;
            contentType: string;
            content: string;
        }>;
        assert.deepEqual(
            attachments.map((attachment) => [
                attachment.filename,
                attachment.contentType,
                [...Buffer.from(attachment.content, 'base64')]
            ]),
            [
                ['lebenslauf.pdf', 'application/pdf', [1, 2, 3]],
                ['anschreiben.txt', 'text/plain', [4, 5]]
            ]
        );
        await target.close();
    });
});
