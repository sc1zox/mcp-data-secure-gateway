import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import sharpNamespace from 'sharp';
import { POLICY_VERSION } from '../src/attachments/profiles.js';
import { JPEG_MIME } from '../src/attachments/types.js';
import { MailTarget } from '../src/targets/mailTarget.js';
import { TargetDeliveryError } from '../src/targets/target.js';
import { ActionStore } from '../src/store/actionStore.js';
import { AuditLog } from '../src/store/auditLog.js';
import type { ActionRecord } from '../src/core/types.js';
import { parseConfig } from '../src/config.js';
import { makeHarness, makeResource, waitForAction, waitForTerminal, type Harness } from './helpers.js';

/**
 * The story at the level it is actually written for: a user approves an action
 * whose attachments are too big, and the send succeeds anyway.
 *
 * These run through the whole orchestrator with the real Sharp adapter, because
 * the JPEG half of the tool chain is installable as an npm dependency and
 * therefore always present. The PDF half needs qpdf and is covered by
 * `attachments.tools.test.ts`, which skips itself when qpdf is absent.
 */

const sharp = sharpNamespace as unknown as typeof sharpNamespace;

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

const QUERY = 'mein Passfoto';
const PURPOSE = 'Bewerbung auf eine Stelle';

/** A photo far too big for the budgets used below. */
async function bigPhoto(): Promise<Uint8Array> {
    const width = 3200;
    const height = 2400;
    const raw = Buffer.alloc(width * height * 3);
    for (let i = 0; i < raw.length; i += 1) {
        raw[i] = (Math.sin(i * 0.0137) * 110 + 128) | 0;
    }
    const jpeg = await sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 96 }).toBuffer();
    return new Uint8Array(jpeg);
}

async function photoHarness(options: {
    maxAttachmentBytes: number;
    mode?: 'balanced' | 'compact';
}): Promise<{ created: Harness; original: Uint8Array }> {
    const original = await bigPhoto();
    const resource = makeResource({ mimeType: JPEG_MIME, byteSize: original.byteLength });
    const created = await harness({
        resources: [resource],
        targetDescriptor: {
            maxAttachmentBytes: options.maxAttachmentBytes,
            optimization: {
                policyVersion: POLICY_VERSION,
                maxProfile: options.mode ?? 'compact',
                formats: [JPEG_MIME]
            }
        }
    });
    created.source.files.set('4711', {
        filename: 'foto.jpg',
        mimeType: JPEG_MIME,
        bytes: original
    });
    return { created, original };
}

async function prepareAndApprove(created: Harness): Promise<string> {
    const found = await created.orchestrator.findResource({ query: QUERY, purpose: PURPOSE });
    assert.ok(found.status === 'resolved', `Suche schlug fehl: ${JSON.stringify(found)}`);
    const prepared = await created.orchestrator.prepareAction({
        reference: found.resource.reference,
        target: 'private_mail',
        purpose: PURPOSE
    });
    assert.equal(
        prepared.status,
        'awaiting_local_approval',
        // AK-2: this is the assertion that the prepare-time limit no longer
        // refuses a set the pipeline could still rescue.
        `zu große Originale müssen trotzdem zur Freigabe kommen: ${JSON.stringify(prepared)}`
    );
    const view = created.orchestrator.localAction(prepared.action_id);
    assert.ok(view);
    await created.orchestrator.approveAction(prepared.action_id);
    return prepared.action_id;
}

