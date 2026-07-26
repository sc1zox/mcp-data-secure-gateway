import nodemailer, { type Transporter } from 'nodemailer';
import type { MailTargetConfig } from '../config.js';
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
 * The `private_mail` target: one fixed recipient, configured locally.
 *
 * `this.config.to` is read directly in `deliver` and never taken from the
 * payload, so no amount of creative input from Hermes or a document can redirect
 * a message.
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
            recipientDisplay: maskEmail(this.config.to),
            supportsAttachments: true,
            maxAttachmentBytes: this.config.maxAttachmentBytes
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
        const total = payload.attachments.reduce((sum, item) => sum + item.bytes.byteLength, 0);
        if (total > this.config.maxAttachmentBytes) {
            throw new TargetDeliveryError(
                `Anhänge (${total} Bytes) überschreiten das Limit von ${this.config.maxAttachmentBytes} Bytes.`
            );
        }
        try {
            const info = await this.transport().sendMail({
                from: this.config.from,
                // Fixed recipient. Deliberately not parameterised.
                to: this.config.to,
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
