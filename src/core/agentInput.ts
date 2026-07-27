/**
 * Everything that touches untrusted Hermes input before it becomes state.
 *
 * Every value here originates on the far side of the trust boundary. None of
 * these functions look at a source or a stored record; they only decide
 * whether the shape Hermes sent is even well-formed enough to act on, and
 * clamp free text to what the rest of the gateway is willing to hold.
 */
import { MAX_ATTACHMENTS_PER_ACTION, MAX_RECIPIENT_CHARS } from './limits.js';

export interface FindResourceInput {
    query: string;
    purpose: string;
    /** Optional handle from an earlier `selection_required` answer. */
    pendingSelection?: string;
}

export interface PrepareActionInput {
    /** Backward-compatible single-reference form. Mutually exclusive with `references`. */
    reference?: string;
    /** Ordered complete attachment set. Mutually exclusive with `reference`. */
    references?: string[];
    target: string;
    purpose: string;
    /**
     * Optional short note from Hermes. Only used when `body` is absent — with an
     * agent-written body there is nothing for a separately attributed note to
     * be distinguished from.
     */
    note?: string;
    /**
     * Subject line written by Hermes. Optional; without it the gateway composes
     * one from the resource label.
     */
    subject?: string;
    /**
     * Message body written by Hermes, used verbatim. Optional; without it the
     * gateway composes the previous machine-notice body.
     *
     * Verbatim is the point: a message that has to read like ordinary post — an
     * application, a reply to a request — cannot carry a gateway footer. The
     * control is not that the gateway edits this text but that the user reads
     * all of it, marked as agent-written, before releasing it, and that the
     * binding hash covers it so it cannot change afterwards.
     */
    body?: string;
    /**
     * Concrete recipient address. Only accepted for a target whose descriptor
     * sets `dynamicRecipient: true`; required there, refused everywhere else.
     */
    recipient?: string;
}

export interface SummarizeResourceInput {
    reference: string;
    purpose: string;
    /**
     * What the agent hopes to learn. Reaches the local model as a quoted wish,
     * never as an instruction, and can only narrow what the summary talks about
     * — it cannot loosen the redaction rules, which are in the system prompt.
     */
    focus?: string;
}

const RESOURCE_REFERENCE_PATTERN = /^res_[0-9a-f]{12}$/;

/** Validates the mutually exclusive legacy/new public forms without echoing input. */
export function normaliseRequestedReferences(input: PrepareActionInput): string[] | undefined {
    const hasLegacy = input.reference !== undefined;
    const hasSet = input.references !== undefined;
    if (hasLegacy === hasSet) {
        return undefined;
    }
    const references = hasLegacy ? [input.reference!] : input.references!;
    if (
        references.length === 0 ||
        references.length > MAX_ATTACHMENTS_PER_ACTION ||
        references.some(
            (reference) =>
                typeof reference !== 'string' || !RESOURCE_REFERENCE_PATTERN.test(reference)
        )
    ) {
        return undefined;
    }
    if (new Set(references).size !== references.length) {
        return undefined;
    }
    return [...references];
}

/**
 * Coarse shape check on a Hermes-supplied recipient, applied before an action
 * can even be created. `MailTarget.deliver` repeats an equivalent check
 * independently right before sending, so a bug or a tampered store here
 * cannot turn into a send to a malformed address either.
 */
export function isValidRecipientFormat(value: string): boolean {
    return value.length <= MAX_RECIPIENT_CHARS && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function clamp(value: string | undefined, limit: number): string {
    if (typeof value !== 'string') {
        return '';
    }
    const normalised = value.replace(/\s+/g, ' ').trim();
    return normalised.length <= limit ? normalised : normalised.slice(0, limit);
}

/**
 * Clamp for text that is meant to be read as prose: line breaks survive,
 * everything else that could carry structure does not.
 *
 * Control characters are dropped rather than escaped. In a mail body they are
 * invisible, so text containing them would render to the user in the approval
 * view as something subtly different from what the transport later sends — and
 * this view's whole purpose is that the two are the same thing.
 */
export function clampMultiline(value: string | undefined, limit: number): string {
    if (typeof value !== 'string') {
        return '';
    }
    const normalised = value
        .replace(/\r\n?/g, '\n')
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
        .replace(/[ \t]+$/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return normalised.length <= limit ? normalised : `${normalised.slice(0, limit - 1).trimEnd()}…`;
}

export function emptyToUndefined(value: string): string | undefined {
    return value.length > 0 ? value : undefined;
}
