import type { ActionRecord, ActionStatus, ActionStatusReason } from '../core/types.js';
import { TERMINAL_ACTION_STATUSES } from '../core/types.js';
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
    awaiting_local_approval: ['executing', 'rejected', 'expired', 'failed'],
    // A prepared action can end up needing a different resource; the user then
    // discards it and Hermes must prepare a new one.
    selection_required: ['awaiting_local_approval', 'rejected', 'expired'],
    executing: ['completed', 'failed'],
    completed: [],
    rejected: [],
    failed: [],
    expired: []
};

export class ActionStore {
    private readonly store: JsonlStore<ActionRecord>;

    constructor(dataDir: string, private readonly audit: AuditLog) {
        this.store = new JsonlStore<ActionRecord>(storePath(dataDir, 'actions'), (record) => record.actionId);
    }

    async load(): Promise<void> {
        await this.store.load();
        await this.expireStale();
    }

    async create(record: ActionRecord): Promise<void> {
        if (this.store.has(record.actionId)) {
            throw new ActionImmutabilityError(`Aktion ${record.actionId} existiert bereits.`);
        }
        await this.store.put(record);
        await this.audit.record('action_prepared', {
            actionId: record.actionId,
            resourceRef: record.resourceRef,
            targetId: record.plan.targetId,
            detail: {
                purpose: record.purpose,
                bindingHash: record.bindingHash,
                resourceStateHash: record.resourceStateHash,
                recipientDisplay: record.plan.recipientDisplay,
                subject: record.plan.subject,
                bodyChars: record.plan.body.length,
                attachments: record.plan.attachments,
                judgement: record.judgement,
                expiresAt: record.expiresAt
            }
        });
    }

    get(actionId: string): ActionRecord | undefined {
        return this.store.get(actionId);
    }

    all(): ActionRecord[] {
        return this.store.all();
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
                targetId: record.plan.targetId,
                detail: { expiresAt: record.expiresAt }
            });
            expired += 1;
        }
        return expired;
    }
}
