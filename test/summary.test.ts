import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';
import { LocalModelUnavailableError } from '../src/judge/ollamaClient.js';
import { makeHarness, makeResource, waitForAction, type Harness } from './helpers.js';

/**
 * Redacted summaries.
 *
 * The property under test throughout is the same one the rest of the suite
 * checks for transfers, applied to a payload that is text rather than a file:
 * nothing reaches the agent that a person did not read and release first. So
 * these tests assert at the boundary — what `summarize_resource` answers, what
 * `get_summary` hands over, and what the local view showed the user before
 * either happened.
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

/** Runs find_resource and returns the reference, failing loudly if it did not resolve. */
async function reference(created: Harness): Promise<string> {
    const found = await created.orchestrator.findResource({ query: QUERY, purpose: PURPOSE });
    assert.ok(found.status === 'resolved', `Suche lieferte ${found.status}`);
    return found.resource.reference;
}

describe('summarize_resource antwortet nicht mit Text', () => {
    it('liefert eine Aktion im Wartezustand statt einer Zusammenfassung', async () => {
        const created = await harness();
        const state = await created.orchestrator.summarizeResource({
            reference: await reference(created),
            purpose: PURPOSE
        });

        assert.equal(state.status, 'awaiting_local_approval');
        assert.deepEqual(Object.keys(state).sort(), ['action_id', 'note', 'reason', 'status']);
        assert.match(state.note, /Freigabe/);
        // The answer must not carry the summary, the document, or anything from it.
        const serialised = JSON.stringify(state);
        assert.doesNotMatch(serialised, /Lebenslauf/);
        assert.doesNotMatch(serialised, /Mustermann/);
        assert.doesNotMatch(serialised, /REDACTED/);
    });

    it('legt die Zusammenfassung der lokalen Freigabe vor', async () => {
        const created = await harness();
        const state = await created.orchestrator.summarizeResource({
            reference: await reference(created),
            purpose: PURPOSE
        });

        const pending = created.orchestrator.localPendingActions();
        assert.equal(pending.length, 1);
        const view = pending[0]!;
        assert.equal(view.actionId, state.action_id);
        assert.ok(view.kind === 'summarize_resource');
        assert.match(view.summary.text, /\[REDACTED_NAME\]/);
        assert.equal(view.summary.chars, view.summary.text.length);
        assert.deepEqual(view.summary.redactions, ['REDACTED_NAME', 'REDACTED_ORG']);
    });

    it('gibt das Originaldokument nur an das lokale Modell', async () => {
        const created = await harness();
        await created.orchestrator.summarizeResource({
            reference: await reference(created),
            purpose: PURPOSE
        });

        // Text for the local model, yes. The original bytes, no: those are only
        // ever fetched for a transfer.
        assert.deepEqual(created.source.textFetches, ['4711']);
        assert.deepEqual(created.source.originalFetches, []);
        assert.equal(created.target.delivered.length, 0);
    });
});

