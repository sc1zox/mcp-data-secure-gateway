/**
 * The local-only projection of an action or a selection: everything the
 * approval view is allowed to show a human, which is deliberately more than
 * `egress.ts` will ever let reach Hermes. Nothing exported from this module
 * is safe to serialise towards the boundary; `src/mcp/hermesServer.ts` never
 * imports it.
 */
import type { ReferenceStore } from '../store/referenceStore.js';
import { findResiduals, type ResidualFinding } from './egress.js';
import type { SourceLookup, TargetLookup } from './orchestrator.js';
import type {
    ActionRecord,
    ApprovedTransformPolicy,
    JudgementRecord,
    LocalResourceSummary,
    PlannedAttachment,
    RedactionPlaceholder,
    SelectionCandidate,
    SelectionRequest,
    TargetDescriptor
} from './types.js';
import { resourceBindingsOf } from './types.js';

/** What every pending action shows, whatever it would do. Never sent to Hermes. */
export interface LocalActionViewBase {
    actionId: string;
    status: ActionRecord['status'];
    purpose: string;
    createdAt: string;
    expiresAt: string;
    /** `webUrl` links into the source's own interface; local UI only. */
    resource: LocalResourceSummary & { ref: string; safeLabel: string; webUrl?: string };
    judgement: JudgementRecord;
    /** Every resource covered by the approval, in attachment order. */
    resources: Array<
        LocalResourceSummary & {
            ref: string;
            safeLabel: string;
            webUrl?: string;
            judgement: JudgementRecord;
        }
    >;
}

/**
 * One attachment as the approval view names it: what it is called, what kind of
 * file it is, how big. The digest that pins the bytes stays in the plan — it is
 * how the gateway checks itself, not something a person can verify by reading.
 */
export interface LocalPlannedAttachmentView {
    filename: string;
    mimeType: string;
    byteSize: number;
}

/** A transfer of the original document to a configured target. */
export interface LocalSendActionView extends LocalActionViewBase {
    kind: 'send_resource';
    target: {
        id: string;
        label: string;
        recipientDisplay: string;
        purpose: string;
        dynamicRecipient: boolean;
        /**
         * True when this exact address has never been approved for this target
         * before. Only ever meaningful for a dynamic-recipient target — a fixed
         * one has no address the agent could have chosen.
         *
         * Not part of the plan, and deliberately so: it is a fact about the
         * user's history, evaluated when the page is rendered, not a term of
         * what leaves the machine.
         */
        firstTimeRecipient: boolean;
    };
    egress: {
        subject?: string;
        body: string;
        attachments: LocalPlannedAttachmentView[];
        totalBytes: number;
        /** How far the attachments may be shrunk before transport. Absent means not at all. */
        optimization?: ApprovedTransformPolicy;
        /** Which of subject and body the cloud agent wrote rather than the gateway. */
        authoredByAgent: { subject: boolean; body: boolean };
    };
}

/**
 * A redacted summary waiting to be released to the agent.
 *
 * There is no target block here and no attachment list, because there is
 * nothing to attach and nowhere else to send: the whole payload is `text`, and
 * the screen's one job is to let the user read those exact characters.
 */
export interface LocalSummaryActionView extends LocalActionViewBase {
    kind: 'summarize_resource';
    summary: {
        /** Exactly what the agent would receive. */
        text: string;
        chars: number;
        /** Placeholder categories present in the text. */
        redactions: RedactionPlaceholder[];
        /**
         * Things in the text that still look like they should have been
         * removed. Recomputed on every view rather than stored, so sharpening
         * the patterns applies to actions that already exist.
         */
        residuals: ResidualFinding[];
        model: string;
        /** What the agent said it was looking for, if anything. */
        focus?: string;
    };
}

export type LocalActionView = LocalSendActionView | LocalSummaryActionView;

export interface LocalSelectionView {
    selectionId: string;
    query: string;
    purpose: string;
    reasoning: string;
    createdAt: string;
    expiresAt: string;
    /** Set when a prepared action is parked on this selection. */
    originActionId?: string;
    candidates: Array<{
        candidateId: string;
        title: string;
        sourceId: string;
        sourceLabel: string;
        nativeId: string;
        type: string;
        createdAt?: string;
        modifiedAt?: string;
        mimeType?: string;
        attributes?: Record<string, string | string[]>;
        excerpt?: string;
        /** Deep link into the source's own interface, if it offers one. */
        webUrl?: string;
        /**
         * True when this is the resource the parked action already points at.
         * Choosing it confirms the action instead of replacing it.
         */
        isCurrent?: boolean;
    }>;
}

/** What resolving a selection did to the action it was opened from. */
export type SelectionOutcomeForAction =
    | { kind: 'none' }
    | { kind: 'restored'; actionId: string }
    | { kind: 'discarded'; actionId: string };

export class LocalViewBuilder {
    constructor(
        private readonly references: ReferenceStore,
        private readonly sources: SourceLookup,
        private readonly targets: TargetLookup,
        private readonly findAction: (actionId: string) => ActionRecord | undefined,
        private readonly isKnownRecipient: (targetId: string, address: string) => boolean
    ) {}

