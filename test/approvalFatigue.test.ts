import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';
import { makeHarness, makeResource, waitForTerminal, type Harness } from './helpers.js';

/**
 * FR15 — the gateway's answer to volume rather than to forgery.
 *
 * Every case here asserts two things at once: that the refusal happened, and
 * that it cost nothing. A protection against flooding that still reads the
 * source and runs the local model per refused call is not a protection.
 */

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

/** One fresh reference per call; each search mints its own. */
async function reference(created: Harness, index = 0): Promise<string> {
    const found = await created.orchestrator.findResource({
        query: `${QUERY} ${index}`,
        purpose: PURPOSE
    });
    assert.ok(found.status === 'resolved', JSON.stringify(found));
    return found.resource.reference;
}

describe('Schutz gegen Approval Fatigue: Obergrenze offener Aktionen', () => {
    it('lehnt eine weitere Vorbereitung ab, sobald das Limit erreicht ist', async () => {
        const created = await harness({ config: { approval: { maxOpenActions: 2 } } });

        for (let index = 0; index < 2; index += 1) {
            const state = await created.orchestrator.prepareAction({
                reference: await reference(created, index),
                target: 'private_mail',
                purpose: PURPOSE
            });
            assert.equal(state.status, 'awaiting_local_approval');
        }

        const fetchesBefore = created.source.originalFetches.length;
        const refused = await created.orchestrator.prepareAction({
            reference: await reference(created, 2),
            target: 'private_mail',
            purpose: PURPOSE
        });

        assert.equal(refused.status, 'failed');
        assert.match(refused.note, /zu viele Aktionen auf die lokale Freigabe/);
        assert.equal(created.orchestrator.localPendingActions().length, 2);
        assert.equal(
            created.source.originalFetches.length,
            fetchesBefore,
            'eine abgelehnte Vorbereitung liest die Quelle nicht'
        );
    });

    it('zählt eine geparkte Aktion mit, weil sie den Nutzer ebenso beschäftigt', async () => {
        const created = await harness({ config: { approval: { maxOpenActions: 1 } } });
        const first = await created.orchestrator.prepareAction({
            reference: await reference(created, 0),
            target: 'private_mail',
            purpose: PURPOSE
        });
        await created.actions.transition(first.action_id, 'selection_required');

        const refused = await created.orchestrator.prepareAction({
            reference: await reference(created, 1),
            target: 'private_mail',
            purpose: PURPOSE
        });
        assert.equal(refused.status, 'failed');
        assert.match(refused.note, /zu viele Aktionen/);
    });

    it('gibt den Platz frei, sobald der Nutzer entschieden hat', async () => {
        const created = await harness({ config: { approval: { maxOpenActions: 1 } } });
        const first = await created.orchestrator.prepareAction({
            reference: await reference(created, 0),
            target: 'private_mail',
            purpose: PURPOSE
        });
        await created.orchestrator.rejectAction(first.action_id);

        const second = await created.orchestrator.prepareAction({
            reference: await reference(created, 1),
            target: 'private_mail',
            purpose: PURPOSE
        });
        assert.equal(second.status, 'awaiting_local_approval');
    });
});

describe('Schutz gegen Approval Fatigue: Rate Limit', () => {
    it('bremst den Agenten nach der konfigurierten Anzahl im Fenster', async () => {
        const created = await harness({
            config: {
                approval: { maxOpenActions: 50, maxPreparedPerWindow: 2, rateLimitWindowSeconds: 3600 }
            }
        });

        for (let index = 0; index < 2; index += 1) {
            const state = await created.orchestrator.prepareAction({
                reference: await reference(created, index),
                target: 'private_mail',
                purpose: PURPOSE
            });
            assert.equal(state.status, 'awaiting_local_approval');
        }

        const refused = await created.orchestrator.prepareAction({
            reference: await reference(created, 2),
            target: 'private_mail',
            purpose: PURPOSE
        });
        assert.equal(refused.status, 'failed');
        assert.match(refused.note, /zu viele Aktionen vorbereitet/);
    });

    it('rechnet abgelehnte Anfragen nicht gegen das Kontingent', async () => {
        const created = await harness({
            config: {
                approval: { maxOpenActions: 1, maxPreparedPerWindow: 3, rateLimitWindowSeconds: 3600 }
            }
        });

        const first = await created.orchestrator.prepareAction({
            reference: await reference(created, 0),
            target: 'private_mail',
            purpose: PURPOSE
        });
        assert.equal(first.status, 'awaiting_local_approval');

        // Five refusals against the open-action ceiling — none of them may eat
        // into the rate budget, or a retry loop would lock out real work.
        for (let index = 0; index < 5; index += 1) {
            const refused = await created.orchestrator.prepareAction({
                reference: await reference(created, index + 1),
                target: 'private_mail',
                purpose: PURPOSE
            });
            assert.equal(refused.status, 'failed');
        }

        await created.orchestrator.rejectAction(first.action_id);
        const second = await created.orchestrator.prepareAction({
            reference: await reference(created, 10),
            target: 'private_mail',
            purpose: PURPOSE
        });
        assert.equal(second.status, 'awaiting_local_approval');
    });
});

