import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
    TelegramSettingsStore,
    TelegramSettingsValidationError
} from '../src/approval/settingsStore.js';

const dataDirs: string[] = [];
async function tmpDataDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'ltg-telegram-settings-'));
    dataDirs.push(dir);
    return dir;
}
after(async () => {
    for (const dir of dataDirs) {
        await rm(dir, { recursive: true, force: true });
    }
});

describe('TelegramSettingsStore', () => {
    it('startet leer und deaktiviert', async () => {
        const store = new TelegramSettingsStore(await tmpDataDir());
        await store.load();

        assert.equal(store.isComplete(), false);
        assert.equal(store.isActive(), false);
        const status = store.toApiStatus({ polling: false });
        assert.deepEqual(status, {
            enabled: false,
            configured: false,
            botTokenSet: false,
            chatIdMasked: undefined,
            allowedUserIdMasked: undefined,
            polling: false,
            lastError: undefined
        });
    });

    it('verweigert die Aktivierung ohne vollständige Angaben', async () => {
        const store = new TelegramSettingsStore(await tmpDataDir());
        await store.load();

        await assert.rejects(
            () => store.update({ enabled: true, botToken: 'bot-token-123456' }),
            TelegramSettingsValidationError
        );
        assert.equal(store.isComplete(), false);
    });

    it('speichert eine vollständige Konfiguration mit Modus 0600, ohne das Secret in der API-Ansicht', async () => {
        const dataDir = await tmpDataDir();
        const store = new TelegramSettingsStore(dataDir);
        await store.load();

        await store.update({
            enabled: true,
            botToken: '123456:ABC-DEF-super-secret-token',
            chatId: '987654321',
            allowedUserId: '112233445'
        });

        assert.equal(store.isComplete(), true);
        assert.equal(store.isActive(), true);

        const status = store.toApiStatus({ polling: true });
        assert.equal(status.enabled, true);
        assert.equal(status.configured, true);
        assert.equal(status.botTokenSet, true);
        assert.equal(status.chatIdMasked, '***321');
        assert.equal(status.allowedUserIdMasked, '***445');
        assert.equal(JSON.stringify(status).includes('super-secret-token'), false);

        const filePath = join(dataDir, 'telegram-approval.json');
        const info = await stat(filePath);
        assert.equal(info.mode & 0o777, 0o600);
        const onDisk = JSON.parse(await readFile(filePath, 'utf8'));
        assert.equal(onDisk.botToken, '123456:ABC-DEF-super-secret-token');
    });

    it('ein leeres Token bei einem Update behält das bestehende Secret', async () => {
        const store = new TelegramSettingsStore(await tmpDataDir());
        await store.load();
        await store.update({
            enabled: true,
            botToken: 'first-token-0001',
            chatId: '111',
            allowedUserId: '222'
        });

        await store.update({ enabled: true, chatId: '333' });

        const current = store.current();
        assert.equal(current.botToken, 'first-token-0001');
        assert.equal(current.chatId, '333');
        assert.equal(current.allowedUserId, '222');
    });

    it('disable() schaltet ab, behält aber die Zugangsdaten', async () => {
        const store = new TelegramSettingsStore(await tmpDataDir());
        await store.load();
        await store.update({
            enabled: true,
            botToken: 'token-x',
            chatId: '111',
            allowedUserId: '222'
        });

        await store.disable();

        assert.equal(store.current().enabled, false);
        assert.equal(store.current().botToken, 'token-x');
        assert.equal(store.isComplete(), true);
        assert.equal(store.isActive(), false);
    });

    it('clear() entfernt jede gespeicherte Zugangsdatendaten', async () => {
        const store = new TelegramSettingsStore(await tmpDataDir());
        await store.load();
        await store.update({
            enabled: true,
            botToken: 'token-x',
            chatId: '111',
            allowedUserId: '222'
        });

        await store.clear();

        assert.deepEqual(store.current(), { enabled: false });
        assert.equal(store.toApiStatus({ polling: false }).botTokenSet, false);
    });

    it('lädt eine zuvor gespeicherte Konfiguration nach einem Neustart', async () => {
        const dataDir = await tmpDataDir();
        const first = new TelegramSettingsStore(dataDir);
        await first.load();
        await first.update({
            enabled: true,
            botToken: 'token-restart',
            chatId: '555',
            allowedUserId: '666'
        });

        const second = new TelegramSettingsStore(dataDir);
        await second.load();
        assert.equal(second.current().botToken, 'token-restart');
        assert.equal(second.isActive(), true);
    });

    it('meldet Zugriff vor dem Laden', () => {
        const store = new TelegramSettingsStore('/tmp/unused');
        assert.throws(() => store.current());
    });
});