describe('US-001 Gateway: Optimierung nach der Freigabe', () => {
    it('AK-2/AK-23: bereitet zu große Anhänge vor, optimiert nach genau einer Freigabe und versendet', async () => {
        const budget = 400_000;
        const { created, original } = await photoHarness({ maxAttachmentBytes: budget });
        assert.ok(original.byteLength > budget, 'die Vorlage muss das Budget überschreiten');

        const actionId = await prepareAndApprove(created);
        // AK-23: nothing else is asked of the user between approval and send.
        await waitForAction(created.orchestrator, actionId, ['completed']);

        assert.equal(created.target.delivered.length, 1);
        const sent = created.target.delivered[0]!.attachments[0]!;
        assert.equal(sent.filename, 'foto.jpg', 'der Dateiname bleibt erhalten');
        assert.ok(
            sent.bytes.byteLength <= budget,
            `versendet wurden ${sent.bytes.byteLength} Bytes, erlaubt sind ${budget}`
        );
        assert.ok(sent.bytes.byteLength < original.byteLength);

        const metadata = await sharp(Buffer.from(sent.bytes)).metadata();
        assert.equal(metadata.format, 'jpeg', 'die versendete Datei ist weiterhin ein JPEG');
    });

    it('AK-21: protokolliert die tatsächlich versendeten Anhänge, nicht nur die freigegebenen', async () => {
        const { created, original } = await photoHarness({ maxAttachmentBytes: 400_000 });
        const actionId = await prepareAndApprove(created);
        await waitForAction(created.orchestrator, actionId, ['completed']);

        const egress = (await created.audit.tail(200)).find((event) => event.type === 'egress_performed');
        assert.ok(egress);
        const detail = egress.detail as Record<string, unknown>;

        const approved = detail.attachments as Array<{ byteSize: number; sha256: string }>;
        const delivered = detail.deliveredAttachments as Array<Record<string, unknown>>;
        assert.equal(approved[0]!.byteSize, original.byteLength, 'die Freigabe nennt das Original');
        assert.equal(delivered[0]!.wasOptimized, true);
        assert.equal(delivered[0]!.originalBytes, original.byteLength);
        assert.ok((delivered[0]!.outputBytes as number) < original.byteLength);
        assert.notEqual(delivered[0]!.outputSha256, delivered[0]!.originalSha256);
        assert.equal(delivered[0]!.originalSha256, approved[0]!.sha256);
        assert.equal(delivered[0]!.optimizer, 'sharp');
        assert.ok(typeof delivered[0]!.toolVersion === 'string');
        assert.ok(typeof delivered[0]!.durationMs === 'number');
        assert.deepEqual(detail.optimizationPolicy, {
            policyVersion: POLICY_VERSION,
            maxProfile: 'compact',
            formats: [JPEG_MIME]
        });
    });

    it('AK-17: versendet nichts, wenn auch compact das Budget nicht erreicht', async () => {
        // No JPEG rung gets a 3200x2400 photo under 4 KiB.
        const { created } = await photoHarness({ maxAttachmentBytes: 4096 });
        const actionId = await prepareAndApprove(created);
        await waitForTerminal(created.orchestrator, actionId);

        assert.equal(created.target.delivered.length, 0, 'es darf nichts hinausgehen');
        const status = created.orchestrator.getActionStatus(actionId);
        assert.equal(status.status, 'failed');
        assert.equal(status.reason, 'delivery_failed', 'nach außen bleibt das Vokabular geschlossen');

        const failure = (await created.audit.tail(200)).find((event) => event.type === 'egress_failed');
        assert.ok(failure);
        // The precise cause stays local, next to the coarse public reason.
        assert.equal((failure.detail as Record<string, unknown>).optimization, 'attachment_budget_not_reached');
    });

    it('AK-1: lässt Anhänge unangetastet, die bereits unter das Budget passen', async () => {
        const { created, original } = await photoHarness({ maxAttachmentBytes: 50_000_000 });
        const actionId = await prepareAndApprove(created);
        await waitForAction(created.orchestrator, actionId, ['completed']);

        const sent = created.target.delivered[0]!.attachments[0]!;
        assert.deepEqual(sent.bytes, original, 'byte-identisch mit dem Original');

        const egress = (await created.audit.tail(200)).find((event) => event.type === 'egress_performed');
        const delivered = (egress!.detail as Record<string, unknown>).deliveredAttachments as Array<
            Record<string, unknown>
        >;
        assert.equal(delivered[0]!.wasOptimized, false);
        assert.equal(delivered[0]!.originalSha256, delivered[0]!.outputSha256);
    });

    it('behält das alte Verhalten für ein Ziel ohne Optimierungspolicy', async () => {
        const original = await bigPhoto();
        const created = await harness({
            resources: [makeResource({ mimeType: JPEG_MIME, byteSize: original.byteLength })],
            targetDescriptor: { maxAttachmentBytes: 400_000 }
        });
        created.source.files.set('4711', { filename: 'foto.jpg', mimeType: JPEG_MIME, bytes: original });

        const found = await created.orchestrator.findResource({ query: QUERY, purpose: PURPOSE });
        assert.ok(found.status === 'resolved');
        const prepared = await created.orchestrator.prepareAction({
            reference: found.resource.reference,
            target: 'private_mail',
            purpose: PURPOSE
        });

        // Unchanged from before this feature: without a policy the oversized set
        // is refused up front rather than staged in the hope of shrinking it.
        assert.equal(prepared.status, 'failed');
        assert.match(prepared.note, /Größenbegrenzung/);
        assert.equal(created.target.delivered.length, 0);
    });
});

describe('US-001 Freigabeoberfläche: die Policy ist sichtbar', () => {
    it('nennt der Oberfläche, wie weit die Anhänge verkleinert werden dürfen', async () => {
        const { created } = await photoHarness({ maxAttachmentBytes: 400_000, mode: 'balanced' });
        const found = await created.orchestrator.findResource({ query: QUERY, purpose: PURPOSE });
        assert.ok(found.status === 'resolved');
        const prepared = await created.orchestrator.prepareAction({
            reference: found.resource.reference,
            target: 'private_mail',
            purpose: PURPOSE
        });

        const view = created.orchestrator.localAction(prepared.action_id);
        assert.ok(view?.kind === 'send_resource');
        assert.deepEqual(view.egress.optimization, {
            policyVersion: POLICY_VERSION,
            maxProfile: 'balanced',
            formats: [JPEG_MIME]
        });
        // The sizes next to it are still the originals'; that is the whole
        // reason the policy has to be on screen.
        assert.equal(view.egress.totalBytes, view.egress.attachments[0]!.byteSize);
    });

    it('lässt das Feld weg, solange nichts verändert werden darf', async () => {
        const created = await harness();
        const found = await created.orchestrator.findResource({ query: QUERY, purpose: PURPOSE });
        assert.ok(found.status === 'resolved');
        const prepared = await created.orchestrator.prepareAction({
            reference: found.resource.reference,
            target: 'private_mail',
            purpose: PURPOSE
        });

        const view = created.orchestrator.localAction(prepared.action_id);
        assert.ok(view?.kind === 'send_resource');
        assert.equal(
            view.egress.optimization,
            undefined,
            'ohne Policy darf die Oberfläche keine Verkleinerung ankündigen'
        );
    });
});