describe('Schutz gegen Approval Fatigue: identische Anfragen', () => {
    it('legt eine gleichlautende Anfrage nicht ein zweites Mal vor', async () => {
        const created = await harness();
        const ref = await reference(created, 0);

        const first = await created.orchestrator.prepareAction({
            reference: ref,
            target: 'private_mail',
            purpose: PURPOSE,
            subject: 'Bewerbung',
            body: 'Anbei die Unterlagen.'
        });
        assert.equal(first.status, 'awaiting_local_approval');

        const fetchesBefore = created.source.originalFetches.length;
        const second = await created.orchestrator.prepareAction({
            reference: ref,
            target: 'private_mail',
            purpose: PURPOSE,
            subject: 'Bewerbung',
            body: 'Anbei die Unterlagen.'
        });

        assert.equal(second.status, 'failed');
        assert.match(second.note, /gleichlautende Aktion/);
        assert.equal(created.orchestrator.localPendingActions().length, 1);
        assert.equal(created.source.originalFetches.length, fetchesBefore);
    });

    it('lässt eine geänderte Anfrage als eigene Aktion durch', async () => {
        const created = await harness();
        const ref = await reference(created, 0);

        const first = await created.orchestrator.prepareAction({
            reference: ref,
            target: 'private_mail',
            purpose: PURPOSE,
            subject: 'Bewerbung'
        });
        const second = await created.orchestrator.prepareAction({
            reference: ref,
            target: 'private_mail',
            purpose: PURPOSE,
            subject: 'Bewerbung, korrigiert'
        });

        assert.equal(second.status, 'awaiting_local_approval');
        assert.notEqual(first.action_id, second.action_id);
        // Both stay open: there is no edit path, so the user decides on each.
        assert.equal(created.orchestrator.localPendingActions().length, 2);
    });

    it('erkennt ein Duplikat auch bei lokal verfasstem Text', async () => {
        const created = await harness();
        const ref = await reference(created, 0);

        await created.orchestrator.prepareAction({
            reference: ref,
            target: 'private_mail',
            purpose: PURPOSE
        });
        // The generated body carries a timestamp, so the two plans differ byte
        // for byte. The comparison is over the request, which does not.
        const second = await created.orchestrator.prepareAction({
            reference: ref,
            target: 'private_mail',
            purpose: PURPOSE
        });

        assert.equal(second.status, 'failed');
        assert.match(second.note, /gleichlautende Aktion/);
    });

    it('unterscheidet zwei Anfragen an einem abweichenden Agentenhinweis', async () => {
        const created = await harness();
        const ref = await reference(created, 0);

        await created.orchestrator.prepareAction({
            reference: ref,
            target: 'private_mail',
            purpose: PURPOSE,
            note: 'Erster Hinweis'
        });
        const second = await created.orchestrator.prepareAction({
            reference: ref,
            target: 'private_mail',
            purpose: PURPOSE,
            note: 'Zweiter Hinweis'
        });

        assert.equal(second.status, 'awaiting_local_approval');
    });

    it('erkennt auch eine wiederholte Zusammenfassungsanfrage', async () => {
        const created = await harness();
        const ref = await reference(created, 0);

        const first = await created.orchestrator.summarizeResource({
            reference: ref,
            purpose: PURPOSE
        });
        assert.equal(first.status, 'awaiting_local_approval');

        const second = await created.orchestrator.summarizeResource({
            reference: ref,
            purpose: PURPOSE
        });
        assert.equal(second.status, 'failed');
        assert.match(second.note, /gleichlautende Aktion/);
    });

    it('trennt Versand und Zusammenfassung derselben Ressource', async () => {
        const created = await harness();
        const ref = await reference(created, 0);

        await created.orchestrator.prepareAction({
            reference: ref,
            target: 'private_mail',
            purpose: PURPOSE
        });
        const summary = await created.orchestrator.summarizeResource({
            reference: ref,
            purpose: PURPOSE
        });

        assert.equal(summary.status, 'awaiting_local_approval');
    });
});

