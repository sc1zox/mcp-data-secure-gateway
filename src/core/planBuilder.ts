/**
 * What exactly leaves the machine if an action is approved, and who wrote it.
 *
 * These are pure functions: given the same inputs they produce the same plan,
 * with no side effect and no access to a store or a source. That is what lets
 * `binding.ts` hash the result deterministically and what lets this module be
 * tested without a harness.
 */
import type {
    PlannedAttachment,
    RedactionPlaceholder,
    SendResourcePlan,
    SummariseResourcePlan,
    TargetDescriptor
} from './types.js';

export function buildSubject(safeLabel: string): string {
    return `Local Trust Gateway: ${safeLabel}`;
}

/**
 * Message body, composed locally from the purpose and the label. A note from
 * Hermes is included but explicitly attributed, so the user reading the approval
 * view can tell which words came from the cloud agent.
 */
export function buildBody(input: { safeLabel: string; purpose: string; hermesNote?: string }): string {
    const lines = [
        `Ressource: ${input.safeLabel}`,
        `Zweck: ${input.purpose}`,
        `Vorbereitet: ${new Date().toISOString()}`,
        '',
        'Diese Nachricht wurde nach lokaler Freigabe durch das Local Trust Gateway versandt.'
    ];
    if (input.hermesNote) {
        lines.push('', 'Hinweis des Agenten (nicht lokal verifiziert):', input.hermesNote);
    }
    return lines.join('\n');
}

export function describeResourceSet(safeLabels: string[]): string {
    if (safeLabels.length === 1) {
        return safeLabels[0]!;
    }
    return `${safeLabels[0]!} und ${safeLabels.length - 1} weitere${
        safeLabels.length === 2 ? ' Ressource' : ' Ressourcen'
    }`;
}

/**
 * Assembles the frozen send plan. `recipientInput` is only consulted when the
 * target is dynamic-recipient; a fixed target always uses its own configured
 * `recipientDisplay`, never a caller-supplied value.
 */
export function buildSendPlan(input: {
    descriptor: TargetDescriptor;
    recipientInput?: string;
    agentSubject?: string;
    agentBody?: string;
    hermesNote?: string;
    purpose: string;
    safeLabels: string[];
    attachments: PlannedAttachment[];
}): SendResourcePlan {
    const { descriptor, recipientInput, agentSubject, agentBody, hermesNote, purpose, safeLabels, attachments } =
        input;
    return {
        kind: 'send_resource',
        targetId: descriptor.id,
        // Dynamic case: show the exact address that will be used, unmasked,
        // because approving it *is* approving that address.
        recipientDisplay: descriptor.dynamicRecipient ? recipientInput! : descriptor.recipientDisplay,
        dynamicRecipient: descriptor.dynamicRecipient,
        recipientAddress: descriptor.dynamicRecipient ? recipientInput : undefined,
        subject: agentSubject ?? buildSubject(describeResourceSet(safeLabels)),
        body:
            agentBody ??
            buildBody({
                safeLabel: describeResourceSet(safeLabels),
                purpose,
                hermesNote
            }),
        attachments,
        authoredByAgent: { subject: agentSubject !== undefined, body: agentBody !== undefined }
    };
}

/** Assembles the frozen summary plan from what the local model produced. */
export function buildSummaryPlan(input: {
    summary: string;
    summarySha256: string;
    redactions: RedactionPlaceholder[];
    model: string;
    focus?: string;
}): SummariseResourcePlan {
    return {
        kind: 'summarize_resource',
        summary: input.summary,
        summarySha256: input.summarySha256,
        redactions: input.redactions,
        model: input.model,
        focus: input.focus
    };
}
