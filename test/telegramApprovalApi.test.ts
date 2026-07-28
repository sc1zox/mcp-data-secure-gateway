import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';
import { makeConfig, makeHarness, type Harness } from './helpers.js';
import { ApprovalServer } from '../src/approval/server.js';
import { TelegramSettingsStore } from '../src/approval/settingsStore.js';
import { TelegramApprovalAdapter } from '../src/approval/telegramApproval.js';
import type { ApiTelegramApprovalStatus } from '../src/approval/contract.js';

const UI_TOKEN = 'test-ui-token-abcdefgh';
const PORT = 18790;
const BASE_URL = `http://127.0.0.1:${PORT}`;

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

/** Boots a real `ApprovalServer` on loopback against a fresh harness, for HTTP-level tests. */
async function bootServer(
    created: Harness
): Promise<{
    server: ApprovalServer;
    settings: TelegramSettingsStore;
    adapter: TelegramApprovalAdapter;
}> {
    const config = makeConfig({
        dataDir: created.dataDir,
        approval: {
            host: '127.0.0.1',
            port: PORT,
            actionTtlSeconds: 1800,
            referenceTtlSeconds: 3600,
            selectionTtlSeconds: 1800
        }
    });
    const settings = new TelegramSettingsStore(created.dataDir);
    await settings.load();
    const adapter = new TelegramApprovalAdapter(created.orchestrator, created.audit, settings);
    const server = new ApprovalServer(
        config,
        created.orchestrator,
        created.audit,
        UI_TOKEN,
        created.guard,
        settings,
        adapter
    );
    await server.start();
    return { server, settings, adapter };
}

function authed(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${BASE_URL}${path}`, {
        ...init,
        headers: { ...(init.headers ?? {}), 'X-Gateway-Token': UI_TOKEN, 'Content-Type': 'application/json' }
    });
}

describe('Telegram-Freigabekanal: token-gated Portal-API', () => {
    it('verweigert Zugriff ohne gültiges Token', async () => {
        const created = await harness();
        const { server } = await bootServer(created);
        try {
            const response = await fetch(`${BASE_URL}/api/telegram-approval`);
            assert.equal(response.status, 401);
        } finally {
            await server.stop();
        }
    });

    it('meldet den Ausgangszustand als nicht konfiguriert', async () => {
        const created = await harness();
        const { server } = await bootServer(created);
        try {
            const response = await authed('/api/telegram-approval');
            assert.equal(response.status, 200);
            const body = (await response.json()) as ApiTelegramApprovalStatus;
            assert.equal(body.configured, false);
            assert.equal(body.enabled, false);
            assert.equal(body.botTokenSet, false);
        } finally {
            await server.stop();
        }
    });

    it('lehnt eine Aktivierung ohne vollständige Angaben ab', async () => {
        const created = await harness();
        const { server } = await bootServer(created);
        try {
            const response = await authed('/api/telegram-approval', {
                method: 'POST',
                body: JSON.stringify({ enabled: true, botToken: 'incomplete-token-xyz' })
            });
            assert.equal(response.status, 400);
            const body = (await response.json()) as { error: string };
            assert.ok(body.error.length > 0);
        } finally {
            await server.stop();
        }
    });

    it('speichert eine vollständige Konfiguration und gibt niemals das Bot-Token zurück', async () => {
        const created = await harness();
        const { server, settings } = await bootServer(created);
        try {
            const secretToken = 'super-secret-bot-token-99999';
            const response = await authed('/api/telegram-approval', {
                method: 'POST',
                body: JSON.stringify({
                    enabled: true,
                    botToken: secretToken,
                    chatId: '123456789',
                    allowedUserId: '987654321'
                })
            });
            assert.equal(response.status, 200);
            const rawText = await response.text();
            assert.ok(!rawText.includes(secretToken));

            const body = JSON.parse(rawText) as ApiTelegramApprovalStatus;
            assert.equal(body.configured, true);
            assert.equal(body.botTokenSet, true);
            assert.equal(body.chatIdMasked, '***789');

            // The egress guard is the last line of defence against this secret
            // ever reaching Hermes — the portal update must have registered it.
            assert.throws(() => created.guard.assertClean({ note: secretToken }, 'test'));

            // A follow-up GET must be equally silent about the secret.
            const getResponse = await authed('/api/telegram-approval');
            const getText = await getResponse.text();
            assert.ok(!getText.includes(secretToken));

            assert.equal(settings.current().botToken, secretToken);
        } finally {
            await server.stop();
        }
    });

    it('meldet fehlendes Bot-Token bei /test statt eine Netzwerkanfrage zu versuchen', async () => {
        const created = await harness();
        const { server } = await bootServer(created);
        try {
            const response = await authed('/api/telegram-approval/test', { method: 'POST' });
            assert.equal(response.status, 400);
            const body = (await response.json()) as { error: string };
            assert.ok(body.error.includes('Kein Bot-Token'));
        } finally {
            await server.stop();
        }
    });

    it('stoppt aktives Telegram-Polling zusammen mit dem Freigabeserver', async () => {
        const created = await harness();
        const { server, adapter } = await bootServer(created);
        try {
            const response = await authed('/api/telegram-approval', {
                method: 'POST',
                body: JSON.stringify({
                    enabled: true,
                    botToken: 'lifecycle-test-token-123456',
                    chatId: '123456789',
                    allowedUserId: '987654321'
                })
            });
            assert.equal(response.status, 200);
            assert.equal(adapter.isPolling(), true);
        } finally {
            await server.stop();
        }

        assert.equal(adapter.isPolling(), false);
    });
});

describe('Telegram-Freigabekanal: Browserweg bleibt unverändert', () => {
    it('lässt eine Aktion weiterhin per Browser-API freigeben', async () => {
        const created = await harness();
        const { server } = await bootServer(created);
        try {
            const found = await created.orchestrator.findResource({
                query: 'mein aktueller Lebenslauf',
                purpose: 'Bewerbung auf eine Stelle'
            });
            assert.ok(found.status === 'resolved');
            const prepared = await created.orchestrator.prepareAction({
                reference: found.resource.reference,
                target: 'private_mail',
                purpose: 'Bewerbung auf eine Stelle'
            });
            assert.equal(prepared.status, 'awaiting_local_approval');

            const stateResponse = await authed('/api/state');
            const state = (await stateResponse.json()) as { actions: Array<{ actionId: string; bindingHash: string }> };
            const view = state.actions.find((a) => a.actionId === prepared.action_id)!;
            assert.ok(view);

            const approveResponse = await authed('/api/approve', {
                method: 'POST',
                body: JSON.stringify({ action_id: view.actionId, binding_hash: view.bindingHash })
            });
            assert.equal(approveResponse.status, 200);
        } finally {
            await server.stop();
        }
    });
});
