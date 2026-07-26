import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';
import { makeHarness, makeResource, waitForTerminal, type Harness } from './helpers.js';

/**
 * Behaviour of the request lifecycle, as opposed to the boundary properties
 * covered in `invariants.test.ts`: what an agent may write into a message, how a
 * decision travels back to it, and what re-picking a resource does to an
 * approval that is already waiting.
 */

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

const QUERY = 'mein aktueller Lebenslauf';
const PURPOSE = 'Bewerbung auf eine Stelle';

/** Runs find + prepare and hands back the action id. */
async function prepare(
    created: Harness,
    extra: { subject?: string; body?: string; note?: string } = {}
): Promise<string> {
    const found = await created.orchestrator.findResource({ query: QUERY, purpose: PURPOSE });
    assert.ok(found.status === 'resolved');
    const prepared = await created.orchestrator.prepareAction({
        reference: found.resource.reference,
        target: 'private_mail',
        purpose: PURPOSE,
        ...extra
    });
    assert.equal(prepared.status, 'awaiting_local_approval');
    return prepared.action_id;
}

describe('Betreff und Text vom Agenten', () => {
    const SUBJECT = 'Bewerbung als Entwickler';
    const BODY = 'Sehr geehrte Damen und Herren,\n\nanbei meine Unterlagen.\n\nMit freundlichen Grüßen';

    it('übernimmt beides wörtlich und ohne Zusatz des Gateways', async () => {
        const created = await harness();
        const actionId = await prepare(created, { subject: SUBJECT, body: BODY });

        const view = created.orchestrator.localAction(actionId);
        assert.ok(view);
        assert.equal(view.egress.subject, SUBJECT);
        assert.equal(view.egress.body, BODY);
        assert.deepEqual(view.egress.authoredByAgent, { subject: true, body: true });

        await created.orchestrator.approveAction(actionId, view.bindingHash);
        await waitForTerminal(created.orchestrator, actionId);

        const sent = created.target.delivered[0];
        assert.ok(sent);
        assert.equal(sent.subject, SUBJECT);
        assert.equal(sent.body, BODY);
        assert.doesNotMatch(sent.body, /Local Trust Gateway/);
    });

    it('stellt ohne Angabe weiterhin einen neutralen Text zusammen', async () => {
        const created = await harness();
        const actionId = await prepare(created);

        const view = created.orchestrator.localAction(actionId);
        assert.ok(view);
        assert.deepEqual(view.egress.authoredByAgent, { subject: false, body: false });
        assert.match(view.egress.body, /Local Trust Gateway/);
        assert.match(view.egress.body, new RegExp(PURPOSE));
    });

    it('lässt einen Betreff keine zweite Kopfzeile aufmachen', async () => {
        const created = await harness();
        const actionId = await prepare(created, {
            subject: 'Bewerbung\nBcc: mitleser@example.net'
        });

        const view = created.orchestrator.localAction(actionId);
        assert.ok(view);
        assert.doesNotMatch(view.egress.subject ?? '', /\n|\r/);
    });

    it('bindet die Freigabe an genau diesen Text', async () => {
        const created = await harness();
        const first = created.orchestrator.localAction(await prepare(created, { body: 'Text A' }));
        const second = created.orchestrator.localAction(await prepare(created, { body: 'Text B' }));
        assert.ok(first && second);
        assert.notEqual(first.bindingHash, second.bindingHash);
    });

    it('mischt keinen Agentenhinweis in einen vom Agenten geschriebenen Text', async () => {
        const created = await harness();
        const actionId = await prepare(created, { body: BODY, note: 'nur intern gedacht' });

        const view = created.orchestrator.localAction(actionId);
        assert.ok(view);
        assert.equal(view.egress.body, BODY);
    });
});

describe('Auf die Entscheidung des Nutzers warten', () => {
    it('antwortet, sobald die Aktion abgeschlossen ist', async () => {
        const created = await harness();
        const actionId = await prepare(created);
        const view = created.orchestrator.localAction(actionId);
        assert.ok(view);

        const waiting = created.orchestrator.awaitActionDecision(actionId, 10);
        await created.orchestrator.approveAction(actionId, view.bindingHash);

        const result = await waiting;
        assert.equal(result.status, 'completed');
        assert.equal(result.reason, 'delivered');
    });

    it('meldet auch eine Ablehnung zurück', async () => {
        const created = await harness();
        const actionId = await prepare(created);

        const waiting = created.orchestrator.awaitActionDecision(actionId, 10);
        await created.orchestrator.rejectAction(actionId);

        const result = await waiting;
        assert.equal(result.status, 'rejected');
        assert.equal(result.reason, 'user_rejected');
    });

    it('liefert nach Ablauf des Zeitfensters den Zwischenstand statt eines Fehlers', async () => {
        const created = await harness();
        const actionId = await prepare(created);

        const result = await created.orchestrator.awaitActionDecision(actionId, 1);
        assert.equal(result.status, 'awaiting_local_approval');
    });

    it('meldet eine unbekannte Aktion sofort', async () => {
        const created = await harness();
        const result = await created.orchestrator.awaitActionDecision('act_gibtsnicht', 60);
        assert.equal(result.status, 'failed');
        assert.match(result.note, /unbekannt/);
    });
});

