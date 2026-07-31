import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { maskChatId } from '../targets/target.js';
import type { ApiTelegramApprovalStatus, ApiTelegramApprovalUpdateRequest } from './contract.js';

/**
 * Local configuration for the optional Telegram approval channel.
 *
 * Stored as a plain JSON file with mode 0600, next to the other local state.
 * The bot token in it is a secret, and the protection it gets is the one the
 * rest of the system already relies on: file permissions on a machine whose
 * operating system is trusted. Encrypting it here would only move the problem —
 * the key would have to sit in the same environment, readable by the same
 * process, for the same user — while adding a key derivation, an envelope
 * format and a migration path to maintain.
 *
 * What the file must never do is leak the token outwards. `toApiStatus` reports
 * only whether one is stored, `update` never reads one back out, and
 * `EgressGuard` has the value registered so it cannot appear in anything sent
 * to Hermes.
 */
export interface TelegramApprovalSettings {
    enabled: boolean;
    botToken?: string;
    chatId?: string;
    allowedUserId?: string;
}

export class TelegramSettingsValidationError extends Error {}

export class TelegramSettingsStore {
    private settings: TelegramApprovalSettings = { enabled: false };
    private loaded = false;
    private writeChain: Promise<void> = Promise.resolve();

    constructor(private readonly dataDir: string) {}

    private get filePath(): string {
        return join(this.dataDir, 'telegram-approval.json');
    }

    async load(): Promise<void> {
        await mkdir(this.dataDir, { recursive: true });
        if (existsSync(this.filePath)) {
            let parsed: unknown;
            try {
                parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
            } catch {
                throw new Error(`Telegram-Freigabekonfiguration ${this.filePath} ist beschädigt.`);
            }
            this.settings = parseSettings(parsed);
        }
        this.loaded = true;
    }

    private assertLoaded(): void {
        if (!this.loaded) {
            throw new Error('TelegramSettingsStore wurde nicht geladen.');
        }
    }

    /** Internal snapshot, including the secret. Never handed to the API layer. */
    current(): Readonly<TelegramApprovalSettings> {
        this.assertLoaded();
        return this.settings;
    }

    /** Bot token, chat id and allowed user id are all present. */
    isComplete(): boolean {
        this.assertLoaded();
        return Boolean(this.settings.botToken && this.settings.chatId && this.settings.allowedUserId);
    }

    /** Complete *and* switched on — the only state in which the adapter may poll. */
    isActive(): boolean {
        this.assertLoaded();
        return this.settings.enabled && this.isComplete();
    }

    toApiStatus(runtime: { polling: boolean; lastError?: string }): ApiTelegramApprovalStatus {
        this.assertLoaded();
        const s = this.settings;
        return {
            enabled: s.enabled,
            configured: this.isComplete(),
            botTokenSet: Boolean(s.botToken),
            chatIdMasked: s.chatId ? maskChatId(s.chatId) : undefined,
            allowedUserIdMasked: s.allowedUserId ? maskChatId(s.allowedUserId) : undefined,
            polling: runtime.polling,
            lastError: runtime.lastError
        };
    }

    /**
     * Applies a portal update. An absent or blank field keeps the value
     * already stored — most importantly for `botToken`, which the API never
     * reads back out, but applied uniformly to `chatId` and `allowedUserId`
     * too so toggling `enabled` alone does not require re-entering everything.
     * Enabling the channel without every field present is refused rather than
     * silently left disabled.
     */
    async update(input: ApiTelegramApprovalUpdateRequest): Promise<void> {
        this.assertLoaded();
        await this.commit((current) => {
            const botToken = nonEmpty(input.botToken) ?? current.botToken;
            const chatId = nonEmpty(input.chatId) ?? current.chatId;
            const allowedUserId = nonEmpty(input.allowedUserId) ?? current.allowedUserId;
            if (
                (chatId !== undefined && !/^-?\d+$/.test(chatId)) ||
                (allowedUserId !== undefined && !/^\d+$/.test(allowedUserId))
            ) {
                throw new TelegramSettingsValidationError(
                    'Chat-ID und erlaubte Benutzer-ID müssen numerisch sein.'
                );
            }
            if (input.enabled && !(botToken && chatId && allowedUserId)) {
                throw new TelegramSettingsValidationError(
                    'Aktivierung erfordert Bot-Token, Chat-ID und erlaubte Benutzer-ID.'
                );
            }
            return { enabled: input.enabled, botToken, chatId, allowedUserId };
        });
    }

