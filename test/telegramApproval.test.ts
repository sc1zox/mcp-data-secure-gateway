import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';
import { makeHarness, waitForTerminal, type Harness } from './helpers.js';
import { TelegramSettingsStore } from '../src/approval/settingsStore.js';
import {
    TelegramApprovalAdapter,
    type TelegramApiResult,
    type TelegramHttpClient,
    type TelegramUpdate
} from '../src/approval/telegramApproval.js';

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
const CHAT_ID = '42';
const ALLOWED_USER_ID = '99';

/** Runs find + prepare and hands back the action id, exactly like the browser flow does. */
async function prepare(created: Harness): Promise<string> {
    const found = await created.orchestrator.findResource({ query: QUERY, purpose: PURPOSE });
    assert.ok(found.status === 'resolved');
    const prepared = await created.orchestrator.prepareAction({
        reference: found.resource.reference,
        target: 'private_mail',
        purpose: PURPOSE
    });
    assert.equal(prepared.status, 'awaiting_local_approval');
    return prepared.action_id;
}

async function activeSettings(dataDir: string): Promise<TelegramSettingsStore> {
    const store = new TelegramSettingsStore(
        dataDir,
        'test-master-key-with-at-least-thirty-two-characters'
    );
    await store.load();
    await store.update({
        enabled: true,
        botToken: 'bot-token-123456',
        chatId: CHAT_ID,
        allowedUserId: ALLOWED_USER_ID
    });
    return store;
}

/** Records every call the adapter makes and answers `getUpdates` from a queue, never a real network. */
class FakeTelegramClient implements TelegramHttpClient {
    readonly calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    private readonly updateQueue: TelegramApiResult[] = [];
    private nextMessageId = 1;
    failNextGetUpdatesWith: Error | undefined;

    queueUpdates(...updates: TelegramUpdate[]): void {
        this.updateQueue.push({ ok: true, result: updates });
    }

    async call(method: string, body: Record<string, unknown>): Promise<TelegramApiResult> {
        this.calls.push({ method, body });
        if (method === 'getUpdates') {
            if (this.failNextGetUpdatesWith) {
                const error = this.failNextGetUpdatesWith;
                this.failNextGetUpdatesWith = undefined;
                throw error;
            }
            return this.updateQueue.shift() ?? { ok: true, result: [] };
        }
        if (method === 'sendMessage') {
            return { ok: true, result: { message_id: this.nextMessageId++ } };
        }
        return { ok: true, result: {} };
    }

    sendMessageCalls(): Array<{ method: string; body: Record<string, unknown> }> {
        return this.calls.filter((call) => call.method === 'sendMessage');
    }

    answerCalls(): Array<{ method: string; body: Record<string, unknown> }> {
        return this.calls.filter((call) => call.method === 'answerCallbackQuery');
    }
}

/** Polls, like `waitForAction` in helpers.ts, since delivery and audit writes are fire-and-forget. */
async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) {
            return;
        }
        await new Promise((resolveTick) => setTimeout(resolveTick, 5));
    }
    throw new Error('Bedingung nicht innerhalb der Frist erfüllt.');
}

function callbackDataOf(client: FakeTelegramClient, decision: 'a' | 'r'): string {
    const last = client.sendMessageCalls().at(-1);
    assert.ok(last, 'keine sendMessage-Aufrufe aufgezeichnet');
    const markup = last.body.reply_markup as
        | { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }
        | undefined;
    assert.ok(markup, 'letzte Nachricht trägt keine Tastatur');
    const button = markup.inline_keyboard[0]?.find((candidate) => candidate.callback_data.startsWith(`${decision}:`));
    assert.ok(button, `kein ${decision}-Button gefunden`);
    return button.callback_data;
}

function callbackUpdate(
    data: string,
    overrides: { chatId?: string; userId?: string; updateId?: number } = {}
): TelegramUpdate {
    return {
        update_id: overrides.updateId ?? 1,
        callback_query: {
            id: `cbq-${overrides.updateId ?? 1}`,
            from: { id: overrides.userId ?? ALLOWED_USER_ID },
            message: { chat: { id: overrides.chatId ?? CHAT_ID } },
            data
        }
    };
}