describe('der Text verlässt den Rechner erst nach der Freigabe', () => {
    it('hält ihn zurück, solange die Aktion wartet', async () => {
        const created = await harness();
        const state = await created.orchestrator.summarizeResource({
            reference: await reference(created),
            purpose: PURPOSE
        });

        const collected = await created.orchestrator.getSummary(state.action_id);
        assert.equal(collected.status, 'awaiting_local_approval');
        assert.equal(collected.summary, undefined);
        assert.equal(collected.redactions, undefined);
        assert.doesNotMatch(JSON.stringify(collected), /REDACTED/);
    });

    it('gibt nach der Freigabe genau den Text heraus, der lokal angezeigt wurde', async () => {
        const created = await harness();
        const state = await created.orchestrator.summarizeResource({
            reference: await reference(created),
            purpose: PURPOSE
        });
        const view = created.orchestrator.localAction(state.action_id);
        assert.ok(view?.kind === 'summarize_resource');

        await created.orchestrator.approveAction(state.action_id);
        await waitForAction(created.orchestrator, state.action_id, ['completed']);

        const collected = await created.orchestrator.getSummary(state.action_id);
        assert.equal(collected.status, 'completed');
        assert.equal(collected.summary, view.summary.text);
        assert.deepEqual(collected.redactions, ['REDACTED_NAME', 'REDACTED_ORG']);
    });

    it('hält ihn dauerhaft zurück, wenn der Nutzer ablehnt', async () => {
        const created = await harness();
        const state = await created.orchestrator.summarizeResource({
            reference: await reference(created),
            purpose: PURPOSE
        });

        await created.orchestrator.rejectAction(state.action_id);

        const collected = await created.orchestrator.getSummary(state.action_id);
        assert.equal(collected.status, 'rejected');
        assert.equal(collected.summary, undefined);
        assert.match(collected.note, /nicht freigegeben/);
    });

    it('gibt für eine Übertragungsaktion keinen Text heraus', async () => {
        const created = await harness();
        const prepared = await created.orchestrator.prepareAction({
            reference: await reference(created),
            target: 'private_mail',
            purpose: PURPOSE
        });

        const collected = await created.orchestrator.getSummary(prepared.action_id);
        assert.equal(collected.summary, undefined);
        assert.match(collected.note, /keine freigegebene Zusammenfassung/);
    });

    it('kennt keine unbekannte Aktion', async () => {
        const created = await harness();
        const collected = await created.orchestrator.getSummary('act_deadbeefdead');
        assert.equal(collected.status, 'failed');
        assert.equal(collected.summary, undefined);
    });
});

describe('die Freigabe bindet an genau diesen Text', () => {
    it('führt eine Aktion nicht aus, deren Text nach der Anzeige verändert wurde', async () => {
        const created = await harness();
        const state = await created.orchestrator.summarizeResource({
            reference: await reference(created),
            purpose: PURPOSE
        });
        const view = created.orchestrator.localAction(state.action_id);
        assert.ok(view?.kind === 'summarize_resource');

        // Simulate a store edited between rendering and clicking.
        const stored = created.actions.get(state.action_id);
        assert.ok(stored?.plan.kind === 'summarize_resource');
        stored.plan.summary = 'Ein ganz anderer Text mit dem Namen Max Mustermann.';

        await assert.rejects(
            () => created.orchestrator.approveAction(state.action_id),
            /inkonsistent/
        );
        const collected = await created.orchestrator.getSummary(state.action_id);
        assert.equal(collected.summary, undefined);
    });

    it('gibt nichts heraus, wenn der gespeicherte Text nicht zur Prüfsumme passt', async () => {
        const created = await harness();
        const state = await created.orchestrator.summarizeResource({
            reference: await reference(created),
            purpose: PURPOSE
        });
        const view = created.orchestrator.localAction(state.action_id);
        assert.ok(view?.kind === 'summarize_resource');
        await created.orchestrator.approveAction(state.action_id);
        await waitForAction(created.orchestrator, state.action_id, ['completed']);

        // Tampering after the release must still not produce a handover.
        const stored = created.actions.get(state.action_id);
        assert.ok(stored?.plan.kind === 'summarize_resource');
        stored.plan.summary = 'Nachträglich ausgetauschter Text.';

        const collected = await created.orchestrator.getSummary(state.action_id);
        assert.equal(collected.summary, undefined);
        assert.equal(collected.status, 'failed');
    });
});