    async disable(): Promise<void> {
        this.assertLoaded();
        await this.commit((current) => ({ ...current, enabled: false }));
    }

    /** Removes every stored credential, not only the `enabled` flag. */
    async clear(): Promise<void> {
        this.assertLoaded();
        await this.commit(() => ({ enabled: false }));
    }

    private commit(
        build: (current: Readonly<TelegramApprovalSettings>) => TelegramApprovalSettings
    ): Promise<void> {
        const next = this.writeChain.then(async () => {
            const candidate = build(this.settings);
            await writeAtomic(this.filePath, candidate);
            this.settings = candidate;
        });
        this.writeChain = next.catch(() => undefined);
        return next;
    }
}

function nonEmpty(value: string | undefined | null): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Written with 0600 and moved into place, so a reader never sees a half-written
 * file and no copy of the token is left behind under a default umask.
 */
async function writeAtomic(filePath: string, data: TelegramApprovalSettings): Promise<void> {
    const temporaryPath = `${filePath}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, filePath);
}

/**
 * Strict on the way in. A file with unexpected keys, a non-boolean `enabled` or
 * a half-configured active channel is refused rather than partially honoured:
 * this file decides whether a bot can approve a data transfer, and "close
 * enough" is not a state it should ever start in.
 */
function parseSettings(value: unknown): TelegramApprovalSettings {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Telegram-Freigabekonfiguration hat keine gültige Struktur.');
    }
    const raw = value as Record<string, unknown>;
    // Named specially because this is the one wrong shape that is *expected*:
    // a gateway upgraded from the version that encrypted this file. Without
    // this branch the generic message below aborts startup with "invalid
    // structure", which is true and useless — the file cannot be read, the
    // portal never comes up, and the remedy is not guessable from the error.
    if (isEncryptedEnvelope(raw)) {
        throw new Error(
            'Telegram-Freigabekonfiguration liegt in der früheren verschlüsselten Form vor und ' +
                'kann nicht mehr gelesen werden. Die Datei löschen und die drei Telegram-Angaben ' +
                'einmal im Portal neu eingeben.'
        );
    }
    const allowed = new Set(['enabled', 'botToken', 'chatId', 'allowedUserId']);
    if (
        Object.keys(raw).some((key) => !allowed.has(key)) ||
        typeof raw.enabled !== 'boolean' ||
        !optionalNonEmptyString(raw.botToken) ||
        !optionalNonEmptyString(raw.chatId) ||
        !optionalNonEmptyString(raw.allowedUserId)
    ) {
        throw new Error('Telegram-Freigabekonfiguration hat keine gültige Struktur.');
    }
    const settings: TelegramApprovalSettings = { enabled: raw.enabled };
    if (typeof raw.botToken === 'string') {
        settings.botToken = raw.botToken;
    }
    if (typeof raw.chatId === 'string') {
        settings.chatId = raw.chatId;
    }
    if (typeof raw.allowedUserId === 'string') {
        settings.allowedUserId = raw.allowedUserId;
    }
    if (settings.enabled && !(settings.botToken && settings.chatId && settings.allowedUserId)) {
        throw new Error('Telegram-Freigabekonfiguration ist unvollständig und wird nicht übernommen.');
    }
    if (
        (settings.chatId !== undefined && !/^-?\d+$/.test(settings.chatId)) ||
        (settings.allowedUserId !== undefined && !/^\d+$/.test(settings.allowedUserId))
    ) {
        throw new Error('Telegram-Freigabekonfiguration enthält ungültige Kennungen.');
    }
    return settings;
}

function optionalNonEmptyString(value: unknown): boolean {
    return value === undefined || (typeof value === 'string' && value.length > 0 && value === value.trim());
}

/**
 * The shape this file had while it was encrypted. Recognised only to produce a
 * better error — there is no decryption path left, and there should not be one:
 * the master key it needed no longer exists in the configuration.
 */
function isEncryptedEnvelope(raw: Record<string, unknown>): boolean {
    return raw.algorithm === 'aes-256-gcm' && typeof raw.ciphertext === 'string';
}
