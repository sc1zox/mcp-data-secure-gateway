import type { TargetDescriptor } from '../core/types.js';

/**
 * Contract for an egress destination.
 *
 * The signature is the security property: `deliver` takes a subject, a body and
 * attachments — and no recipient. Where the data goes was decided when the
 * config file was written and is baked into the instance (invariant 6). There is
 * no code path, from Hermes or from the local model, that can name a different
 * address.
 */
export interface EgressTarget {
    readonly id: string;
    describe(): TargetDescriptor;
    /** Cheap reachability check used before an action is offered for approval. */
    checkAvailability(): Promise<TargetAvailability>;
    deliver(payload: EgressPayload): Promise<DeliveryReceipt>;
}

export interface EgressPayload {
    subject?: string;
    body: string;
    attachments: EgressAttachment[];
}

export interface EgressAttachment {
    filename: string;
    mimeType: string;
    bytes: Uint8Array;
}

export interface TargetAvailability {
    available: boolean;
    detail?: string;
}

export interface DeliveryReceipt {
    /** Transport-level id, kept locally for the audit trail. */
    reference: string;
    detail?: string;
}

export class TargetDeliveryError extends Error {}

/**
 * Masks an address for display in the approval view. The user needs to
 * recognise the destination, not read it in full — and the redacted form is what
 * ends up in screenshots and logs.
 */
export function maskEmail(address: string): string {
    const [local, domain] = address.split('@');
    if (!local || !domain) {
        return '***';
    }
    const head = local.slice(0, 1);
    return `${head}${'*'.repeat(Math.max(local.length - 1, 1))}@${domain}`;
}

/** Telegram chat ids are numeric and identifying; show only the tail. */
export function maskChatId(chatId: string): string {
    if (chatId.length <= 3) {
        return '***';
    }
    return `***${chatId.slice(-3)}`;
}
