import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';
import { EgressGuard, EgressViolationError, sanitiseLabel } from '../src/core/egress.js';
import { ActionImmutabilityError } from '../src/store/actionStore.js';
import { LocalModelUnavailableError } from '../src/judge/ollamaClient.js';
import {
    makeHarness,
    makeResource,
    waitForAction,
    waitForTerminal,
    TEST_SECRET_TOKEN,
    type Harness
} from './helpers.js';

/**
 * One test per security invariant from the specification. These are the
 * properties the component exists to provide, so they are asserted at the
 * boundary rather than on internals: what Hermes receives, and what reaches a
 * target.
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

describe('Invariante 3 und 4: Hermes erhält nur opake Referenzen, keine Rohdaten', () => {
    it('gibt ausschließlich reference, label und type zurück', async () => {
        const { orchestrator } = await harness();
        const result = await orchestrator.findResource({ query: QUERY, purpose: PURPOSE });

        assert.equal(result.status, 'resolved');
        assert.ok(result.status === 'resolved');
        assert.deepEqual(Object.keys(result.resource).sort(), ['label', 'reference', 'type']);
        assert.match(result.resource.reference, /^res_[0-9a-f]{12}$/);
    });

    it('enthält weder Titelinhalt der Quelle noch interne Kennungen', async () => {
        const { orchestrator } = await harness({
            resources: [makeResource({ title: 'Lebenslauf', locator: { sourceId: 'fake', nativeId: '90210' } })]
        });
        const result = await orchestrator.findResource({ query: QUERY, purpose: PURPOSE });
        const serialised = JSON.stringify(result);

        assert.doesNotMatch(serialised, /90210/, 'native Kennung darf nicht ausgeliefert werden');
        assert.doesNotMatch(serialised, /fake/, 'Quellkennung darf nicht ausgeliefert werden');
        assert.doesNotMatch(serialised, /Berufserfahrung/, 'Inhalt darf nicht ausgeliefert werden');
    });

    it('liefert bei prepare_action keine Zieldetails oder Anhangsnamen', async () => {
        const { orchestrator } = await harness();
        const found = await orchestrator.findResource({ query: QUERY, purpose: PURPOSE });
        assert.ok(found.status === 'resolved');

        const state = await orchestrator.prepareAction({
            reference: found.resource.reference,
            target: 'private_mail',
            purpose: PURPOSE
        });

        assert.deepEqual(Object.keys(state).sort(), ['action_id', 'note', 'reason', 'status']);
        const serialised = JSON.stringify(state);
        assert.doesNotMatch(serialised, /lebenslauf\.pdf/i);
        assert.doesNotMatch(serialised, /example\.org/);
    });
});

describe('Invariante 5: Zugangsdaten und interne Kennungen bleiben lokal', () => {
    it('blockiert registrierte Geheimnisse in einer Ausgabe', () => {
        const guard = new EgressGuard();
        guard.registerSecret(TEST_SECRET_TOKEN);
        assert.throws(
            () => guard.assertClean({ note: `Fehler bei ${TEST_SECRET_TOKEN}` }, 'test'),
            EgressViolationError
        );
    });

    it('blockiert URLs und Dateipfade', () => {
        const guard = new EgressGuard();
        assert.throws(() => guard.assertClean({ note: 'siehe https://paperless.local' }, 'test'), EgressViolationError);
        assert.throws(() => guard.assertClean({ note: 'C:\\Users\\chris\\akte.pdf' }, 'test'), EgressViolationError);
        assert.throws(() => guard.assertClean({ note: 'GET /api/documents/7' }, 'test'), EgressViolationError);
    });

    it('lässt opake Referenzen unbeanstandet durch', () => {
        const guard = new EgressGuard();
        guard.registerSecret(TEST_SECRET_TOKEN);
        assert.doesNotThrow(() =>
            guard.assertClean({ reference: 'res_7f29a1c4b8de', label: 'Aktueller Lebenslauf' }, 'test')
        );
    });

    it('entfernt Struktur- und Pfadzeichen aus Modell-Bezeichnungen', () => {
        assert.equal(sanitiseLabel('  Akte  <script>  /etc/passwd '), 'Akte script etc passwd');
        assert.equal(sanitiseLabel('x'.repeat(200)).length, 80);
    });
});

describe('Invariante 6: nur lokal konfigurierte Ziele', () => {
    it('weist ein unbekanntes Ziel ab, ohne etwas zu übertragen', async () => {
        const { orchestrator, target } = await harness();
        const found = await orchestrator.findResource({ query: QUERY, purpose: PURPOSE });
        assert.ok(found.status === 'resolved');

        const state = await orchestrator.prepareAction({
            reference: found.resource.reference,
            target: 'irgendeine@fremde-adresse.example',
            purpose: PURPOSE
        });

        assert.equal(state.status, 'failed');
        assert.equal(state.reason, 'target_unavailable');
        assert.equal(target.delivered.length, 0);
        assert.equal(orchestrator.localPendingActions().length, 0);
    });

    it('weist einen angegebenen Empfänger für ein fest konfiguriertes Ziel ab', async () => {
        const { orchestrator, target } = await harness();
        const found = await orchestrator.findResource({ query: QUERY, purpose: PURPOSE });
        assert.ok(found.status === 'resolved');

        const state = await orchestrator.prepareAction({
            reference: found.resource.reference,
            target: 'private_mail',
            purpose: PURPOSE,
            recipient: 'jemand@woanders.example'
        });

        assert.equal(state.status, 'failed');
        assert.equal(target.delivered.length, 0);
        assert.equal(orchestrator.localPendingActions().length, 0);
    });

    it('verlangt einen gültigen Empfänger für ein Ziel mit dynamischem Empfänger', async () => {
        const { orchestrator, target } = await harness({ targetDescriptor: { dynamicRecipient: true } });
        const found = await orchestrator.findResource({ query: QUERY, purpose: PURPOSE });
        assert.ok(found.status === 'resolved');

        const withoutRecipient = await orchestrator.prepareAction({
            reference: found.resource.reference,
            target: 'private_mail',
            purpose: PURPOSE
        });
        assert.equal(withoutRecipient.status, 'failed');

        const withMalformedRecipient = await orchestrator.prepareAction({
            reference: found.resource.reference,
            target: 'private_mail',
            purpose: PURPOSE,
            recipient: 'nicht-eine-adresse'
        });
        assert.equal(withMalformedRecipient.status, 'failed');
        assert.equal(target.delivered.length, 0);
        assert.equal(orchestrator.localPendingActions().length, 0);
    });

    it('zeigt den vom Agenten vorgeschlagenen Empfänger unverkürzt und liefert genau an ihn aus', async () => {
        const { orchestrator, target } = await harness({ targetDescriptor: { dynamicRecipient: true } });
        const found = await orchestrator.findResource({ query: QUERY, purpose: PURPOSE });
        assert.ok(found.status === 'resolved');

        const prepared = await orchestrator.prepareAction({
            reference: found.resource.reference,
            target: 'private_mail',
            purpose: PURPOSE,
            recipient: 'jobs@unternehmen.example'
        });
        assert.equal(prepared.status, 'awaiting_local_approval');

        const view = orchestrator.localAction(prepared.action_id);
        assert.ok(view);
        assert.equal(view.target.dynamicRecipient, true);
        assert.equal(view.target.recipientDisplay, 'jobs@unternehmen.example');

        await orchestrator.approveAction(prepared.action_id, view.bindingHash);
        await waitForAction(orchestrator, prepared.action_id, ['completed']);

        assert.equal(target.delivered.length, 1);
        assert.equal(target.delivered[0]?.recipient, 'jobs@unternehmen.example');
    });
});

describe('Invariante 7: jede Übertragung braucht eine lokale Freigabe', () => {
    it('überträgt bei prepare_action nichts', async () => {
        const { orchestrator, target } = await harness();
        const found = await orchestrator.findResource({ query: QUERY, purpose: PURPOSE });
        assert.ok(found.status === 'resolved');

        const state = await orchestrator.prepareAction({
            reference: found.resource.reference,
            target: 'private_mail',
            purpose: PURPOSE
        });

        assert.equal(state.status, 'awaiting_local_approval');
        assert.equal(target.delivered.length, 0);
        assert.equal(orchestrator.localPendingActions().length, 1);
    });

    it('überträgt erst nach der lokalen Freigabe', async () => {
        const { orchestrator, target } = await harness();
        const found = await orchestrator.findResource({ query: QUERY, purpose: PURPOSE });
        assert.ok(found.status === 'resolved');
        const prepared = await orchestrator.prepareAction({
            reference: found.resource.reference,
            target: 'private_mail',
            purpose: PURPOSE
        });

        const view = orchestrator.localAction(prepared.action_id);
        assert.ok(view);
        await orchestrator.approveAction(prepared.action_id, view.bindingHash);
        await waitForAction(orchestrator, prepared.action_id, ['completed']);

        assert.equal(target.delivered.length, 1);
        assert.equal(target.delivered[0]?.attachments.length, 1);
        assert.equal(target.delivered[0]?.attachments[0]?.filename, 'lebenslauf.pdf');
        assert.equal(orchestrator.getActionStatus(prepared.action_id).status, 'completed');
    });

    it('überträgt nichts, wenn der Nutzer ablehnt', async () => {
        const { orchestrator, target } = await harness();
        const found = await orchestrator.findResource({ query: QUERY, purpose: PURPOSE });
        assert.ok(found.status === 'resolved');
        const prepared = await orchestrator.prepareAction({
            reference: found.resource.reference,
            target: 'private_mail',
            purpose: PURPOSE
        });

        await orchestrator.rejectAction(prepared.action_id);

        assert.equal(target.delivered.length, 0);
        const status = orchestrator.getActionStatus(prepared.action_id);
        assert.equal(status.status, 'rejected');
        assert.equal(status.reason, 'user_rejected');
    });
});

describe('Invariante 12: freigegebene Aktionen sind unveränderlich', () => {
    it('verweigert die Freigabe, wenn die angezeigte Bindung nicht passt', async () => {
        const { orchestrator, target } = await harness();
        const found = await orchestrator.findResource({ query: QUERY, purpose: PURPOSE });
        assert.ok(found.status === 'resolved');
        const prepared = await orchestrator.prepareAction({
            reference: found.resource.reference,
            target: 'private_mail',
            purpose: PURPOSE
        });

        await assert.rejects(
            () => orchestrator.approveAction(prepared.action_id, 'a'.repeat(64)),
            /stimmt nicht mehr/
        );
        assert.equal(target.delivered.length, 0);
        assert.equal(orchestrator.getActionStatus(prepared.action_id).status, 'awaiting_local_approval');
    });

    it('lässt einen abgeschlossenen Vorgang nicht erneut wechseln', async () => {
        const { orchestrator, actions } = await harness();
        const found = await orchestrator.findResource({ query: QUERY, purpose: PURPOSE });
        assert.ok(found.status === 'resolved');
        const prepared = await orchestrator.prepareAction({
            reference: found.resource.reference,
            target: 'private_mail',
            purpose: PURPOSE
        });
        const view = orchestrator.localAction(prepared.action_id);
        assert.ok(view);
        await orchestrator.approveAction(prepared.action_id, view.bindingHash);
        await waitForAction(orchestrator, prepared.action_id, ['completed']);

        await assert.rejects(
            () => actions.transition(prepared.action_id, 'executing'),
            ActionImmutabilityError
        );
    });

    it('verweigert eine zweite Freigabe derselben Aktion', async () => {
        const { orchestrator, target } = await harness();
        const found = await orchestrator.findResource({ query: QUERY, purpose: PURPOSE });
        assert.ok(found.status === 'resolved');
        const prepared = await orchestrator.prepareAction({
            reference: found.resource.reference,
            target: 'private_mail',
            purpose: PURPOSE
        });
        const view = orchestrator.localAction(prepared.action_id);
        assert.ok(view);

        await orchestrator.approveAction(prepared.action_id, view.bindingHash);
        await waitForAction(orchestrator, prepared.action_id, ['completed']);
        await assert.rejects(
            () => orchestrator.approveAction(prepared.action_id, view.bindingHash),
            /steht nicht zur Freigabe/
        );
        assert.equal(target.delivered.length, 1, 'genau eine Übertragung');
    });

    it('verweigert die Vorbereitung, wenn sich die Ressource geändert hat', async () => {
        const { orchestrator, source, target } = await harness();
        const found = await orchestrator.findResource({ query: QUERY, purpose: PURPOSE });
        assert.ok(found.status === 'resolved');

        // The document is edited in Paperless after the reference was minted.
        source.resources = [makeResource({ stateToken: 'modified:2026-07-01T00:00:00.000Z' })];

        const state = await orchestrator.prepareAction({
            reference: found.resource.reference,
            target: 'private_mail',
            purpose: PURPOSE
        });

        assert.equal(state.status, 'failed');
        assert.equal(state.reason, 'resource_changed');
        assert.equal(target.delivered.length, 0);
    });

    it('bricht die Ausführung ab, wenn die Bytes von der Freigabe abweichen', async () => {
        const { orchestrator, source, target } = await harness();
        const found = await orchestrator.findResource({ query: QUERY, purpose: PURPOSE });
        assert.ok(found.status === 'resolved');
        const prepared = await orchestrator.prepareAction({
            reference: found.resource.reference,
            target: 'private_mail',
            purpose: PURPOSE
        });
        const view = orchestrator.localAction(prepared.action_id);
        assert.ok(view);

        // Simulate the staged copy being gone (restart) and the source now holding
        // different bytes than the ones the user approved.
        await orchestrator.sweep();
        source.bytes = new Uint8Array([9, 9, 9]);
        (orchestrator as unknown as { staged: Map<string, unknown> }).staged.delete(prepared.action_id);

        await orchestrator.approveAction(prepared.action_id, view.bindingHash);
        await waitForTerminal(orchestrator, prepared.action_id);

        assert.equal(target.delivered.length, 0);
        assert.equal(orchestrator.getActionStatus(prepared.action_id).status, 'failed');
    });
});

describe('Invariante 9: bei Mehrdeutigkeit wird nicht automatisch gehandelt', () => {
    it('fordert eine lokale Auswahl an statt zu raten', async () => {
        const { orchestrator, target } = await harness({
            judge: { kind: 'ambiguous' },
            resources: [makeResource(), makeResource({ locator: { sourceId: 'fake', nativeId: '4712' } })]
        });

        const result = await orchestrator.findResource({ query: QUERY, purpose: PURPOSE });

        assert.equal(result.status, 'selection_required');
        assert.ok(result.status === 'selection_required');
        assert.match(result.selection_reference, /^sel_[0-9a-f]{12}$/);
        assert.equal(target.delivered.length, 0);
        assert.equal(orchestrator.localOpenSelections().length, 1);
    });

    it('liefert nach der lokalen Auswahl eine Referenz und keine Kandidatendaten', async () => {
        const { orchestrator } = await harness({
            judge: { kind: 'ambiguous' },
            resources: [makeResource(), makeResource({ locator: { sourceId: 'fake', nativeId: '4712' } })]
        });
        const result = await orchestrator.findResource({ query: QUERY, purpose: PURPOSE });
        assert.ok(result.status === 'selection_required');

        const pending = orchestrator.localOpenSelections()[0];
        assert.ok(pending);
        await orchestrator.resolveSelection(pending.selectionId, pending.candidates[1]!.candidateId);

        const resumed = await orchestrator.findResource({
            query: QUERY,
            purpose: PURPOSE,
            pendingSelection: result.selection_reference
        });
        assert.ok(resumed.status === 'resolved');
        assert.deepEqual(Object.keys(resumed.resource).sort(), ['label', 'reference', 'type']);
        assert.doesNotMatch(JSON.stringify(resumed), /4712/);
    });

    it('meldet eine noch offene Auswahl als selection_pending', async () => {
        const { orchestrator } = await harness({ judge: { kind: 'ambiguous' } });
        const result = await orchestrator.findResource({ query: QUERY, purpose: PURPOSE });
        assert.ok(result.status === 'selection_required');

        const resumed = await orchestrator.findResource({
            query: QUERY,
            purpose: PURPOSE,
            pendingSelection: result.selection_reference
        });
        assert.equal(resumed.status, 'selection_pending');
    });
});

describe('Invariante 10: kein Cloud-Fallback bei Ausfall des lokalen Modells', () => {
    it('meldet unavailable und sucht keinen Ersatz', async () => {
        const { orchestrator, target } = await harness({
            judge: { kind: 'throw', error: new LocalModelUnavailableError('offline') }
        });

        const result = await orchestrator.findResource({ query: QUERY, purpose: PURPOSE });

        assert.equal(result.status, 'unavailable');
        assert.match(result.note, /keine Ersatzbewertung/);
        assert.equal(target.delivered.length, 0);
    });

    it('bereitet keine Aktion vor, wenn die Bewertung ausfällt', async () => {
        const goodHarness = await harness();
        const found = await goodHarness.orchestrator.findResource({ query: QUERY, purpose: PURPOSE });
        assert.ok(found.status === 'resolved');

        // A second orchestrator over the same stores, but with a broken model.
        const broken = await harness({ judge: { kind: 'throw', error: new LocalModelUnavailableError('offline') } });
        const state = await broken.orchestrator.prepareAction({
            reference: 'res_000000000000',
            target: 'private_mail',
            purpose: PURPOSE
        });
        assert.equal(state.status, 'failed');
        assert.equal(broken.target.delivered.length, 0);
    });
});

describe('Zweckbindung der Referenz', () => {
    it('verweigert die Verwendung einer Referenz für einen anderen Zweck', async () => {
        const { orchestrator, target } = await harness();
        const found = await orchestrator.findResource({ query: QUERY, purpose: PURPOSE });
        assert.ok(found.status === 'resolved');

        const state = await orchestrator.prepareAction({
            reference: found.resource.reference,
            target: 'private_mail',
            purpose: 'Weiterleitung an einen Dritten'
        });

        assert.equal(state.status, 'failed');
        assert.match(state.note, /anderen Zweck/);
        assert.equal(target.delivered.length, 0);
    });

    it('akzeptiert denselben Zweck in anderer Schreibweise', async () => {
        const { orchestrator } = await harness();
        const found = await orchestrator.findResource({ query: QUERY, purpose: PURPOSE });
        assert.ok(found.status === 'resolved');

        const state = await orchestrator.prepareAction({
            reference: found.resource.reference,
            target: 'private_mail',
            purpose: '  bewerbung auf EINE stelle  '
        });
        assert.equal(state.status, 'awaiting_local_approval');
    });

    it('weist eine unbekannte Referenz ab', async () => {
        const { orchestrator } = await harness();
        const state = await orchestrator.prepareAction({
            reference: 'res_deadbeefdead',
            target: 'private_mail',
            purpose: PURPOSE
        });
        assert.equal(state.status, 'failed');
        assert.match(state.note, /unbekannt/);
    });
});

describe('Invariante 14: lokale Nachvollziehbarkeit', () => {
    it('protokolliert Anfrage, Bewertung, Freigabe und Übertragung', async () => {
        const { orchestrator, audit } = await harness();
        const found = await orchestrator.findResource({ query: QUERY, purpose: PURPOSE });
        assert.ok(found.status === 'resolved');
        const prepared = await orchestrator.prepareAction({
            reference: found.resource.reference,
            target: 'private_mail',
            purpose: PURPOSE
        });
        const view = orchestrator.localAction(prepared.action_id);
        assert.ok(view);
        await orchestrator.approveAction(prepared.action_id, view.bindingHash);
        await waitForAction(orchestrator, prepared.action_id, ['completed']);

        const types = (await audit.tail(200)).map((event) => event.type);
        for (const expected of [
            'hermes_request',
            'source_queried',
            'reference_minted',
            'action_prepared',
            'action_approved',
            'egress_performed'
        ]) {
            assert.ok(types.includes(expected as never), `Ereignis ${expected} fehlt im Protokoll`);
        }
    });

    it('hält im Protokoll fest, was genau das System verlassen hat', async () => {
        const { orchestrator, audit } = await harness();
        const found = await orchestrator.findResource({ query: QUERY, purpose: PURPOSE });
        assert.ok(found.status === 'resolved');
        const prepared = await orchestrator.prepareAction({
            reference: found.resource.reference,
            target: 'private_mail',
            purpose: PURPOSE
        });
        const view = orchestrator.localAction(prepared.action_id);
        assert.ok(view);
        await orchestrator.approveAction(prepared.action_id, view.bindingHash);
        await waitForAction(orchestrator, prepared.action_id, ['completed']);

        const egress = (await audit.tail(200)).find((event) => event.type === 'egress_performed');
        assert.ok(egress);
        const detail = egress.detail as Record<string, unknown>;
        assert.equal(detail.recipientDisplay, 'i**@example.org');
        assert.ok(Array.isArray(detail.attachments));
        assert.ok(typeof detail.bodySha256 === 'string');
    });
});

describe('Fehler beim Ziel', () => {
    it('markiert die Aktion als fehlgeschlagen, ohne teilweise zu übertragen', async () => {
        const { orchestrator, target } = await harness();
        const found = await orchestrator.findResource({ query: QUERY, purpose: PURPOSE });
        assert.ok(found.status === 'resolved');
        const prepared = await orchestrator.prepareAction({
            reference: found.resource.reference,
            target: 'private_mail',
            purpose: PURPOSE
        });
        const view = orchestrator.localAction(prepared.action_id);
        assert.ok(view);

        target.failDelivery = true;
        await orchestrator.approveAction(prepared.action_id, view.bindingHash);
        await waitForTerminal(orchestrator, prepared.action_id);

        assert.equal(target.delivered.length, 0);
        const status = orchestrator.getActionStatus(prepared.action_id);
        assert.equal(status.status, 'failed');
    });
});

describe('Quelle nicht verfügbar', () => {
    it('meldet unavailable, wenn keine Quelle verbunden ist', async () => {
        const created = await harness();
        created.source.available = false;
        const result = await created.orchestrator.findResource({ query: QUERY, purpose: PURPOSE });
        assert.equal(result.status, 'unavailable');
        assert.match(result.note, /Datenquelle/);
    });

    it('meldet not_found, wenn die Suche in der Quelle scheitert', async () => {
        const created = await harness();
        created.source.failSearch = true;
        const result = await created.orchestrator.findResource({ query: QUERY, purpose: PURPOSE });
        assert.equal(result.status, 'not_found');
    });
});
