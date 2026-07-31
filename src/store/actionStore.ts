import type { ActionPlan, ActionRecord, ActionStatus, ActionStatusReason } from '../core/types.js';
import { resourceBindingsOf, TERMINAL_ACTION_STATUSES, targetIdOf } from '../core/types.js';
import { JsonlStore, storePath } from './jsonlStore.js';
import type { AuditLog } from './auditLog.js';

export class ActionImmutabilityError extends Error {}
export class ActionTransitionError extends Error {}

/**
 * Legal status transitions. Anything not listed is refused, which is what makes
 * "a decided action stays decided" a property of the store rather than a habit
 * of its callers (invariant 12).
 */
const ALLOWED_TRANSITIONS: Record<ActionStatus, readonly ActionStatus[]> = {
    // `selection_required` is the parking state for "the user wants to look at
    // the resource choice again". It is deliberately reachable from here and
    // deliberately not approvable, so an action under review cannot be released
    // while the user is still deciding what it should point at.
    awaiting_local_approval: ['executing', 'rejected', 'expired', 'failed', 'selection_required'],
    // Back to awaiting approval when the user confirms the resource the action
    // already carried; rejected when they pick a different one, because the
    // binding covers the resource and a new one needs a new action.
    selection_required: ['awaiting_local_approval', 'rejected', 'expired'],
    executing: ['completed', 'failed'],
    completed: [],
    rejected: [],
    failed: [],
    expired: []
};

/**
 * What a prepared action puts in the trail, per kind.
 *
 * Neither branch writes the payload itself: the mail body is recorded by
 * character count, and a summary by its digest and length. The text of both
 * already lives in `actions.jsonl`, and an audit trail that copied it would be a
 * second file holding private content with a different retention rule — this one
 * is never compacted and never deleted.
 */
function planAuditDetail(plan: ActionPlan): Record<string, unknown> {
    if (plan.kind === 'summarize_resource') {
        return {
            kind: plan.kind,
            summarySha256: plan.summarySha256,
            summaryChars: plan.summary.length,
            redactions: plan.redactions,
            model: plan.model
        };
    }
    return {
        kind: plan.kind,
        recipientDisplay: plan.recipientDisplay,
        subject: plan.subject,
        bodyChars: plan.body.length,
        attachments: plan.attachments
    };
}

/** Notified after a status change was persisted. */
export type ActionTransitionListener = (record: ActionRecord) => void;
/** Notified after a brand-new action was persisted. */
export type ActionCreateListener = (record: ActionRecord) => void;

export class ActionStore {
    private readonly store: JsonlStore<ActionRecord>;
    private readonly listeners = new Set<ActionTransitionListener>();
    private readonly createListeners = new Set<ActionCreateListener>();

    constructor(dataDir: string, private readonly audit: AuditLog) {
        this.store = new JsonlStore<ActionRecord>(storePath(dataDir, 'actions'), (record) => record.actionId);
    }