describe('lokale Prüfung der Zusammenfassung', () => {
    it('legt eine Zusammenfassung mit einer URL vor und warnt, statt sie zu verwerfen', async () => {
        const created = await harness({
            summaryText: 'Das Dokument verweist auf https://intern.example/akte und nennt Fristen.'
        });

        const state = await created.orchestrator.summarizeResource({
            reference: await reference(created),
            purpose: PURPOSE
        });

        assert.equal(state.status, 'awaiting_local_approval');
        const view = created.orchestrator.localAction(state.action_id);
        assert.ok(view?.kind === 'summarize_resource');
        const kinds = view.summary.residuals.map((finding) => finding.kind);
        assert.ok(kinds.includes('Webadresse'), `Fund fehlt: ${kinds.join(', ')}`);
    });

    it('legt eine Zusammenfassung mit einem technischen Pfad vor und warnt', async () => {
        const created = await harness({
            summaryText: 'Die Anleitung beschreibt die Konfiguration unter /etc/nginx im Detail.'
        });

        const state = await created.orchestrator.summarizeResource({
            reference: await reference(created),
            purpose: PURPOSE
        });

        assert.equal(state.status, 'awaiting_local_approval');
        const view = created.orchestrator.localAction(state.action_id);
        assert.ok(view?.kind === 'summarize_resource');
        assert.ok(view.summary.residuals.some((finding) => finding.kind === 'Dateipfad'));
    });

    it('gibt eine freigegebene Zusammenfassung mit URL auch tatsächlich heraus', async () => {
        const summaryText = 'Das Projekt liegt auf https://github.com/example/repo und ist offen.';
        const created = await harness({ summaryText });

        const state = await created.orchestrator.summarizeResource({
            reference: await reference(created),
            purpose: PURPOSE
        });
        await created.orchestrator.approveAction(state.action_id);
        await waitForAction(created.orchestrator, state.action_id, ['completed']);

        // The second guard call, on the way out through `get_summary`, must
        // agree with the first — otherwise the block simply moves later.
        const collected = await created.orchestrator.getSummary(state.action_id);
        assert.equal(collected.summary, summaryText);
    });

    it('verwirft eine Zusammenfassung, die ein registriertes Geheimnis enthält', async () => {
        const created = await harness({
            summaryText: 'Der Zugang lautet sehr-geheimes-passwort und gilt weiterhin.'
        });

        const state = await created.orchestrator.summarizeResource({
            reference: await reference(created),
            purpose: PURPOSE
        });

        assert.equal(state.status, 'failed');
        assert.equal(created.orchestrator.localPendingActions().length, 0);
    });

    it('markiert verdächtige Reste im Text für den Nutzer, ohne ihn zu blockieren', async () => {
        const created = await harness({
            summaryText:
                'Die Bewerbung von [REDACTED_NAME] nennt als Rückfrage kontakt@firma.example ' +
                'sowie das Aktenzeichen 4711-2026-0815.'
        });

        const state = await created.orchestrator.summarizeResource({
            reference: await reference(created),
            purpose: PURPOSE
        });
        assert.equal(state.status, 'awaiting_local_approval');

        const view = created.orchestrator.localAction(state.action_id);
        assert.ok(view?.kind === 'summarize_resource');
        const kinds = view.summary.residuals.map((finding) => finding.kind);
        assert.ok(kinds.includes('E-Mail-Adresse'), `Fund fehlt: ${kinds.join(', ')}`);
        assert.ok(kinds.includes('Nummer oder Kennzeichen'), `Fund fehlt: ${kinds.join(', ')}`);
    });

    it('schlägt bei gewöhnlichem Fließtext mit Zahlen nicht an', async () => {
        const created = await harness({
            summaryText:
                'Die Unterlagen von [REDACTED_NAME] umfassen 12 Seiten und nennen rund 20 Jahre ' +
                'Berufserfahrung in etwa 3 Branchen.'
        });

        const state = await created.orchestrator.summarizeResource({
            reference: await reference(created),
            purpose: PURPOSE
        });
        const view = created.orchestrator.localAction(state.action_id);
        assert.ok(view?.kind === 'summarize_resource');
        assert.deepEqual(view.summary.residuals, []);
    });

    it('meldet einen erfundenen Platzhalter als Fund', async () => {
        const created = await harness({
            summaryText: 'Das Schreiben stammt von [Max Mustermann] und betrifft eine Frist.'
        });

        const state = await created.orchestrator.summarizeResource({
            reference: await reference(created),
            purpose: PURPOSE
        });
        const view = created.orchestrator.localAction(state.action_id);
        assert.ok(view?.kind === 'summarize_resource');
        assert.ok(
            view.summary.residuals.some((finding) => finding.kind === 'unbekannter Platzhalter')
        );
    });
});

