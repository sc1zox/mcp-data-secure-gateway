import nodemailer, { type Transporter } from 'nodemailer';
import type { MailTargetConfig } from '../config.js';
import { buildTransformPolicy } from '../attachments/profiles.js';
import type { TargetDescriptor } from '../core/types.js';
import { createLogger, describeError, type Logger } from '../util/log.js';
import {
    TargetDeliveryError,
    maskEmail,
    type DeliveryReceipt,
    type EgressPayload,
    type EgressTarget,
    type TargetAvailability
} from './target.js';

/**
 * An SMTP target.
 *
 * By default this is exactly the fixed-recipient target invariant 6 describes:
 * `this.config.to` is read directly in `deliver` and the payload's `recipient`
 * is never even looked at, so no amount of creative input from Hermes or a
 * document can redirect a message.
 *
 * With `allowDynamicRecipient` set, this instance is the one deliberate
 * exception: the address comes from the approved action instead, but never
 * without having been shown, unmasked, in the local approval view and approved
 * there — see `Orchestrator.prepareAction`.
 */
export class MailTarget implements EgressTarget {
    readonly id: string;
    private transporter?: Transporter;
    private readonly log: Logger;

    constructor(private readonly config: MailTargetConfig, logger?: Logger) {
        this.id = config.id;
        this.log = (logger ?? createLogger('target')).child(config.id);
    }

    private transport(): Transporter {
        if (!this.transporter) {
            this.transporter = nodemailer.createTransport({
                host: this.config.smtp.host,
                port: this.config.smtp.port,
                secure: this.config.smtp.secure,
                auth: { user: this.config.smtp.user, pass: this.config.smtp.password },
                // Opportunistic STARTTLS on the submission port; a downgrade to
                // plaintext would put the credentials and the document on the wire.
                requireTLS: !this.config.smtp.secure
            });
        }
        return this.transporter;
    }

    describe(): TargetDescriptor {
        return {
            id: this.config.id,
            label: this.config.label,
            purpose: this.config.purpose,
            recipientDisplay: this.config.allowDynamicRecipient
                ? '(vom Nutzer je Aktion bestätigt)'
                : maskEmail(this.config.to!),
            dynamicRecipient: this.config.allowDynamicRecipient,
            supportsAttachments: true,
            maxAttachmentBytes: this.config.maxAttachmentBytes,
            maxAttachments: this.config.maxAttachments,
            optimization: buildTransformPolicy(this.config.optimization)
        };
    }

    async checkAvailability(): Promise<TargetAvailability> {
        try {
            await this.transport().verify();
            return { available: true };
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
        // A target not built for a dynamic recipient never reads payload.recipient,
        // no matter what it contains — the address only ever comes from config.
        const recipient = this.config.allowDynamicRecipient ? payload.recipient : this.config.to;
        if (!recipient || !isPlausibleEmail(recipient)) {
            throw new TargetDeliveryError('Kein gültiger Empfänger für diese Aktion vorhanden.');
        }
        try {
            const info = await this.transport().sendMail({
                from: this.config.from,
                to: recipient,
                subject: payload.subject ?? 'Dokument aus dem Local Trust Gateway',
                text: payload.body,
                attachments: payload.attachments.map((attachment) => ({
                    filename: attachment.filename,
                    contentType: attachment.mimeType,
                    content: Buffer.from(attachment.bytes)
                }))
            });
            this.log.info('E-Mail versandt', { messageId: info.messageId });
            return {
                reference: info.messageId ?? 'unbekannt',
                detail: Array.isArray(info.accepted) ? `akzeptiert: ${info.accepted.length}` : undefined
            };
        } catch (error) {
            throw new TargetDeliveryError(`SMTP-Versand fehlgeschlagen: ${describeError(error)}`);
        }
    }

    async close(): Promise<void> {
        this.transporter?.close();
        this.transporter = undefined;
    }
}

/**
 * Last-resort shape check right before a dynamic recipient reaches SMTP. The
 * orchestrator already validates the address before an action can be
 * approved; this is a second, independent check so a bug or a tampered store
 * cannot turn into a send to a malformed or empty destination.
 */
function isPlausibleEmail(value: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
