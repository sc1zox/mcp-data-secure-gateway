import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { maskChatId } from '../targets/target.js';
import type { ApiTelegramApprovalStatus, ApiTelegramApprovalUpdateRequest } from './contract.js';

/**
 * Local, separately stored configuration for the optional Telegram approval
 * channel.
 *
 * Deliberately its own file under `dataDir`, not `config/gateway.config.json`
 * and not `.env`: these credentials are entered interactively from the local
 * portal, not checked into version control, and the JSON config stays a
 * static, git-tracked description of a fixed deployment. Written atomically
 * (temp file plus rename, like `store/jsonlStore.ts`'s compaction) and with
 * file mode `0600`, the same treatment as `data/ui-token`.
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
            const raw = parsed as Partial<TelegramApprovalSettings> | null;
            this.settings = {
                enabled: raw?.enabled === true,
                botToken: nonEmpty(raw?.botToken),
                chatId: nonEmpty(raw?.chatId),
                allowedUserId: nonEmpty(raw?.allowedUserId)
            };
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
        const botToken = nonEmpty(input.botToken) ?? this.settings.botToken;
        const chatId = nonEmpty(input.chatId) ?? this.settings.chatId;
        const allowedUserId = nonEmpty(input.allowedUserId) ?? this.settings.allowedUserId;
        if (input.enabled && !(botToken && chatId && allowedUserId)) {
            throw new TelegramSettingsValidationError(
                'Aktivierung erfordert Bot-Token, Chat-ID und erlaubte Benutzer-ID.'
            );
        }
        this.settings = { enabled: input.enabled, botToken, chatId, allowedUserId };
        await this.persist();
    }

    async disable(): Promise<void> {
        this.assertLoaded();
        this.settings = { ...this.settings, enabled: false };
        await this.persist();
    }

    /** Removes every stored credential, not only the `enabled` flag. */
    async clear(): Promise<void> {
        this.assertLoaded();
        this.settings = { enabled: false };
        await this.persist();
    }

    private persist(): Promise<void> {
        const snapshot = { ...this.settings };
        const next = this.writeChain.then(() => writeAtomic(this.filePath, snapshot));
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
