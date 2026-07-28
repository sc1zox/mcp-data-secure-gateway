import { randomBytes } from 'node:crypto';
import type { AuditLog } from '../store/auditLog.js';
import type { Orchestrator } from '../core/orchestrator.js';
import type { LocalActionView } from '../core/localViews.js';
import { createLogger, describeError, type Logger } from '../util/log.js';
import {
    fetchJsonBounded,
    HttpInvalidJsonError,
    HttpResponseTooLargeError,
    HttpTimeoutError
} from '../util/boundedHttp.js';
import type { TelegramSettingsStore } from './settingsStore.js';

/**
 * The Telegram approval channel: a second, optional local decision path.
 *
 * It never talks to the store or the executor directly. Every decision goes
 * through `Orchestrator.approveAction` / `rejectAction`, the exact same
 * methods the browser calls, with the exact same binding-hash check — this
 * adapter only produces the two arguments those methods already require.
 *
 * `getUpdates` long polling, never a webhook: this process holding private
 * documents does not accept inbound connections, and a webhook would be one.
 */
export class TelegramApprovalAdapter {
    private readonly log: Logger;
    private readonly client: TelegramHttpClient;

    /** Which bindings already produced a notification, so a restart re-sends but a retried caller does not double-send. */
    private readonly notifiedBindings = new Set<string>();
    /** Live callback tokens, one per delivered message; single-use. */
    private readonly pendingCallbacks = new Map<string, PendingCallback>();

    private unsubscribe: (() => void) | undefined;
    private stopping = false;
    private loopPromise: Promise<void> | undefined;
    private offset = 0;
    private pollingFlag = false;
    private lastError: string | undefined;
    private abortController: AbortController | undefined;

    constructor(
        private readonly orchestrator: Orchestrator,
        private readonly audit: AuditLog,
        private readonly settings: TelegramSettingsStore,
        logger?: Logger,
        client?: TelegramHttpClient
    ) {
        this.log = (logger ?? createLogger('approval')).child('telegram');
        this.client = client ?? new DefaultTelegramHttpClient(() => this.settings.current().botToken);
    }

    isPolling(): boolean {
        return this.pollingFlag;
    }

    status(): { polling: boolean; lastError?: string } {
        return { polling: this.pollingFlag, lastError: this.lastError };
    }

    /**
     * Starts the channel if — and only if — it is enabled and fully
     * configured. Safe to call when it is not: it then simply does nothing,
     * which is what lets `index.ts` call it unconditionally at boot.
     */
    async start(): Promise<void> {
        if (this.pollingFlag) {
            return;
        }
        if (!this.settings.isActive()) {
            this.log.info('Telegram-Freigabekanal ist deaktiviert oder unvollständig konfiguriert.');
            return;
        }
        this.stopping = false;
        this.pollingFlag = true;
        this.lastError = undefined;
        this.unsubscribe = this.orchestrator.onActionAwaitingApproval((view) => this.notifyPending(view));
        // Actions already waiting when the channel starts (fresh boot, or the
        // channel was just switched on) get exactly one notification too.
        for (const view of this.orchestrator.localPendingActions()) {
            this.notifyPending(view);
        }
        this.abortController = new AbortController();
        this.loopPromise = this.loop();
        this.log.info('Telegram-Freigabekanal gestartet');
    }

    /** Stops polling and drops the subscription. Safe to call repeatedly. */
    async stop(): Promise<void> {
        this.stopping = true;
        this.pollingFlag = false;
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        this.abortController?.abort();
        this.abortController = undefined;
        if (this.loopPromise) {
            await this.loopPromise.catch(() => undefined);
            this.loopPromise = undefined;
        }
    }

    /** Applied after a settings update in the portal: stop, re-read settings, start again. */
    async reconfigure(): Promise<void> {
        await this.stop();
        await this.start();
    }

    /**
     * Sends the full local view as one or more Telegram messages, with the
     * inline decision buttons on the last one. Deliberately fire-and-forget
     * from the caller's perspective — the orchestrator's own transition
     * listener is synchronous and must not block on a network call.
     */
    notifyPending(view: LocalActionView): void {
        if (!this.settings.isActive()) {
            return;
        }
        if (this.notifiedBindings.has(view.bindingHash)) {
            return;
        }
        this.notifiedBindings.add(view.bindingHash);
        void this.deliver(view).catch(async (error) => {
            // Allow a later retry (e.g. the next restart, or the next time this
            // binding is offered again) instead of silently losing the
            // notification for the lifetime of the process.
            this.notifiedBindings.delete(view.bindingHash);
            this.lastError = describeError(error);
            this.log.warn('Telegram-Benachrichtigung fehlgeschlagen', { actionId: view.actionId, error: this.lastError });
            await this.audit.record('telegram_delivery_failed', {
                actionId: view.actionId,
                detail: { phase: 'notify' }
            });
        });
    }

