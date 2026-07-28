import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { maskChatId } from '../targets/target.js';
import type { ApiTelegramApprovalStatus, ApiTelegramApprovalUpdateRequest } from './contract.js';

/**
 * Local, separately stored configuration for the optional Telegram approval
 * channel.
 *
 * The portal-managed payload is encrypted as one authenticated envelope. The
 * master secret is supplied separately through gateway configuration and is
 * never persisted or exposed through the portal API.
 */
export interface TelegramApprovalSettings {
    enabled: boolean;
    botToken?: string;
    chatId?: string;
    allowedUserId?: string;
}

export class TelegramSettingsValidationError extends Error {}

interface EncryptedEnvelope {
    version: 1;
    algorithm: 'aes-256-gcm';
    kdf: 'scrypt';
    salt: string;
    iv: string;
    authTag: string;
    ciphertext: string;
}

const scrypt = promisify(scryptCallback);
const ENVELOPE_AAD = Buffer.from('local-trust-gateway:telegram-approval:v1', 'utf8');

export class TelegramSettingsStore {
    private settings: TelegramApprovalSettings = { enabled: false };
    private loaded = false;
    private writeChain: Promise<void> = Promise.resolve();

    constructor(
        private readonly dataDir: string,
        private readonly masterSecret: string
    ) {}

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
            if (isEncryptedEnvelope(parsed)) {
                this.settings = await decryptSettings(parsed, this.masterSecret);
            } else {
                // Fail closed unless the old file is exactly the legacy shape.
                // A successful load is immediately rewritten before startup
                // continues, so no plaintext copy remains at this path.
                this.settings = parseLegacySettings(parsed);
                await writeAtomic(this.filePath, await encryptSettings(this.settings, this.masterSecret));
            }
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
            await writeAtomic(this.filePath, await encryptSettings(candidate, this.masterSecret));
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

async function writeAtomic(filePath: string, data: unknown): Promise<void> {
    const temporaryPath = `${filePath}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, filePath);
}

function parseLegacySettings(value: unknown): TelegramApprovalSettings {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Telegram-Legacy-Konfiguration hat keine strikt migrierbare Struktur.');
    }
    const raw = value as Record<string, unknown>;
    const allowed = new Set(['enabled', 'botToken', 'chatId', 'allowedUserId']);
    if (
        Object.keys(raw).some((key) => !allowed.has(key)) ||
        typeof raw.enabled !== 'boolean' ||
        !optionalNonEmptyString(raw.botToken) ||
        !optionalNonEmptyString(raw.chatId) ||
        !optionalNonEmptyString(raw.allowedUserId)
    ) {
        throw new Error('Telegram-Legacy-Konfiguration hat keine strikt migrierbare Struktur.');
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
        throw new Error('Telegram-Legacy-Konfiguration ist unvollständig und wird nicht migriert.');
    }
    if (
        (settings.chatId !== undefined && !/^-?\d+$/.test(settings.chatId)) ||
        (settings.allowedUserId !== undefined && !/^\d+$/.test(settings.allowedUserId))
    ) {
        throw new Error('Telegram-Legacy-Konfiguration enthält ungültige Kennungen.');
    }
    return settings;
}

function optionalNonEmptyString(value: unknown): boolean {
    return value === undefined || (typeof value === 'string' && value.length > 0 && value === value.trim());
}

async function encryptSettings(
    settings: TelegramApprovalSettings,
    masterSecret: string
): Promise<EncryptedEnvelope> {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = (await scrypt(masterSecret, salt, 32)) as Buffer;
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(ENVELOPE_AAD);
    const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(settings), 'utf8'),
        cipher.final()
    ]);
    return {
        version: 1,
        algorithm: 'aes-256-gcm',
        kdf: 'scrypt',
        salt: salt.toString('base64'),
        iv: iv.toString('base64'),
        authTag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64')
    };
}

async function decryptSettings(
    envelope: EncryptedEnvelope,
    masterSecret: string
): Promise<TelegramApprovalSettings> {
    try {
        const salt = decodeBase64(envelope.salt, 16);
        const iv = decodeBase64(envelope.iv, 12);
        const authTag = decodeBase64(envelope.authTag, 16);
        const ciphertext = decodeBase64(envelope.ciphertext);
        const key = (await scrypt(masterSecret, salt, 32)) as Buffer;
        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAAD(ENVELOPE_AAD);
        decipher.setAuthTag(authTag);
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        return parseDecryptedSettings(JSON.parse(plaintext.toString('utf8')));
    } catch {
        throw new Error('Telegram-Freigabekonfiguration konnte nicht authentifiziert und entschlüsselt werden.');
    }
}

function parseDecryptedSettings(value: unknown): TelegramApprovalSettings {
    try {
        return parseLegacySettings(value);
    } catch {
        throw new Error('Entschlüsselter Telegram-Payload ist ungültig.');
    }
}

function isEncryptedEnvelope(value: unknown): value is EncryptedEnvelope {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const raw = value as Record<string, unknown>;
    const keys = ['version', 'algorithm', 'kdf', 'salt', 'iv', 'authTag', 'ciphertext'];
    return (
        Object.keys(raw).length === keys.length &&
        keys.every((key) => Object.hasOwn(raw, key)) &&
        raw.version === 1 &&
        raw.algorithm === 'aes-256-gcm' &&
        raw.kdf === 'scrypt' &&
        typeof raw.salt === 'string' &&
        typeof raw.iv === 'string' &&
        typeof raw.authTag === 'string' &&
        typeof raw.ciphertext === 'string'
    );
}

function decodeBase64(value: string, expectedBytes?: number): Buffer {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
        throw new Error('Ungültiges Base64.');
    }
    const decoded = Buffer.from(value, 'base64');
    if (decoded.toString('base64') !== value || (expectedBytes !== undefined && decoded.length !== expectedBytes)) {
        throw new Error('Ungültige Feldlänge.');
    }
    return decoded;
}