/** The keyboard on the last message, or `undefined` when none was attached. */
function keyboardOf(client: FakeTelegramClient): Array<{ text: string; callback_data: string }> {
    const last = client.sendMessageCalls().at(-1);
    assert.ok(last, 'keine sendMessage-Aufrufe aufgezeichnet');
    const markup = last.body.reply_markup as
        | { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }
        | undefined;
    assert.ok(markup, 'letzte Nachricht trägt keine Tastatur');
    return markup.inline_keyboard[0] ?? [];
}

/** Everything the adapter sent, as one string. */
function sentText(client: FakeTelegramClient): string {
    return client
        .sendMessageCalls()
        .map((call) => call.body.text as string)
        .join('\n');
}

describe('Telegram-Freigabekanal: Textprojektion', () => {
    it('rendert weder webUrl noch Originaldateien, nur die Portalinhalte', async () => {
        const created = await harness();
        created.source.resources[0]!.attributes = { Korrespondent: 'Eigene Unterlagen' };
        const actionId = await prepare(created);
        const settings = await activeSettings(created.dataDir);
        const client = new FakeTelegramClient();
        const adapter = new TelegramApprovalAdapter(
            created.orchestrator,
            created.audit,
            settings,
            undefined,
            client
        );

        const view = created.orchestrator.localPendingActions().find((v) => v.actionId === actionId)!;
        adapter.notifyPending(view);
        await waitUntil(() => client.sendMessageCalls().length > 0);

        const text = sentText(client);
        assert.ok(text.includes(actionId));
        assert.ok(!text.includes('http://'));
        assert.ok(!text.includes('https://'));
        assert.ok(!/webUrl/i.test(text));
    });

    it('sendet Dokumentname, Modellbewertung und den ausgehenden Text, aber keinen Dokumentinhalt', async () => {
        const created = await harness();
        created.source.resources[0]!.attributes = { Korrespondent: 'Finanzamt Musterstadt' };
        created.source.resources[0]!.excerpt = 'Steuernummer 123/456/78900, Erstattung 1.234,56 EUR.';
        const found = await created.orchestrator.findResource({ query: QUERY, purpose: PURPOSE });
        assert.ok(found.status === 'resolved');
        const prepared = await created.orchestrator.prepareAction({
            reference: found.resource.reference,
            target: 'private_mail',
            purpose: PURPOSE,
            subject: 'Bescheid Musterstadt',
            body: 'Anbei der Bescheid über die Erstattung.'
        });
        const settings = await activeSettings(created.dataDir);
        const client = new FakeTelegramClient();
        const adapter = new TelegramApprovalAdapter(
            created.orchestrator,
            created.audit,
            settings,
            undefined,
            client
        );

        const view = created.orchestrator
            .localPendingActions()
            .find((v) => v.actionId === prepared.action_id)!;
        adapter.notifyPending(view);
        await waitUntil(() => client.sendMessageCalls().length > 0);

        const text = sentText(client);
        // Name, verdict and the characters that would be sent as text.
        assert.ok(text.includes('Lebenslauf 2026'));
        assert.match(text, /Sensibilität/);
        assert.ok(text.includes('Bescheid Musterstadt'));
        assert.ok(text.includes('Anbei der Bescheid über die Erstattung.'));
        // Read out of the document, and everything that narrates it.
        assert.ok(!text.includes('Steuernummer'));
        assert.ok(!text.includes('Finanzamt Musterstadt'));
        assert.ok(!text.includes('Testbegründung'));
    });

    it('zeigt den Zusammenfassungstext nicht', async () => {
        const created = await harness();
        const found = await created.orchestrator.findResource({ query: QUERY, purpose: PURPOSE });
        assert.ok(found.status === 'resolved');
        const prepared = await created.orchestrator.summarizeResource({
            reference: found.resource.reference,
            purpose: PURPOSE
        });
        const settings = await activeSettings(created.dataDir);
        const client = new FakeTelegramClient();
        const adapter = new TelegramApprovalAdapter(
            created.orchestrator,
            created.audit,
            settings,
            undefined,
            client
        );

        const view = created.orchestrator
            .localPendingActions()
            .find((v) => v.actionId === prepared.action_id)!;
        assert.ok(view.kind === 'summarize_resource');
        adapter.notifyPending(view);
        await waitUntil(() => client.sendMessageCalls().length > 0);

        const text = sentText(client);
        assert.ok(!text.includes(view.summary.text));
        assert.ok(!text.includes('Es handelt sich um'));
        // What stays is the handle that lets the user find this in the portal.
        assert.ok(text.includes(view.actionId));
    });

    it('teilt eine lange Nachricht in nummerierte Teile und setzt Buttons nur auf den letzten', async () => {
        const created = await harness();
        const actionId = await prepare(created);
        const settings = await activeSettings(created.dataDir);
        const client = new FakeTelegramClient();
        const adapter = new TelegramApprovalAdapter(
            created.orchestrator,
            created.audit,
            settings,
            undefined,
            client
        );

        const original = created.orchestrator.localPendingActions().find((v) => v.actionId === actionId)!;
        // A view carries whatever the plan builder produced; grafting a long attachment
        // list onto the real view is the simplest way to force a multi-part message
        // without reaching into private render internals.
        const attachment = original.kind === 'send_resource' ? original.egress.attachments[0] : undefined;
        assert.ok(attachment);
        const oversized =
            original.kind === 'send_resource'
                ? {
                      ...original,
                      egress: {
                          ...original.egress,
                          attachments: Array.from({ length: 400 }, (_unused, index) => ({
                              ...attachment,
                              filename: `${index}-${attachment.filename}`
                          }))
                      }
                  }
                : original;
        adapter.notifyPending(oversized);
        await waitUntil(() => client.sendMessageCalls().length > 1);

        const sent = client.sendMessageCalls();
        assert.ok(sent.length >= 3);
        sent.forEach((call, index) => {
            assert.ok((call.body.text as string).startsWith(`Teil ${index + 1}/${sent.length}`));
            if (index < sent.length - 1) {
                assert.equal(call.body.reply_markup, undefined);
            } else {
                assert.ok(call.body.reply_markup);
            }
        });
    });

    it('verteilt ein langes Anschreiben auf mehrere Teile und gibt über den letzten frei', async () => {
        const created = await harness();
        const found = await created.orchestrator.findResource({ query: QUERY, purpose: PURPOSE });
        assert.ok(found.status === 'resolved');
        // A real cover letter is what makes a multi-part message routine now that
        // the body is rendered; `MAX_BODY_CHARS` allows a good deal more than this.
        const letter = `Sehr geehrte Damen und Herren,\n\n${'Anbei meine Unterlagen. '.repeat(300)}`;
        const prepared = await created.orchestrator.prepareAction({
            reference: found.resource.reference,
            target: 'private_mail',
            purpose: PURPOSE,
            body: letter
        });
        const settings = await activeSettings(created.dataDir);
        const client = new FakeTelegramClient();
        const adapter = new TelegramApprovalAdapter(
            created.orchestrator,
            created.audit,
            settings,
            undefined,
            client
        );

        const view = created.orchestrator
            .localPendingActions()
            .find((v) => v.actionId === prepared.action_id)!;
        adapter.notifyPending(view);
        await waitUntil(() => client.sendMessageCalls().length > 1);

        // Split across parts, but complete: every character the recipient would get.
        const sent = client.sendMessageCalls();
        assert.ok(sent.length >= 2);
        assert.ok(sentText(client).includes(letter.slice(-200)));
        assert.equal(sent.at(-2)!.body.reply_markup, undefined);

        client.queueUpdates(callbackUpdate(callbackDataOf(client, 'a')));
        await adapter.pollOnce();

        await waitForTerminal(created.orchestrator, prepared.action_id);
        assert.equal(created.orchestrator.getActionStatus(prepared.action_id).status, 'completed');
        assert.equal(created.target.delivered.length, 1);
    });
});