describe('Schutz gegen Approval Fatigue: erstmalige dynamische Empfänger', () => {
    const dynamicTarget = {
        targetDescriptor: { dynamicRecipient: true, recipientDisplay: 'frei wählbar' }
    } as const;

    it('markiert eine noch nie freigegebene Adresse', async () => {
        const created = await harness({ ...dynamicTarget, resources: [makeResource()] });
        const state = await created.orchestrator.prepareAction({
            reference: await reference(created, 0),
            target: 'private_mail',
            purpose: PURPOSE,
            recipient: 'jobs@example.org'
        });

        const view = created.orchestrator.localAction(state.action_id);
        assert.ok(view?.kind === 'send_resource');
        assert.equal(view.target.firstTimeRecipient, true);
    });

    it('merkt sich die Adresse mit der Freigabe, nicht erst mit der Zustellung', async () => {
        const created = await harness({ ...dynamicTarget, resources: [makeResource()] });
        const first = await created.orchestrator.prepareAction({
            reference: await reference(created, 0),
            target: 'private_mail',
            purpose: PURPOSE,
            recipient: 'jobs@example.org'
        });
        await created.orchestrator.approveAction(first.action_id);
        await waitForTerminal(created.orchestrator, first.action_id);

        const second = await created.orchestrator.prepareAction({
            reference: await reference(created, 1),
            target: 'private_mail',
            purpose: PURPOSE,
            recipient: 'jobs@example.org'
        });
        const view = created.orchestrator.localAction(second.action_id);
        assert.ok(view?.kind === 'send_resource');
        assert.equal(view.target.firstTimeRecipient, false);
    });

    it('behandelt eine andere Adresse weiterhin als erstmalig', async () => {
        const created = await harness({ ...dynamicTarget, resources: [makeResource()] });
        const first = await created.orchestrator.prepareAction({
            reference: await reference(created, 0),
            target: 'private_mail',
            purpose: PURPOSE,
            recipient: 'jobs@example.org'
        });
        await created.orchestrator.approveAction(first.action_id);
        await waitForTerminal(created.orchestrator, first.action_id);

        const second = await created.orchestrator.prepareAction({
            reference: await reference(created, 1),
            target: 'private_mail',
            purpose: PURPOSE,
            recipient: 'jobs@example.com'
        });
        const view = created.orchestrator.localAction(second.action_id);
        assert.ok(view?.kind === 'send_resource');
        assert.equal(
            view.target.firstTimeRecipient,
            true,
            'eine ähnlich aussehende Domain ist keine bekannte Adresse'
        );
    });

    it('überlebt einen Neustart, damit eine bekannte Adresse bekannt bleibt', async () => {
        const created = await harness({ ...dynamicTarget, resources: [makeResource()] });
        const first = await created.orchestrator.prepareAction({
            reference: await reference(created, 0),
            target: 'private_mail',
            purpose: PURPOSE,
            recipient: 'jobs@example.org'
        });
        await created.orchestrator.approveAction(first.action_id);
        await waitForTerminal(created.orchestrator, first.action_id);

        const { RecipientStore } = await import('../src/store/recipientStore.js');
        const reopened = new RecipientStore(created.dataDir);
        await reopened.load();
        assert.equal(reopened.isKnown('private_mail', 'jobs@example.org'), true);
        assert.equal(reopened.isKnown('private_mail', 'jobs@example.com'), false);
    });

    it('meldet für ein fest konfiguriertes Ziel keinen erstmaligen Empfänger', async () => {
        const created = await harness();
        const state = await created.orchestrator.prepareAction({
            reference: await reference(created, 0),
            target: 'private_mail',
            purpose: PURPOSE
        });
        const view = created.orchestrator.localAction(state.action_id);
        assert.ok(view?.kind === 'send_resource');
        assert.equal(view.target.firstTimeRecipient, false);
    });
});