    /**
     * Subscribes to status changes.
     *
     * Every path that moves an action goes through `transition`, so a listener
     * registered here sees all of them — the user's decision, delivery
     * finishing, the sweeper expiring something. That is what lets a waiting
     * caller be woken instead of polling the store, and it is why the hook lives
     * on the store rather than on any one of those callers.
     */
    onTransition(listener: ActionTransitionListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /**
     * Subscribes to newly prepared actions, i.e. the moment `create` persists
     * one — before any transition has happened. Used only by the optional
     * Telegram approval channel to notify without polling the state endpoint.
     */
    onCreate(listener: ActionCreateListener): () => void {
        this.createListeners.add(listener);
        return () => this.createListeners.delete(listener);
    }

    async load(): Promise<void> {
        await this.store.load();
        await this.recoverInterrupted();
        await this.discardOpen();
    }

    /**
     * Drops every action that was still waiting for a decision when the process
     * stopped.
     *
     * An open action is a promise about bytes: `prepare_action` staged the
     * originals in memory, showed the user their sizes and digests, and the
     * approval covers exactly those. A restart empties that map, so honouring
     * such an action later would mean re-reading the files, re-proving they are
     * unchanged, and re-deciding what to do when they are not — a second,
     * rarely-taken code path guarding the most dangerous moment in the gateway.
     *
     * Expiring them instead costs Hermes one `prepare_action` and removes that
     * path entirely, along with the possibility of executing something the user
     * approved before a reboot they may not even remember. Decided actions are
     * untouched: they are the audit trail.
     */
    private async discardOpen(): Promise<void> {
        for (const record of this.store.all()) {
            if (record.status !== 'awaiting_local_approval' && record.status !== 'selection_required') {
                continue;
            }
            await this.transition(record.actionId, 'expired', { reason: 'action_expired' });
            await this.audit.record('action_expired', {
                actionId: record.actionId,
                resourceRef: record.resourceRef,
                targetId: targetIdOf(record.plan),
                detail: { expiresAt: record.expiresAt, discardedByRestart: true }
            });
        }
    }

    /**
     * Closes out actions that were mid-delivery when the process died.
     *
     * `executing` means "the transport was called, or was about to be". After a
     * restart there is no way to learn which — the SMTP server may have accepted
     * the message a millisecond before the power went out. So the action is
     * marked failed and the user prepares a new one if they still want it.
     *
     * Retrying would be the other option and is the wrong one: a duplicate
     * application sent to an employer cannot be recalled, whereas a send that
     * has to be repeated by hand costs a minute. The audit trail keeps both the
     * `action_approved` entry and this failure, so the ambiguity is visible
     * rather than resolved by a guess.
     */
    private async recoverInterrupted(): Promise<void> {
        for (const record of this.store.all()) {
            if (record.status !== 'executing') {
                continue;
            }
            await this.transition(record.actionId, 'failed', {
                reason: 'delivery_failed',
                localOutcome:
                    'Die Ausführung wurde durch einen Neustart unterbrochen. Ob die Übertragung ' +
                    'stattgefunden hat, ist nicht feststellbar; es wird nicht automatisch erneut versandt.'
            });
            await this.audit.record('egress_failed', {
                actionId: record.actionId,
                resourceRef: record.resourceRef,
                targetId: targetIdOf(record.plan),
                detail: { reason: 'delivery_failed', interruptedByRestart: true }
            });
        }
    }

    async create(record: ActionRecord): Promise<void> {
        if (this.store.has(record.actionId)) {
            throw new ActionImmutabilityError(`Aktion ${record.actionId} existiert bereits.`);
        }
        const bindings = resourceBindingsOf(record);
        await this.store.put(record);
        await this.audit.record('action_prepared', {
            actionId: record.actionId,
            resourceRef: record.resourceRef,
            targetId: targetIdOf(record.plan),
            detail: {
                purpose: record.purpose,
                bindingHash: record.bindingHash,
                resourceBindings: bindings.map(({ resourceRef, resourceStateHash, judgement }) => ({
                    resourceRef,
                    resourceStateHash,
                    judgement
                })),
                ...planAuditDetail(record.plan),
                judgement: record.judgement,
                expiresAt: record.expiresAt
            }
        });
        for (const listener of this.createListeners) {
            // Same rule as `transition`: a broken listener must not undo a
            // creation that is already on disk, nor block the others.
            try {
                listener(record);
            } catch {
                // Intentionally ignored; notification is not part of the state.
            }
        }
    }

    get(actionId: string): ActionRecord | undefined {
        return this.store.get(actionId);
    }

    all(): ActionRecord[] {
        return this.store.all();
    }

    /**
     * Everything still on the user's plate: awaiting a decision, or parked on a
     * selection while they look at the resource choice again. Both occupy
     * attention, which is what the open-action ceiling is really rationing.
     */
    open(now: Date = new Date()): ActionRecord[] {
        return this.store
            .all()
            .filter(
                (record) =>
                    (record.status === 'awaiting_local_approval' ||
                        record.status === 'selection_required') &&
                    Date.parse(record.expiresAt) > now.getTime()
            );
    }

    /** Actions still waiting for a human decision, oldest first. */
    pending(now: Date = new Date()): ActionRecord[] {
        return this.store
            .all()
            .filter(
                (record) =>
                    record.status === 'awaiting_local_approval' &&
                    Date.parse(record.expiresAt) > now.getTime()
            )
            .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    }

    /**
     * The only mutation path. It can change status bookkeeping and nothing else:
     * the plan, the binding hash, the purpose and the judgement are fixed at
     * preparation time, so an approval can never be re-pointed at other content.
     */
    async transition(
        actionId: string,
        nextStatus: ActionStatus,
        options: {
            reason?: ActionStatusReason;
            localOutcome?: string;
            decidedAt?: string;
            executedAt?: string;
        } = {}
    ): Promise<ActionRecord> {
        const current = this.store.get(actionId);
        if (!current) {
            throw new ActionTransitionError(`Aktion ${actionId} ist unbekannt.`);
        }
        if (TERMINAL_ACTION_STATUSES.includes(current.status)) {
            throw new ActionImmutabilityError(
                `Aktion ${actionId} ist mit Status ${current.status} abgeschlossen und unveränderlich.`
            );
        }
        const allowed = ALLOWED_TRANSITIONS[current.status];
        if (!allowed.includes(nextStatus)) {
            throw new ActionTransitionError(
                `Übergang ${current.status} -> ${nextStatus} ist für Aktion ${actionId} nicht erlaubt.`
            );
        }

        const updated: ActionRecord = {
            ...current,
            status: nextStatus,
            statusReason: options.reason ?? current.statusReason,
            localOutcome: options.localOutcome ?? current.localOutcome,
            decidedAt: options.decidedAt ?? current.decidedAt,
            executedAt: options.executedAt ?? current.executedAt
        };
        await this.store.put(updated);
        for (const listener of this.listeners) {
            // A broken listener must not roll back a transition that is already
            // on disk, nor stop the remaining ones from being told about it.
            try {
                listener(updated);
            } catch {
                // Intentionally ignored; notification is not part of the state.
            }
        }
        return updated;
    }

    /**
     * Marks actions whose approval window elapsed. Runs on startup and on a
     * timer, so an action prepared before a reboot cannot be approved days
     * later against a resource that has since changed.
     */
    async expireStale(now: Date = new Date()): Promise<number> {
        let expired = 0;
        for (const record of this.store.all()) {
            const isOpen =
                record.status === 'awaiting_local_approval' || record.status === 'selection_required';
            if (!isOpen || Date.parse(record.expiresAt) > now.getTime()) {
                continue;
            }
            await this.transition(record.actionId, 'expired', { reason: 'action_expired' });
            await this.audit.record('action_expired', {
                actionId: record.actionId,
                resourceRef: record.resourceRef,
                targetId: targetIdOf(record.plan),
                detail: { expiresAt: record.expiresAt }
            });
            expired += 1;
        }
        return expired;
    }
}
