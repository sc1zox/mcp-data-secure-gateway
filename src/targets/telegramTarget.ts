import type { TelegramTargetConfig } from '../config.js';
import type { TargetDescriptor } from '../core/types.js';
import { createLogger, describeError, type Logger } from '../util/log.js';
import {
    TargetDeliveryError,
    maskChatId,
    type DeliveryReceipt,
    type EgressPayload,
    type EgressTarget,
    type TargetAvailability
} from './target.js';

/**
 * The `private_telegram` target: one fixed chat id, configured locally.
 *
 * As with mail, the destination is a field of this instance and never a parameter
 * of `deliver`.
 */
export class TelegramTarget implements EgressTarget {
    readonly id: string;
    private readonly log: Logger;

    constructor(private readonly config: TelegramTargetConfig, logger?: Logger) {
        this.id = config.id;
        this.log = (logger ?? createLogger('target')).child(config.id);
    }

    describe(): TargetDescriptor {
        return {
            id: this.config.id,
            label: this.config.label,
            purpose: this.config.purpose,
            recipientDisplay: maskChatId(this.config.chatId),
            dynamicRecipient: false,
            supportsAttachments: true,
            maxAttachmentBytes: this.config.maxAttachmentBytes,
            maxAttachments: this.config.maxAttachments
        };
    }

    async checkAvailability(): Promise<TargetAvailability> {
        try {
            const response = await this.call('getMe', new FormData());
            return { available: response.ok === true };
        } catch (error) {
            return { available: false, detail: describeError(error) };
        }
    }

    async deliver(payload: EgressPayload): Promise<DeliveryReceipt> {
        if (payload.attachments.length > this.config.maxAttachments) {
            throw new TargetDeliveryError(
                `Die Nachricht enthält ${payload.attachments.length} Anhänge; erlaubt sind ${this.config.maxAttachments}.`
            );
        }
        const total = payload.attachments.reduce((sum, item) => sum + item.bytes.byteLength, 0);
        if (total > this.config.maxAttachmentBytes) {
            throw new TargetDeliveryError(
                `Anhänge (${total} Bytes) überschreiten das Limit von ${this.config.maxAttachmentBytes} Bytes.`
            );
        }

        const caption = [payload.subject, payload.body].filter(Boolean).join('\n\n');
        const references: string[] = [];

        if (payload.attachments.length === 0) {
            references.push(await this.sendMessage(caption));
        } else {
            // Telegram captions are capped at 1024 characters. Sending the text as
            // its own message first keeps the body intact instead of truncating
            // content the user approved.
            if (caption.length > 0) {
                references.push(await this.sendMessage(caption));
            }
            for (const attachment of payload.attachments) {
                references.push(await this.sendDocument(attachment.filename, attachment.mimeType, attachment.bytes));
            }
        }

        this.log.info('Telegram-Nachricht versandt', { parts: references.length });
        return { reference: references.join(','), detail: `${references.length} Teil(e)` };
    }

    private async sendMessage(text: string): Promise<string> {
        const form = new FormData();
        form.set('chat_id', this.config.chatId);
        form.set('text', text.length > 0 ? text : 'Dokument aus dem Local Trust Gateway');
        const result = await this.call('sendMessage', form);
        return messageIdOf(result);
    }

    private async sendDocument(filename: string, mimeType: string, bytes: Uint8Array): Promise<string> {
        const form = new FormData();
        form.set('chat_id', this.config.chatId);
        form.set('document', new Blob([bytes], { type: mimeType }), filename);
        const result = await this.call('sendDocument', form);
        return messageIdOf(result);
    }

    private async call(method: string, form: FormData): Promise<TelegramResponse> {
        const url = `${this.config.apiBaseUrl.replace(/\/$/, '')}/bot${this.config.botToken}/${method}`;
        let response: Response;
        try {
            response = await fetch(url, { method: 'POST', body: form });
        } catch (error) {
            throw new TargetDeliveryError(`Telegram-API nicht erreichbar: ${describeError(error)}`);
        }
        let payload: TelegramResponse;
        try {
            payload = (await response.json()) as TelegramResponse;
        } catch (error) {
            throw new TargetDeliveryError(
                `Telegram-API antwortete nicht mit JSON (HTTP ${response.status}): ${describeError(error)}`
            );
        }
        if (!response.ok || payload.ok !== true) {
            throw new TargetDeliveryError(
                `Telegram-API meldete einen Fehler (HTTP ${response.status}): ${
                    payload.description ?? 'ohne Beschreibung'
                }`
            );
        }
        return payload;
    }
}

interface TelegramResponse {
    ok?: boolean;
    description?: string;
    result?: { message_id?: number };
}

function messageIdOf(response: TelegramResponse): string {
    const id = response.result?.message_id;
    return typeof id === 'number' ? String(id) : 'unbekannt';
}
