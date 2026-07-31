/**
 * Protection against approval fatigue.
 *
 * The realistic failure of a rogue or merely confused agent is not a forged
 * hash — it is volume. Fifty plausible-looking approval requests in a minute,
 * each individually defensible, until the person clicking them stops reading.
 * A user who approves without reading has lost every protection this gateway
 * offers, and no cryptography further in prevents that.
 *
 * So three cheap bounds sit in front of `prepare_action` and
 * `summarize_resource`, all of them checked *before* the source is read and
 * before the local model runs. A refusal here costs the gateway nothing, which
 * is what lets it survive being called in a loop:
 *
 *  - a rate limit on how many actions may be prepared in a window,
 *  - a ceiling on how many may await a decision at once,
 *  - refusal of a request identical to one already waiting.
 *
 * All three are deliberately exact. A fuzzy "nearly identical" rule would need
 * a threshold nobody can justify and would start refusing legitimate work — two
 * genuinely different mails about the same document, say — which trains the
 * user to distrust the gateway rather than the agent.
 */
import type { ActionRecord } from './types.js';
import { resourceBindingsOf } from './types.js';
import { AGENT_NOTE_MARKER } from './planBuilder.js';

/** Why a preparation was refused before it began. Maps 1:1 onto an egress note. */
export type PreparationRefusal = 'rate_limited' | 'too_many_open_actions' | 'duplicate_action';

export interface PreparationLimits {
    /** Actions that may await a decision at the same time. */
    maxOpenActions: number;
    /** Actions that may be prepared within `windowSeconds`. */
    maxPreparedPerWindow: number;
    windowSeconds: number;
}

/**
 * Everything about a request that decides whether it asks for the same thing as
 * one already on screen.
 *
 * Built from what the agent sent, not from what the gateway made of it. That
 * matters for the body: a locally composed one carries a timestamp, so two
 * identical requests produce two different bodies, and comparing the finished
 * plans would find no duplicates at all.
 */
export interface PreparationKey {
    kind: 'send_resource' | 'summarize_resource';
    /** Ordered — a different attachment order is a different action. */
    resourceRefs: string[];
    purpose: string;
    targetId?: string;
    recipient?: string;
    /** Only what the agent supplied verbatim; absent when the gateway composed it. */
    subject?: string;
    body?: string;
    note?: string;
    focus?: string;
}

export class PreparationLimiter {
    /** Timestamps of successfully prepared actions, newest last. */
    private readonly prepared: number[] = [];

    constructor(
        private readonly limits: PreparationLimits,
        /** Actions still occupying the user's attention, in either open state. */
        private readonly openActions: () => ActionRecord[]
    ) {}

    /**
     * Whether this request may proceed. Returns the refusal, or `undefined` to
     * carry on.
     *
     * Order matters: the duplicate check is last because it is the most
     * specific, and a caller that is both over its rate and repeating itself is
     * better told about the rate.
     */
    check(key: PreparationKey, now: number = Date.now()): PreparationRefusal | undefined {
        this.forget(now);
        if (this.prepared.length >= this.limits.maxPreparedPerWindow) {
            return 'rate_limited';
        }
        const open = this.openActions();
        if (open.length >= this.limits.maxOpenActions) {
            return 'too_many_open_actions';
        }
        const duplicate = open.some((record) => sameRequest(key, keyOfStoredAction(record)));
        return duplicate ? 'duplicate_action' : undefined;
    }

    /**
     * Counts one action against the rate limit.
     *
     * Called after the action exists, not when one was attempted. A refused
     * request must stay free: counting attempts would let a retry loop lock the
     * user out of work they actually wanted.
     */
    recordPrepared(now: number = Date.now()): void {
        this.prepared.push(now);
    }

    private forget(now: number): void {
        const cutoff = now - this.limits.windowSeconds * 1000;
        while (this.prepared.length > 0 && this.prepared[0]! <= cutoff) {
            this.prepared.shift();
        }
    }
}

/** Field-by-field equality. No normalisation beyond what the caller already did. */
function sameRequest(left: PreparationKey, right: PreparationKey | undefined): boolean {
    if (!right || left.kind !== right.kind) {
        return false;
    }
    return (
        left.resourceRefs.length === right.resourceRefs.length &&
        left.resourceRefs.every((ref, index) => ref === right.resourceRefs[index]) &&
        left.purpose === right.purpose &&
        left.targetId === right.targetId &&
        left.recipient === right.recipient &&
        left.subject === right.subject &&
        left.body === right.body &&
        left.note === right.note &&
        left.focus === right.focus
    );
}

/**
 * Reconstructs the request an open action came from.
 *
 * Everything needed is already on the record — `authoredByAgent` says which of
 * subject and body the agent wrote, and a note the agent sent survives inside
 * the locally composed body under its attribution marker. So duplicate
 * detection needs no extra stored field, and cannot drift out of step with the
 * plan it is comparing against.
 */
function keyOfStoredAction(record: ActionRecord): PreparationKey | undefined {
    const resourceRefs = resourceBindingsOf(record).map((binding) => binding.resourceRef);
    if (record.plan.kind === 'summarize_resource') {
        return {
            kind: 'summarize_resource',
            resourceRefs,
            purpose: record.purpose,
            focus: record.plan.focus
        };
    }
    const plan = record.plan;
    const authored = plan.authoredByAgent ?? { subject: false, body: false };
    return {
        kind: 'send_resource',
        resourceRefs,
        purpose: record.purpose,
        targetId: plan.targetId,
        recipient: plan.recipientAddress,
        subject: authored.subject ? plan.subject : undefined,
        body: authored.body ? plan.body : undefined,
        note: authored.body ? undefined : agentNoteIn(plan.body)
    };
}

/** The agent's note back out of a locally composed body, or nothing. */
function agentNoteIn(body: string): string | undefined {
    const marker = body.indexOf(AGENT_NOTE_MARKER);
    if (marker < 0) {
        return undefined;
    }
    const note = body.slice(marker + AGENT_NOTE_MARKER.length).trim();
    return note.length > 0 ? note : undefined;
}