    private async deliver(view: LocalActionView): Promise<void> {
        const settings = this.settings.current();
        if (!settings.chatId) {
            return;
        }
        const chunks = renderChunks(view);
        const token = randomBytes(6).toString('hex');
        let lastMessageId: number | undefined;
        for (let index = 0; index < chunks.length; index += 1) {
            const isLast = index === chunks.length - 1;
            const result = await this.client.call('sendMessage', {
                chat_id: settings.chatId,
                text: chunks[index],
                disable_web_page_preview: true,
                ...(isLast ? { reply_markup: buildKeyboard(view.actionId, token) } : {})
            });
            if (isLast) {
                lastMessageId = messageIdOf(result);
            }
        }
        this.pendingCallbacks.set(token, {
            actionId: view.actionId,
            bindingHash: view.bindingHash,
            chatId: settings.chatId,
            messageId: lastMessageId,
            expiresAt: Date.parse(view.expiresAt)
        });
        await this.audit.record('telegram_notified', {
            actionId: view.actionId,
            detail: { parts: chunks.length }
        });
    }

    /** One `getUpdates` round trip and the handling of whatever it returned. Exposed for tests. */
    async pollOnce(): Promise<void> {
        this.purgeExpiredCallbacks();
        const response = await this.client.call(
            'getUpdates',
            { offset: this.offset, timeout: POLL_TIMEOUT_SECONDS, allowed_updates: ['callback_query'] },
            this.abortController?.signal
        );
        const updates = Array.isArray(response.result) ? (response.result as TelegramUpdate[]) : [];
        for (const update of updates) {
            if (typeof update.update_id === 'number') {
                this.offset = Math.max(this.offset, update.update_id + 1);
            }
            await this.handleUpdate(update);
        }
    }

    private async loop(): Promise<void> {
        let backoffMs = INITIAL_BACKOFF_MS;
        while (!this.stopping) {
            try {
                await this.pollOnce();
                backoffMs = INITIAL_BACKOFF_MS;
                this.lastError = undefined;
            } catch (error) {
                if (this.stopping) {
                    break;
                }
                this.lastError = describeError(error);
                this.log.warn('Telegram-Abfrage fehlgeschlagen', { error: this.lastError });
                await sleep(backoffMs);
                backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
            }
        }
    }

    private async handleUpdate(update: TelegramUpdate): Promise<void> {
        // Anything other than a callback query — a plain text message chief
        // among them — is inert by construction: there is no handler for it.
        if (!update.callback_query) {
            return;
        }
        await this.handleCallback(update.callback_query);
    }

    private async handleCallback(callback: TelegramCallbackQuery): Promise<void> {
        const settings = this.settings.current();
        const chatId = callback.message?.chat?.id !== undefined ? String(callback.message.chat.id) : '';
        const fromId = callback.from?.id !== undefined ? String(callback.from.id) : '';

        if (!settings.chatId || !settings.allowedUserId || chatId !== settings.chatId || fromId !== settings.allowedUserId) {
            await this.answer(callback.id, 'Nicht autorisiert.', true);
            await this.audit.record('telegram_callback_rejected', { detail: { reason: 'foreign_caller' } });
            return;
        }

        const parsed = parseCallbackData(callback.data ?? '');
        if (!parsed) {
            await this.answer(callback.id, 'Ungültige Anfrage.', true);
            await this.audit.record('telegram_callback_rejected', { detail: { reason: 'invalid_data' } });
            return;
        }

        const pending = this.pendingCallbacks.get(parsed.token);
        if (!pending || pending.actionId !== parsed.actionId) {
            await this.answer(callback.id, 'Diese Freigabe ist nicht mehr gültig.', true);
            await this.audit.record('telegram_callback_rejected', {
                actionId: parsed.actionId,
                detail: { reason: 'unknown_binding' }
            });
            return;
        }
        // Single use: whatever happens next, this token cannot decide twice.
        this.pendingCallbacks.delete(parsed.token);

        try {
            if (parsed.decision === 'approve') {
                await this.orchestrator.approveAction(pending.actionId, pending.bindingHash);
                await this.finish(callback, pending, '✅ Freigegeben.');
            } else {
                await this.orchestrator.rejectAction(pending.actionId, false);
                await this.finish(callback, pending, '❌ Abgelehnt.');
            }
        } catch (error) {
            await this.answer(
                callback.id,
                'Aktion konnte nicht angewendet werden — sie ist vermutlich bereits entschieden, abgelaufen oder verändert.',
                true
            );
            await this.audit.record('telegram_callback_rejected', {
                actionId: pending.actionId,
                detail: { reason: 'conflict', error: describeConflict(error) }
            });
        }
    }