    toLocalActionView(action: ActionRecord): LocalActionView {
        const bindings = resourceBindingsOf(action);
        const effectiveBindings =
            bindings.length > 0
                ? bindings
                : [
                      {
                          resourceRef: action.resourceRef,
                          resourceStateHash: action.resourceStateHash,
                          judgement: action.judgement
                      }
                  ];
        const resources = effectiveBindings.map((binding) => {
            const record = this.references.resolve(binding.resourceRef);
            const summary: LocalResourceSummary =
                record?.localSummary ??
                ({
                    title: '(Referenz abgelaufen)',
                    sourceId: 'unbekannt',
                    sourceLabel: 'unbekannt',
                    nativeIdDisplay: '-'
                } satisfies LocalResourceSummary);
            return {
                ...summary,
                ref: binding.resourceRef,
                safeLabel: record?.safeLabel ?? '(unbekannt)',
                webUrl: record
                    ? this.webUrlFor(record.locator.sourceId, record.locator.nativeId)
                    : undefined,
                judgement: binding.judgement
            };
        });
        const first = resources[0]!;
        const { judgement, ...resource } = first;

        const base: LocalActionViewBase = {
            actionId: action.actionId,
            status: action.status,
            purpose: action.purpose,
            createdAt: action.createdAt,
            expiresAt: action.expiresAt,
            resource,
            judgement,
            resources
        };

        if (action.plan.kind === 'summarize_resource') {
            const plan = action.plan;
            return {
                ...base,
                kind: 'summarize_resource',
                summary: {
                    text: plan.summary,
                    chars: plan.summary.length,
                    redactions: plan.redactions,
                    residuals: findResiduals(plan.summary),
                    model: plan.model,
                    focus: plan.focus
                }
            };
        }

        const plan = action.plan;
        const descriptor: TargetDescriptor | undefined = this.targets.get(plan.targetId)?.describe();
        return {
            ...base,
            kind: 'send_resource',
            target: {
                id: plan.targetId,
                label: descriptor?.label ?? plan.targetId,
                recipientDisplay: plan.recipientDisplay,
                purpose: descriptor?.purpose ?? '-',
                dynamicRecipient: plan.dynamicRecipient,
                firstTimeRecipient:
                    plan.dynamicRecipient &&
                    plan.recipientAddress !== undefined &&
                    !this.isKnownRecipient(plan.targetId, plan.recipientAddress)
            },
            egress: {
                subject: plan.subject,
                body: plan.body,
                attachments: plan.attachments.map(({ filename, mimeType, byteSize }) => ({
                    filename,
                    mimeType,
                    byteSize
                })),
                // The originals' total. Deliberately not an estimate of what
                // will be sent after optimization: an estimate would be a
                // number nobody can hold the gateway to, and the approval binds
                // the originals and the policy, not the outcome.
                totalBytes: plan.attachments.reduce((sum, item) => sum + item.byteSize, 0),
                // Taken from the stored plan rather than from the target's
                // current config: what matters is the policy this action was
                // frozen with, which is also the one the binding hash covers.
                optimization: plan.optimization,
                // Older records predate the field; absent means the gateway wrote
                // both, which is what those actions in fact carry.
                authoredByAgent: plan.authoredByAgent ?? { subject: false, body: false }
            }
        };
    }

    toLocalSelectionView(request: SelectionRequest): LocalSelectionView {
        // Which candidate the parked action already points at, so the UI can say
        // "this is the current one" instead of making the user match ids by eye.
        const parked = request.originActionId ? this.findAction(request.originActionId) : undefined;
        const current =
            parked?.status === 'selection_required'
                ? this.references.resolve(parked.resourceRef)?.locator
                : undefined;

        return {
            selectionId: request.selectionId,
            query: request.query,
            purpose: request.purpose,
            reasoning: request.reasoning,
            createdAt: request.createdAt,
            expiresAt: request.expiresAt,
            originActionId: parked?.status === 'selection_required' ? parked.actionId : undefined,
            candidates: request.candidates.map((candidate: SelectionCandidate) => ({
                candidateId: candidate.candidateId,
                title: candidate.resource.title,
                sourceId: candidate.resource.locator.sourceId,
                sourceLabel:
                    this.sources.get(candidate.resource.locator.sourceId)?.label ??
                    candidate.resource.locator.sourceId,
                nativeId: candidate.resource.locator.nativeId,
                type: candidate.resource.type,
                createdAt: candidate.resource.createdAt,
                modifiedAt: candidate.resource.modifiedAt,
                mimeType: candidate.resource.mimeType,
                attributes: candidate.resource.attributes,
                excerpt: candidate.resource.excerpt,
                webUrl: this.webUrlFor(
                    candidate.resource.locator.sourceId,
                    candidate.resource.locator.nativeId
                ),
                isCurrent:
                    current !== undefined &&
                    current.sourceId === candidate.resource.locator.sourceId &&
                    current.nativeId === candidate.resource.locator.nativeId
            }))
        };
    }

    /** Deep link into a source's own interface, when that source offers one. */
    private webUrlFor(sourceId: string, nativeId: string): string | undefined {
        const source = this.sources.get(sourceId);
        return source?.webUrl?.(nativeId);
    }
}