describe('Andere Ressource wählen', () => {
    const twoDocuments = [
        makeResource({ title: 'Lebenslauf 2026', locator: { sourceId: 'fake', nativeId: '4711' } }),
        makeResource({ title: 'Lebenslauf 2024', locator: { sourceId: 'fake', nativeId: '4712' } })
    ];

    it('pausiert die Aktion, statt sie abzulehnen', async () => {
        const created = await harness({ resources: twoDocuments });
        const actionId = await prepare(created);

        await created.orchestrator.requestReselection(actionId);

        const status = created.orchestrator.getActionStatus(actionId);
        assert.equal(status.status, 'selection_required');
        assert.notEqual(status.status, 'rejected');
        assert.equal(created.orchestrator.localPendingActions().length, 0);

        const selection = created.orchestrator.localOpenSelections()[0];
        assert.ok(selection);
        assert.equal(selection.originActionId, actionId);
        assert.equal(selection.candidates.filter((candidate) => candidate.isCurrent).length, 1);
    });

    it('stellt die Aktion unverändert wieder her, wenn das bisherige Dokument bestätigt wird', async () => {
        const created = await harness({ resources: twoDocuments });
        const actionId = await prepare(created);
        const before = created.orchestrator.localAction(actionId);
        assert.ok(before);

        await created.orchestrator.requestReselection(actionId);
        const selection = created.orchestrator.localOpenSelections()[0];
        assert.ok(selection);
        const current = selection.candidates.find((candidate) => candidate.isCurrent);
        assert.ok(current);

        const outcome = await created.orchestrator.resolveSelection(
            selection.selectionId,
            current.candidateId
        );
        assert.deepEqual(outcome.action, { kind: 'restored', actionId });

        const after = created.orchestrator.localAction(actionId);
        assert.ok(after);
        assert.equal(after.status, 'awaiting_local_approval');
        assert.equal(after.bindingHash, before.bindingHash);

        // And it is genuinely approvable again, with the hash that was on screen.
        await created.orchestrator.approveAction(actionId, before.bindingHash);
        assert.equal(await waitForTerminal(created.orchestrator, actionId), 'completed');
    });

    it('verwirft die Aktion, wenn ein anderes Dokument gewählt wird', async () => {
        const created = await harness({ resources: twoDocuments });
        const actionId = await prepare(created);

        await created.orchestrator.requestReselection(actionId);
        const selection = created.orchestrator.localOpenSelections()[0];
        assert.ok(selection);
        const other = selection.candidates.find((candidate) => !candidate.isCurrent);
        assert.ok(other);

        const outcome = await created.orchestrator.resolveSelection(
            selection.selectionId,
            other.candidateId
        );
        assert.deepEqual(outcome.action, { kind: 'discarded', actionId });

        const status = created.orchestrator.getActionStatus(actionId);
        assert.equal(status.status, 'rejected');
        assert.equal(status.reason, 'user_discarded');
        assert.equal(created.target.delivered.length, 0);
    });

    it('lässt die Aktion unverändert, wenn die Auswahl abgebrochen wird', async () => {
        const created = await harness({ resources: twoDocuments });
        const actionId = await prepare(created);
        const before = created.orchestrator.localAction(actionId);
        assert.ok(before);

        await created.orchestrator.requestReselection(actionId);
        const selection = created.orchestrator.localOpenSelections()[0];
        assert.ok(selection);

        const outcome = await created.orchestrator.cancelSelection(selection.selectionId);
        assert.deepEqual(outcome, { kind: 'restored', actionId });

        const after = created.orchestrator.localAction(actionId);
        assert.ok(after);
        assert.equal(after.status, 'awaiting_local_approval');
        assert.equal(after.bindingHash, before.bindingHash);
    });

    it('gibt eine pausierte Aktion nicht frei', async () => {
        const created = await harness({ resources: twoDocuments });
        const actionId = await prepare(created);
        const view = created.orchestrator.localAction(actionId);
        assert.ok(view);

        await created.orchestrator.requestReselection(actionId);

        await assert.rejects(
            () => created.orchestrator.approveAction(actionId, view.bindingHash),
            /steht nicht zur Freigabe/
        );
        assert.equal(created.target.delivered.length, 0);
    });

    it('hält die Aktion am Leben, wenn die erneute Suche nichts liefert', async () => {
        const created = await harness({ resources: twoDocuments });
        const actionId = await prepare(created);

        created.source.failSearch = true;
        await assert.rejects(() => created.orchestrator.requestReselection(actionId), /Kandidaten/);

        const status = created.orchestrator.getActionStatus(actionId);
        assert.equal(status.status, 'awaiting_local_approval');
    });
});