    private async finish(callback: TelegramCallbackQuery, pending: PendingCallback, text: string): Promise<void> {
        await this.answer(callback.id, text, false);
        if (pending.messageId !== undefined) {
            try {
                await this.client.call('editMessageReplyMarkup', {
                    chat_id: pending.chatId,
                    message_id: pending.messageId,
                    reply_markup: { inline_keyboard: [] }
                });
            } catch (error) {
                this.log.warn('Telegram-Tastatur konnte nicht entfernt werden', { error: describeError(error) });
            }
        }
    }

    private async answer(callbackId: string, text: string, showAlert: boolean): Promise<void> {
        try {
            await this.client.call('answerCallbackQuery', {
                callback_query_id: callbackId,
                text,
                show_alert: showAlert
            });
        } catch (error) {
            this.log.warn('Telegram-Callback-Antwort fehlgeschlagen', { error: describeError(error) });
        }
    }

    private purgeExpiredCallbacks(): void {
        const now = Date.now();
        for (const [token, pending] of this.pendingCallbacks) {
            if (Number.isFinite(pending.expiresAt) && pending.expiresAt <= now) {
                this.pendingCallbacks.delete(token);
            }
        }
    }
}

// -------------------------------------------------------------------- wiring

interface PendingCallback {
    actionId: string;
    bindingHash: string;
    chatId: string;
    messageId?: number;
    expiresAt: number;
}

const POLL_TIMEOUT_SECONDS = 25;
const INITIAL_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 60_000;
/** Headroom under Telegram's 4096-character message limit for the numbering header. */
const TELEGRAM_MESSAGE_LIMIT = 3900;

