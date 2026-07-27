/**
 * Invariant 12 — freigegebene Aktionen sind unveränderlich.
 *
 * Everything that decides what a stored action is allowed to be pinned to —
 * a resource's identity in a particular state, the destination it may reach,
 * and the digest that binds resource set, destination and plan into one
 * approvable unit — lives here. `approveAction` (in `orchestrator.ts`) trusts
 * this module to say whether a stored record still matches what was shown.
 */
import { safeEqual, stableHash } from '../util/hash.js';
import type { ActionPlan, ActionRecord, ActionResourceBinding, InternalResource } from './types.js';
import { resourceBindingsOf } from './types.js';
import { MAX_ATTACHMENTS_PER_ACTION } from './limits.js';

/**
 * Identity of a resource *in a particular state*. Covering the state token means
 * an edited document yields a different hash, which invalidates references and
 * approvals that were made against the old content.
 */
export function resourceStateHash(resource: InternalResource): string {
    return stableHash({
        sourceId: resource.locator.sourceId,
        nativeId: resource.locator.nativeId,
        stateToken: resource.stateToken,
        title: resource.title,
        byteSize: resource.byteSize ?? null,
        mimeType: resource.mimeType ?? null
    });
}

/**
 * Where an approval's payload is allowed to go, as the binding hash names it.
 *
 * A summary has no configured target: its destination is the agent that asked,
 * and it can only be collected through `get_summary`. Naming that destination
 * explicitly in the hash is what stops a stored plan from being reinterpreted as
 * a delivery to a target — the two produce different hashes even if everything
 * else about them matched.
 */
const AGENT_DESTINATION = 'cloud_agent';

function bindingDestination(plan: ActionPlan): string {
    return plan.kind === 'send_resource' ? plan.targetId : AGENT_DESTINATION;
}

/** Pins an approval to one exact resource state, destination and payload. */
export function computeBindingHash(
    resourceRef: string,
    resourceStateHashValue: string,
    plan: ActionPlan
): string;
export function computeBindingHash(
    resources: Array<{ resourceRef: string; resourceStateHash: string }>,
    plan: ActionPlan
): string;
export function computeBindingHash(
    resourceOrSet: string | Array<{ resourceRef: string; resourceStateHash: string }>,
    stateOrPlan: string | ActionPlan,
    legacyPlan?: ActionPlan
): string {
    if (typeof resourceOrSet !== 'string') {
        const plan = stateOrPlan as ActionPlan;
        return stableHash({
            resources: resourceOrSet,
            targetId: bindingDestination(plan),
            plan
        });
    }
    const plan = legacyPlan!;
    return stableHash({
        resourceRef: resourceOrSet,
        resourceStateHash: stateOrPlan as string,
        targetId: bindingDestination(plan),
        plan
    });
}

/** Structural checks for redundant legacy aliases and attachment/resource order. */
export function isConsistentStoredResourceSet(
    action: ActionRecord,
    bindings: ActionResourceBinding[]
): boolean {
    if (
        bindings.length === 0 ||
        bindings.length > MAX_ATTACHMENTS_PER_ACTION ||
        new Set(bindings.map((binding) => binding.resourceRef)).size !== bindings.length
    ) {
        return false;
    }
    const first = bindings[0]!;
    if (
        first.resourceRef !== action.resourceRef ||
        first.resourceStateHash !== action.resourceStateHash
    ) {
        return false;
    }
    if (
        action.plan.kind === 'send_resource' &&
        action.plan.attachments.length !== bindings.length
    ) {
        return false;
    }
    return action.plan.kind !== 'summarize_resource' || bindings.length === 1;
}

/** What a stored action failed to still be, for `approveAction`'s audit trail. */
export type BindingVerification =
    | { ok: true; bindings: ActionResourceBinding[] }
    | { ok: false; invariant: 'action_resource_set' }
    | { ok: false; invariant: 'action_immutability'; expected: string };

/**
 * The full answer to "is this stored action still exactly what was shown and
 * approved?" — structurally consistent, and its hash still follows from the
 * fields it covers. A legacy record (no `resourceBindings`) is recomputed with
 * its original single-resource formula so pending actions survive an upgrade.
 */
export function verifyStoredBinding(action: ActionRecord): BindingVerification {
    const bindings = resourceBindingsOf(action);
    if (!isConsistentStoredResourceSet(action, bindings)) {
        return { ok: false, invariant: 'action_resource_set' };
    }
    const recomputed = action.resourceBindings
        ? computeBindingHash(
              bindings.map(({ resourceRef, resourceStateHash }) => ({ resourceRef, resourceStateHash })),
              action.plan
          )
        : computeBindingHash(action.resourceRef, action.resourceStateHash, action.plan);
    if (!safeEqual(recomputed, action.bindingHash)) {
        return { ok: false, invariant: 'action_immutability', expected: recomputed };
    }
    return { ok: true, bindings };
}