describe('Telegram-Freigabekanal: Entscheidung', () => {
    it('gibt bei erlaubtem Klick über denselben Bindungscheck frei und liefert genau einmal aus', async () => {
        const created = await harness();
        const actionId = await prepare(created);
        const settings = await activeSettings(created.dataDir);
        const client = new FakeTelegramClient();
        const adapter = new TelegramApprovalAdapter(
            created.orchestrator,
            created.audit,
            settings,
            undefined,
            client
        );

        const view = created.orchestrator.localPendingActions().find((v) => v.actionId === actionId)!;
        adapter.notifyPending(view);
        await waitUntil(() => client.sendMessageCalls().length > 0);

        const approveData = callbackDataOf(client, 'a');
        client.queueUpdates(callbackUpdate(approveData));
        await adapter.pollOnce();

        await waitForTerminal(created.orchestrator, actionId);
        assert.equal(created.orchestrator.getActionStatus(actionId).status, 'completed');
        assert.equal(created.target.delivered.length, 1);

        const answered = client.answerCalls();
        assert.equal(answered.length, 1);
        assert.equal(answered[0]!.body.text, '✅ Freigegeben.');
        assert.equal(answered[0]!.body.show_alert, false);
        assert.ok(client.calls.some((call) => call.method === 'editMessageReplyMarkup'));
    });

    it('bietet für eine Zusammenfassung nur Ablehnen an und gibt auch auf gefälschten Klick nicht frei', async () => {
        const created = await harness();
        const found = await created.orchestrator.findResource({ query: QUERY, purpose: PURPOSE });
        assert.ok(found.status === 'resolved');
        const prepared = await created.orchestrator.summarizeResource({
            reference: found.resource.reference,
            purpose: PURPOSE
        });
        const settings = await activeSettings(created.dataDir);
        const client = new FakeTelegramClient();
        const adapter = new TelegramApprovalAdapter(
            created.orchestrator,
            created.audit,
            settings,
            undefined,
            client
        );

        const view = created.orchestrator
            .localPendingActions()
            .find((v) => v.actionId === prepared.action_id)!;
        adapter.notifyPending(view);
        await waitUntil(() => client.sendMessageCalls().length > 0);

        const buttons = keyboardOf(client);
        assert.equal(buttons.length, 1);
        const rejectData = callbackDataOf(client, 'r');
        // Callback data is client-supplied: the missing button must not be the only guard.
        client.queueUpdates(callbackUpdate(`a${rejectData.slice(1)}`));
        await adapter.pollOnce();

        assert.equal(
            created.orchestrator.getActionStatus(prepared.action_id).status,
            'awaiting_local_approval'
        );
        assert.equal(client.answerCalls().at(-1)!.body.text, 'Diese Freigabe ist nur im Portal möglich.');
        const events = await created.audit.tail(10);
        assert.ok(
            events.some(
                (event) =>
                    event.type === 'telegram_callback_rejected' &&
                    event.detail?.reason === 'approval_requires_portal'
            )
        );

        // The offered rejection survives the refused approval.
        client.queueUpdates(callbackUpdate(rejectData, { updateId: 2 }));
        await adapter.pollOnce();
        assert.equal(created.orchestrator.getActionStatus(prepared.action_id).status, 'rejected');
    });

    it('zeigt einen vom Agenten verfassten Betreff und Text wörtlich und bleibt freigebbar', async () => {
        const created = await harness();
        const found = await created.orchestrator.findResource({ query: QUERY, purpose: PURPOSE });
        assert.ok(found.status === 'resolved');
        const prepared = await created.orchestrator.prepareAction({
            reference: found.resource.reference,
            target: 'private_mail',
            purpose: PURPOSE,
            subject: 'Vom Agenten verfasster Betreff.',
            body: 'Vom Agenten verfasster Text.'
        });
        const settings = await activeSettings(created.dataDir);
        const client = new FakeTelegramClient();
        const adapter = new TelegramApprovalAdapter(
            created.orchestrator,
            created.audit,
            settings,
            undefined,
            client
        );

        const view = created.orchestrator
            .localPendingActions()
            .find((v) => v.actionId === prepared.action_id)!;
        adapter.notifyPending(view);
        await waitUntil(() => client.sendMessageCalls().length > 0);

        // These characters come from the cloud agent, not from the document, so
        // showing them here releases nothing the agent does not already hold.
        const text = sentText(client);
        assert.ok(text.includes('Vom Agenten verfasster Betreff.'));
        assert.ok(text.includes('Vom Agenten verfasster Text.'));

        const buttons = keyboardOf(client);
        assert.equal(buttons.length, 2);
        client.queueUpdates(callbackUpdate(callbackDataOf(client, 'a')));
        await adapter.pollOnce();

        await waitForTerminal(created.orchestrator, prepared.action_id);
        assert.equal(created.orchestrator.getActionStatus(prepared.action_id).status, 'completed');
        assert.equal(created.target.delivered.length, 1);
    });

    it('zeigt einen Hinweis des Agenten im lokal erzeugten Text und bleibt freigebbar', async () => {
        const created = await harness();
        const found = await created.orchestrator.findResource({ query: QUERY, purpose: PURPOSE });
        assert.ok(found.status === 'resolved');
        const prepared = await created.orchestrator.prepareAction({
            reference: found.resource.reference,
            target: 'private_mail',
            purpose: PURPOSE,
            note: 'Bitte den Abschnitt zur Vergütung beachten.'
        });
        const settings = await activeSettings(created.dataDir);
        const client = new FakeTelegramClient();
        const adapter = new TelegramApprovalAdapter(
            created.orchestrator,
            created.audit,
            settings,
            undefined,
            client
        );

        const view = created.orchestrator
            .localPendingActions()
            .find((v) => v.actionId === prepared.action_id)!;
        assert.ok(view.kind === 'send_resource');
        // The gateway composed this body, but it quotes the agent verbatim.
        assert.equal(view.egress.authoredByAgent.body, false);
        assert.ok(view.egress.body.includes('Vergütung'));
        adapter.notifyPending(view);
        await waitUntil(() => client.sendMessageCalls().length > 0);

        const text = sentText(client);
        assert.ok(text.includes('Vergütung'));
        // The attribution stays attached to the words it attributes.
        assert.ok(text.includes('Hinweis des Agenten (nicht lokal verifiziert):'));

        const buttons = keyboardOf(client);
        assert.equal(buttons.length, 2);
        client.queueUpdates(callbackUpdate(callbackDataOf(client, 'a')));
        await adapter.pollOnce();

        await waitForTerminal(created.orchestrator, prepared.action_id);
        assert.equal(created.orchestrator.getActionStatus(prepared.action_id).status, 'completed');
        assert.equal(created.target.delivered.length, 1);
    });

    it('ruft bei Ablehnung rejectAction auf', async () => {
        const created = await harness();
        const actionId = await prepare(created);
        const settings = await activeSettings(created.dataDir);
        const client = new FakeTelegramClient();
        const adapter = new TelegramApprovalAdapter(
            created.orchestrator,
            created.audit,
            settings,
            undefined,
            client
        );

        const view = created.orchestrator.localPendingActions().find((v) => v.actionId === actionId)!;
        adapter.notifyPending(view);
        await waitUntil(() => client.sendMessageCalls().length > 0);

        const rejectData = callbackDataOf(client, 'r');
        client.queueUpdates(callbackUpdate(rejectData));
        await adapter.pollOnce();

        assert.equal(created.orchestrator.getActionStatus(actionId).status, 'rejected');
        assert.equal(created.target.delivered.length, 0);
    });

    it('ändert nichts bei einem fremden Chat', async () => {
        const created = await harness();
        const actionId = await prepare(created);
        const settings = await activeSettings(created.dataDir);
        const client = new FakeTelegramClient();
        const adapter = new TelegramApprovalAdapter(
            created.orchestrator,
            created.audit,
            settings,
            undefined,
            client
        );
        const view = created.orchestrator.localPendingActions().find((v) => v.actionId === actionId)!;
        adapter.notifyPending(view);
        await waitUntil(() => client.sendMessageCalls().length > 0);

        const approveData = callbackDataOf(client, 'a');
        client.queueUpdates(callbackUpdate(approveData, { chatId: 'anderer-chat' }));
        await adapter.pollOnce();

        assert.equal(created.orchestrator.getActionStatus(actionId).status, 'awaiting_local_approval');
        assert.equal(client.answerCalls().at(-1)!.body.text, 'Nicht autorisiert.');
        const events = await created.audit.tail(10);
        assert.ok(events.some((event) => event.type === 'telegram_callback_rejected' && event.detail?.reason === 'foreign_caller'));
    });

    it('ändert nichts bei einem fremden Benutzer', async () => {
        const created = await harness();
        const actionId = await prepare(created);
        const settings = await activeSettings(created.dataDir);
        const client = new FakeTelegramClient();
        const adapter = new TelegramApprovalAdapter(
            created.orchestrator,
            created.audit,
            settings,
            undefined,
            client
        );
        const view = created.orchestrator.localPendingActions().find((v) => v.actionId === actionId)!;
        adapter.notifyPending(view);
        await waitUntil(() => client.sendMessageCalls().length > 0);

        const approveData = callbackDataOf(client, 'a');
        client.queueUpdates(callbackUpdate(approveData, { userId: 'anderer-nutzer' }));
        await adapter.pollOnce();

        assert.equal(created.orchestrator.getActionStatus(actionId).status, 'awaiting_local_approval');
        assert.equal(client.answerCalls().at(-1)!.body.text, 'Nicht autorisiert.');
    });

    it('ignoriert eine reine Textnachricht', async () => {
        const created = await harness();
        const actionId = await prepare(created);
        const settings = await activeSettings(created.dataDir);
        const client = new FakeTelegramClient();
        const adapter = new TelegramApprovalAdapter(
            created.orchestrator,
            created.audit,
            settings,
            undefined,
            client
        );
        client.queueUpdates({ update_id: 1, message: { chat: { id: CHAT_ID } } });
        await adapter.pollOnce();

        assert.equal(client.answerCalls().length, 0);
        assert.equal(created.orchestrator.getActionStatus(actionId).status, 'awaiting_local_approval');
    });

    it('weist manipulierte Callback-Daten zurück', async () => {
        const created = await harness();
        await prepare(created);
        const settings = await activeSettings(created.dataDir);
        const client = new FakeTelegramClient();
        const adapter = new TelegramApprovalAdapter(
            created.orchestrator,
            created.audit,
            settings,
            undefined,
            client
        );
        client.queueUpdates(callbackUpdate('not-the-expected-format'));
        await adapter.pollOnce();

        assert.equal(client.answerCalls().at(-1)!.body.text, 'Ungültige Anfrage.');
        const events = await created.audit.tail(10);
        assert.ok(events.some((event) => event.type === 'telegram_callback_rejected' && event.detail?.reason === 'invalid_data'));
    });

    it('weist ein unbekanntes oder gealtertes Token zurück, ohne die Aktion zu ändern', async () => {
        const created = await harness();
        const actionId = await prepare(created);
        const settings = await activeSettings(created.dataDir);
        const client = new FakeTelegramClient();
        const adapter = new TelegramApprovalAdapter(
            created.orchestrator,
            created.audit,
            settings,
            undefined,
            client
        );
        client.queueUpdates(callbackUpdate(`a:${actionId}:erfundenes-token`));
        await adapter.pollOnce();

        assert.equal(client.answerCalls().at(-1)!.body.text, 'Diese Freigabe ist nicht mehr gültig.');
        assert.equal(created.orchestrator.getActionStatus(actionId).status, 'awaiting_local_approval');
    });

    it('lässt sich nicht zweimal mit demselben Token entscheiden', async () => {
        const created = await harness();
        const actionId = await prepare(created);
        const settings = await activeSettings(created.dataDir);
        const client = new FakeTelegramClient();
        const adapter = new TelegramApprovalAdapter(
            created.orchestrator,
            created.audit,
            settings,
            undefined,
            client
        );
        const view = created.orchestrator.localPendingActions().find((v) => v.actionId === actionId)!;
        adapter.notifyPending(view);
        await waitUntil(() => client.sendMessageCalls().length > 0);

        const approveData = callbackDataOf(client, 'a');
        client.queueUpdates(callbackUpdate(approveData, { updateId: 1 }));
        await adapter.pollOnce();
        await waitForTerminal(created.orchestrator, actionId);

        client.queueUpdates(callbackUpdate(approveData, { updateId: 2 }));
        await adapter.pollOnce();

        assert.equal(client.answerCalls().at(-1)!.body.text, 'Diese Freigabe ist nicht mehr gültig.');
        assert.equal(created.target.delivered.length, 1);
    });

    it('meldet einen Bindungskonflikt, ohne zu werfen, wenn die Aktion bereits entschieden wurde', async () => {
        const created = await harness();
        const actionId = await prepare(created);
        const settings = await activeSettings(created.dataDir);
        const client = new FakeTelegramClient();
        const adapter = new TelegramApprovalAdapter(
            created.orchestrator,
            created.audit,
            settings,
            undefined,
            client
        );
        const view = created.orchestrator.localPendingActions().find((v) => v.actionId === actionId)!;
        adapter.notifyPending(view);
        await waitUntil(() => client.sendMessageCalls().length > 0);
        const approveData = callbackDataOf(client, 'a');

        // The browser decided first — the Telegram click arrives for an action
        // that is no longer waiting.
        await created.orchestrator.rejectAction(actionId, false);

        client.queueUpdates(callbackUpdate(approveData));
        await adapter.pollOnce();

        assert.equal(client.answerCalls().at(-1)!.body.show_alert, true);
        const events = await created.audit.tail(10);
        assert.ok(events.some((event) => event.type === 'telegram_callback_rejected' && event.detail?.reason === 'conflict'));
    });

    it('bricht sauber ab, wenn `getUpdates` fehlschlägt, ohne eine Entscheidung zu treffen', async () => {
        const created = await harness();
        const actionId = await prepare(created);
        const settings = await activeSettings(created.dataDir);
        const client = new FakeTelegramClient();
        client.failNextGetUpdatesWith = new Error('Telegram nicht erreichbar');
        const adapter = new TelegramApprovalAdapter(
            created.orchestrator,
            created.audit,
            settings,
            undefined,
            client
        );

        await assert.rejects(() => adapter.pollOnce());
        assert.equal(created.orchestrator.getActionStatus(actionId).status, 'awaiting_local_approval');
    });

    it('erlaubt eine erneute Zustellung, wenn der Versand an Telegram fehlschlägt', async () => {
        const created = await harness();
        const actionId = await prepare(created);
        const settings = await activeSettings(created.dataDir);
        const client = new FakeTelegramClient();
        let failNext = true;
        const originalCall = client.call.bind(client);
        client.call = async (method, body, signal) => {
            if (method === 'sendMessage' && failNext) {
                failNext = false;
                throw new Error('Telegram-API nicht erreichbar');
            }
            return originalCall(method, body, signal);
        };
        const adapter = new TelegramApprovalAdapter(
            created.orchestrator,
            created.audit,
            settings,
            undefined,
            client
        );

        const view = created.orchestrator.localPendingActions().find((v) => v.actionId === actionId)!;
        adapter.notifyPending(view);
        await waitUntil(async () =>
            (await created.audit.tail(10)).some((event) => event.type === 'telegram_delivery_failed')
        );
        assert.equal(created.orchestrator.getActionStatus(actionId).status, 'awaiting_local_approval');

        // The failed attempt un-latched the binding, so a second notification
        // (the next restart, or the next time this action is offered again) is
        // not silently swallowed as an already-notified duplicate.
        adapter.notifyPending(view);
        await waitUntil(() => client.sendMessageCalls().length >= 1);
        assert.equal(client.sendMessageCalls().length, 1);
    });
});