describe('dieselben Vorbedingungen wie bei einer Übertragung', () => {
    it('verweigert eine Referenz, die für einen anderen Zweck erstellt wurde', async () => {
        const created = await harness();
        const state = await created.orchestrator.summarizeResource({
            reference: await reference(created),
            purpose: 'Weitergabe an einen Dritten'
        });

        assert.equal(state.status, 'failed');
        assert.match(state.note, /anderen Zweck/);
        assert.equal(created.orchestrator.localPendingActions().length, 0);
    });

    it('verweigert eine Zusammenfassung, wenn sich die Ressource geändert hat', async () => {
        const created = await harness();
        const ref = await reference(created);
        created.source.resources = [makeResource({ stateToken: 'modified:2026-07-01T00:00:00.000Z' })];

        const state = await created.orchestrator.summarizeResource({ reference: ref, purpose: PURPOSE });

        assert.equal(state.status, 'failed');
        assert.equal(state.reason, 'resource_changed');
        assert.deepEqual(created.source.textFetches, []);
    });

    it('fasst nichts zusammen, wenn die Ressource keinen Text hat', async () => {
        const created = await harness();
        const ref = await reference(created);
        created.source.text = undefined;

        const state = await created.orchestrator.summarizeResource({ reference: ref, purpose: PURPOSE });

        assert.equal(state.status, 'failed');
        assert.match(state.note, /kein auswertbarer Text/);
        assert.equal(created.orchestrator.localPendingActions().length, 0);
    });

    it('weicht bei Ausfall des lokalen Modells nicht aus', async () => {
        const created = await harness({
            summaryError: new LocalModelUnavailableError('offline')
        });

        const state = await created.orchestrator.summarizeResource({
            reference: await reference(created),
            purpose: PURPOSE
        });

        assert.equal(state.status, 'failed');
        assert.match(state.note, /keine Ersatzbewertung/);
        assert.equal(created.orchestrator.localPendingActions().length, 0);
    });
});

describe('Nachvollziehbarkeit', () => {
    it('protokolliert Anfrage, Bewertung, Freigabe und Herausgabe', async () => {
        const created = await harness();
        const state = await created.orchestrator.summarizeResource({
            reference: await reference(created),
            purpose: PURPOSE
        });
        const view = created.orchestrator.localAction(state.action_id);
        assert.ok(view?.kind === 'summarize_resource');
        await created.orchestrator.approveAction(state.action_id);
        await waitForAction(created.orchestrator, state.action_id, ['completed']);
        await created.orchestrator.getSummary(state.action_id);

        const events = await created.audit.tail(200);
        for (const expected of ['action_prepared', 'action_approved', 'egress_performed']) {
            assert.ok(
                events.some((event) => event.type === expected),
                `Ereignis ${expected} fehlt im Protokoll`
            );
        }

        // The trail records the digest and the size, not a second copy of the text.
        // The digest is internal now: it is in the stored plan and in the audit,
        // and nowhere on the screen the user decided from.
        const stored = created.actions.get(state.action_id);
        assert.ok(stored?.plan.kind === 'summarize_resource');
        const egress = events.find((event) => event.type === 'egress_performed');
        const detail = egress?.detail as Record<string, unknown>;
        assert.equal(detail.kind, 'summarize_resource');
        assert.equal(detail.summarySha256, stored.plan.summarySha256);
        assert.equal(detail.summaryChars, view.summary.text.length);
        assert.equal(JSON.stringify(detail).includes(view.summary.text), false);
    });
});