function sleep(ms: number): Promise<void> {
    return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function describeConflict(error: unknown): string {
    return error instanceof Error ? error.constructor.name : 'unknown_error';
}

// ------------------------------------------------------------- text rendering

function renderChunks(view: LocalActionView): string[] {
    return splitIntoChunks(renderFullText(view), TELEGRAM_MESSAGE_LIMIT);
}

function renderFullText(view: LocalActionView): string {
    const lines: string[] = [];
    lines.push(
        view.kind === 'send_resource'
            ? '📤 Neue Freigabeanfrage: Versand'
            : '📝 Neue Freigabeanfrage: Zusammenfassung'
    );
    lines.push(`Zweck: ${view.purpose}`);
    lines.push(`Erstellt: ${view.createdAt}`);
    lines.push(`Läuft ab: ${view.expiresAt}`);
    lines.push('');
    lines.push(`Ressourcen (${view.resources.length}):`);
    view.resources.forEach((resource, index) => {
        lines.push(`${index + 1}. ${resource.title}`);
        lines.push(`   Quelle: ${resource.sourceLabel} (${resource.nativeIdDisplay})`);
        if (resource.mimeType) {
            lines.push(
                `   Typ: ${resource.mimeType}${resource.byteSize !== undefined ? `, ${resource.byteSize} Bytes` : ''}`
            );
        }
        if (resource.attributes) {
            const attrs = Object.entries(resource.attributes)
                .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
                .join('; ');
            if (attrs.length > 0) {
                lines.push(`   Merkmale: ${attrs}`);
            }
        }
        if (resource.excerpt) {
            lines.push(`   Auszug: ${resource.excerpt}`);
        }
        lines.push(
            `   Bewertung: Sensibilität ${resource.judgement.sensitivity}, Konfidenz ${Math.round(resource.judgement.confidence * 100)}%`
        );
        lines.push(`   Begründung: ${resource.judgement.reasoning}`);
        if (resource.judgement.uncertainties.length > 0) {
            lines.push(`   Offene Punkte: ${resource.judgement.uncertainties.join('; ')}`);
        }
        if (resource.judgement.basis) {
            lines.push(
                `   Inhaltsgrundlage: ${basisLabel(resource.judgement.basis.kind)}, ${resource.judgement.basis.textChars} Zeichen, Inhalt geprüft: ${resource.judgement.basis.contentChecked ? 'ja' : 'nein'}`
            );
        }
    });
    lines.push('');

    if (view.kind === 'send_resource') {
        lines.push(`Ziel: ${view.target.label} (${view.target.recipientDisplay})`);
        lines.push(`Zielzweck: ${view.target.purpose}`);
        if (view.target.dynamicRecipient) {
            lines.push('⚠️ Vom Agenten vorgeschlagener Empfänger — Adresse oben genau prüfen.');
        }
        lines.push(
            `Betreff: ${view.egress.subject && view.egress.subject.length > 0 ? view.egress.subject : '(kein Betreff)'}${view.egress.authoredByAgent.subject ? ' [vom Agenten verfasst]' : ''}`
        );
        lines.push('Text:');
        lines.push(view.egress.body.length > 0 ? view.egress.body : '(kein Text)');
        if (view.egress.authoredByAgent.body) {
            lines.push('[Text vom Agenten verfasst]');
        }
        lines.push('');
        lines.push(`Anhänge (${view.egress.attachments.length}, gesamt ${view.egress.totalBytes} Bytes):`);
        view.egress.attachments.forEach((attachment, index) => {
            lines.push(`${index + 1}. ${attachment.filename} — ${attachment.mimeType}, ${attachment.byteSize} Bytes`);
            lines.push(`   sha256: ${attachment.sha256}`);
        });
        if (view.needsRefetch) {
            lines.push('Hinweis: Die Anhänge werden bei Freigabe erneut aus der Quelle gelesen und geprüft.');
        }
    } else {
        lines.push(
            `Zusammenfassung von ${view.summary.model}${view.summary.focus ? ` (Fokus: ${view.summary.focus})` : ''}:`
        );
        lines.push(`sha256: ${view.summary.sha256}, ${view.summary.chars} Zeichen`);
        if (view.summary.redactions.length > 0) {
            lines.push(`Geschwärzt: ${view.summary.redactions.join(', ')}`);
        }
        if (view.summary.residuals.length > 0) {
            lines.push('⚠️ Möglicherweise noch enthalten:');
            view.summary.residuals.forEach((residual) => lines.push(`   ${residual.kind}: ${residual.sample}`));
        }
        lines.push('');
        lines.push('Text:');
        lines.push(view.summary.text);
    }

    lines.push('');
    lines.push(`Aktion: ${view.actionId}`);
    return lines.join('\n');
}

function basisLabel(kind: 'fulltext' | 'excerpt' | 'none'): string {
    return { fulltext: 'Volltext', excerpt: 'Auszug', none: 'nur Metadaten' }[kind];
}

/**
 * Splits on line boundaries first, hard-splitting only a single line that is
 * itself over the limit. Multi-part messages get a numbered header — inserted
 * after the size split, so it cannot itself push a chunk over the limit.
 */
function splitIntoChunks(text: string, limit: number): string[] {
    const lines = text.split('\n');
    const raw: string[] = [];
    let current = '';
    for (const line of lines) {
        const candidate = current.length === 0 ? line : `${current}\n${line}`;
        if (candidate.length <= limit) {
            current = candidate;
            continue;
        }
        if (current.length > 0) {
            raw.push(current);
            current = '';
        }
        if (line.length > limit) {
            for (let offset = 0; offset < line.length; offset += limit) {
                raw.push(line.slice(offset, offset + limit));
            }
        } else {
            current = line;
        }
    }
    if (current.length > 0) {
        raw.push(current);
    }
    if (raw.length <= 1) {
        return raw.length === 0 ? [''] : raw;
    }
    return raw.map((chunk, index) => `Teil ${index + 1}/${raw.length}\n\n${chunk}`);
}

// ---------------------------------------------------------------- callbacks

function buildKeyboard(actionId: string, token: string): TelegramInlineKeyboard {
    return {
        inline_keyboard: [
            [
                { text: '✅ Freigeben', callback_data: buildCallbackData('approve', actionId, token) },
                { text: '❌ Ablehnen', callback_data: buildCallbackData('reject', actionId, token) }
            ]
        ]
    };
}

function buildCallbackData(decision: 'approve' | 'reject', actionId: string, token: string): string {
    return `${decision === 'approve' ? 'a' : 'r'}:${actionId}:${token}`;
}

/** Telegram callback data is opaque to Telegram; this is the only parser for it. */
function parseCallbackData(
    data: string
): { decision: 'approve' | 'reject'; actionId: string; token: string } | undefined {
    const parts = data.split(':');
    if (parts.length !== 3) {
        return undefined;
    }
    const [flag, actionId, token] = parts;
    if (flag !== 'a' && flag !== 'r') {
        return undefined;
    }
    if (!actionId || !actionId.startsWith('act_') || !token || token.length === 0) {
        return undefined;
    }
    return { decision: flag === 'a' ? 'approve' : 'reject', actionId, token };
}

// ------------------------------------------------------------- Telegram API

export interface TelegramApiResult {
    ok?: boolean;
    description?: string;
    /** Shape depends on the method: an update array for `getUpdates`, an object for the rest. */
    result?: unknown;
}

interface TelegramInlineKeyboard {
    inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

export interface TelegramUpdate {
    update_id?: number;
    message?: { chat?: { id?: number | string } };
    callback_query?: TelegramCallbackQuery;
}

export interface TelegramCallbackQuery {
    id: string;
    from?: { id?: number | string };
    message?: { chat?: { id?: number | string } };
    data?: string;
}

function messageIdOf(result: TelegramApiResult): number | undefined {
    const payload = result.result;
    if (typeof payload !== 'object' || payload === null) {
        return undefined;
    }
    const messageId = (payload as { message_id?: unknown }).message_id;
    return typeof messageId === 'number' ? messageId : undefined;
}

/** The one seam this adapter exposes for tests: no real network, no real timers. */
export interface TelegramHttpClient {
    call(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<TelegramApiResult>;
}

/** Default client: JSON over `fetch`, exactly like the rest of the process's outbound HTTP. */
export class DefaultTelegramHttpClient implements TelegramHttpClient {
    constructor(
        private readonly botToken: () => string | undefined,
        private readonly apiBaseUrl = 'https://api.telegram.org',
        private readonly fetchImpl: typeof fetch = fetch,
        private readonly limits: {
            requestTimeoutMs: number;
            longPollHeadroomMs: number;
            maxResponseBytes: number;
        } = {
            requestTimeoutMs: 15_000,
            longPollHeadroomMs: 10_000,
            maxResponseBytes: 1024 * 1024
        }
    ) {}

    async call(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<TelegramApiResult> {
        const token = this.botToken();
        if (!token) {
            throw new Error('Telegram-Bot-Token ist nicht konfiguriert.');
        }
        const serverTimeoutSeconds =
            method === 'getUpdates' && typeof body.timeout === 'number' ? body.timeout : 0;
        const timeoutMs =
            method === 'getUpdates'
                ? serverTimeoutSeconds * 1000 + this.limits.longPollHeadroomMs
                : this.limits.requestTimeoutMs;
        let response: Response;
        let payload: TelegramApiResult;
        try {
            ({ response, payload } = await fetchJsonBounded<TelegramApiResult>(
                this.fetchImpl,
                `${this.apiBaseUrl.replace(/\/$/, '')}/bot${token}/${method}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                    signal
                },
                { timeoutMs, maxResponseBytes: this.limits.maxResponseBytes }
            ));
        } catch (error) {
            if (error instanceof HttpTimeoutError) {
                throw new Error(`Telegram-API: Zeitüberschreitung bei ${method}.`);
            }
            if (error instanceof HttpResponseTooLargeError) {
                throw new Error(`Telegram-API-Antwort bei ${method} war zu groß.`);
            }
            if (error instanceof HttpInvalidJsonError) {
                throw new Error(`Telegram-API antwortete bei ${method} nicht mit JSON.`);
            }
            throw new Error(`Telegram-API nicht erreichbar bei ${method}.`);
        }
        if (!response.ok || payload.ok !== true) {
            throw new Error(`Telegram-API meldete einen Fehler bei ${method} (HTTP ${response.status}).`);
        }
        return payload;
    }
}