describe('US-001 Gateway: Zielprüfung und Neustart', () => {
    it('AK-20: das Ziel prüft die Gesamtgröße selbst, unabhängig von der Pipeline', async () => {
        const target = new MailTarget(
            parseConfig({
                dataDir: './data',
                sources: [
                    {
                        id: 'paperless',
                        kind: 'paperless-mcp',
                        transport: { kind: 'stdio', command: 'node', args: ['noop.js'] }
                    }
                ],
                localModel: { baseUrl: 'http://127.0.0.1:11434', model: 'm' },
                targets: [
                    {
                        id: 'private_mail',
                        kind: 'smtp',
                        smtp: { host: 'h', user: 'u', password: 'p' },
                        from: 'a@example.org',
                        to: 'b@example.org',
                        maxAttachmentBytes: 100
                    }
                ],
                approval: {
                    uiToken: 'test-ui-token-with-at-least-thirty-two-characters',
                }
            }).targets[0] as never
        );

        await assert.rejects(
            () =>
                target.deliver({
                    body: 'Text',
                    attachments: [
                        { filename: 'a.jpg', mimeType: JPEG_MIME, bytes: new Uint8Array(500) }
                    ]
                }),
            TargetDeliveryError
        );
    });

    it('AK-25: versendet eine beim Neustart unterbrochene Aktion nicht automatisch erneut', async () => {
        const created = await harness();
        const audit = new AuditLog(join(created.dataDir, 'audit.jsonl'));
        await audit.init();

        const found = await created.orchestrator.findResource({ query: QUERY, purpose: PURPOSE });
        assert.ok(found.status === 'resolved');
        const prepared = await created.orchestrator.prepareAction({
            reference: found.resource.reference,
            target: 'private_mail',
            purpose: PURPOSE
        });
        const record = created.actions.get(prepared.action_id) as ActionRecord;
        // Straight into `executing` and then abandoned, which is exactly the
        // state a kill during delivery leaves behind.
        await created.actions.transition(prepared.action_id, 'executing');

        const reopened = new ActionStore(created.dataDir, audit);
        await reopened.load();

        const recovered = reopened.get(record.actionId);
        assert.ok(recovered);
        assert.equal(recovered.status, 'failed');
        assert.equal(recovered.statusReason, 'delivery_failed');
        assert.match(recovered.localOutcome!, /Neustart/);
        assert.equal(created.target.delivered.length, 0, 'kein automatischer Zweitversand');
    });

    it('verwirft eine offene Aktion beim Neustart, statt sie freigebbar zu lassen', async () => {
        const created = await harness();
        const audit = new AuditLog(join(created.dataDir, 'audit.jsonl'));
        await audit.init();

        const found = await created.orchestrator.findResource({ query: QUERY, purpose: PURPOSE });
        assert.ok(found.status === 'resolved');
        const prepared = await created.orchestrator.prepareAction({
            reference: found.resource.reference,
            target: 'private_mail',
            purpose: PURPOSE
        });
        assert.equal(created.actions.get(prepared.action_id)?.status, 'awaiting_local_approval');

        const reopened = new ActionStore(created.dataDir, audit);
        await reopened.load();

        const revived = reopened.get(prepared.action_id);
        assert.ok(revived);
        assert.equal(revived.status, 'expired');
        assert.equal(revived.statusReason, 'action_expired');
        assert.equal(reopened.pending().length, 0, 'nach einem Neustart steht nichts mehr zur Freigabe');
    });

    it('verwirft auch eine auf eine Auswahl geparkte Aktion beim Neustart', async () => {
        const created = await harness();
        const audit = new AuditLog(join(created.dataDir, 'audit.jsonl'));
        await audit.init();

        const found = await created.orchestrator.findResource({ query: QUERY, purpose: PURPOSE });
        assert.ok(found.status === 'resolved');
        const prepared = await created.orchestrator.prepareAction({
            reference: found.resource.reference,
            target: 'private_mail',
            purpose: PURPOSE
        });
        await created.actions.transition(prepared.action_id, 'selection_required');

        const reopened = new ActionStore(created.dataDir, audit);
        await reopened.load();

        assert.equal(reopened.get(prepared.action_id)?.status, 'expired');
    });
});
