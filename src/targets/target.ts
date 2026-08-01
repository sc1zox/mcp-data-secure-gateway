import type { TargetDescriptor } from '../core/types.js';

/**
 * Contract for an egress destination.
 *
 * `deliver` takes a subject, a body, attachments — and an optional `recipient`
 * that exists solely for the small set of targets built with a dynamic
 * recipient (invariant 6). A target that was not explicitly configured that
 * way (`describe().dynamicRecipient === false`) must ignore `payload.recipient`
 * entirely and use its own configured, fixed destination; nothing upstream of
 * a target implementation can force it to honour a recipient it wasn't built
 * to accept. Where a fixed destination points was decided when the config file
 * was written and is baked into the instance.
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
    /** Only meaningful for a target whose descriptor sets `dynamicRecipient: true`. */
    recipient?: string;
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

/** Telegram chat ids are numeric and identifying; show only the tail. */
export function maskChatId(chatId: string): string {
    if (chatId.length <= 3) {
        return '***';
    }
    return `***${chatId.slice(-3)}`;
}
