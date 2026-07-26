import { z } from 'zod';
import type { InternalResource, JudgementRecord } from '../core/types.js';
import { sanitiseLabel } from '../core/egress.js';
import { createLogger, describeError, type Logger } from '../util/log.js';
import type { AuditLog } from '../store/auditLog.js';
import {
    LocalModelResponseError,
    LocalModelUnavailableError,
    OllamaClient
} from './ollamaClient.js';
import {
    EGRESS_SYSTEM_PROMPT,
    SELECTION_SYSTEM_PROMPT,
    buildEgressUserPrompt,
    buildSelectionUserPrompt,
    createFence
} from './prompts.js';

/**
 * Semantic decisions the gateway delegates to the local model, wrapped in strict
 * validation.
 *
 * The model is treated as an untrusted advisor: helpful about meaning, not
 * authoritative about anything. Its output is parsed against a schema, its
 * candidate index is bounds-checked, its label is scrubbed, and it has no route
 * to a target (invariant 8). Everything it says lands in the approval view for a
 * human to weigh.
 */

const selectionResponseSchema = z.object({
    decision: z.enum(['select', 'ambiguous', 'none']),
    candidate: z.number().int().nullable().optional(),
    confidence: z.number().min(0).max(1),
    safeLabel: z.string().optional(),
    sensitivity: z.enum(['low', 'medium', 'high']),
    reasoning: z.string().min(1).max(2000),
    uncertainties: z.array(z.string().max(500)).max(10).default([])
});

const egressResponseSchema = z.object({
    purposeMatch: z.boolean(),
    confidence: z.number().min(0).max(1),
    sensitivity: z.enum(['low', 'medium', 'high']),
    safeLabel: z.string().optional(),
    reasoning: z.string().min(1).max(2000),
    uncertainties: z.array(z.string().max(500)).max(10).default([]),
    recommendManualReview: z.boolean()
});

export type SelectionOutcome =
    | {
          kind: 'selected';
          resource: InternalResource;
          safeLabel: string;
          judgement: JudgementRecord;
      }
    | { kind: 'ambiguous'; judgement: JudgementRecord }
    | { kind: 'none'; judgement: JudgementRecord };

export interface EgressAssessment {
    purposeMatch: boolean;
    recommendManualReview: boolean;
    safeLabel?: string;
    judgement: JudgementRecord;
}

export class Judge {
    private readonly log: Logger;

    constructor(
        private readonly client: OllamaClient,
        private readonly audit: AuditLog,
        logger?: Logger
    ) {
        this.log = logger ?? createLogger('judge');
    }

    /** Checks the endpoint at startup so a misconfiguration surfaces immediately. */
    async probe(): Promise<void> {
        const result = await this.client.probe();
        if (!result.reachable) {
            this.log.error('Lokales Modell nicht erreichbar. Aktionen werden abgelehnt.', {
                detail: result.detail
            });
            return;
        }
        if (!result.modelPresent) {
            this.log.warn('Konfiguriertes Modell wurde am Endpunkt nicht gefunden.', {
                model: this.client.model,
                detail: result.detail
            });
            return;
        }
        this.log.info('Lokales Modell verfügbar', { model: this.client.model });
    }

    /**
     * Picks one resource out of the candidates, or reports that a human must
     * choose. An out-of-range or missing candidate index downgrades the answer to
     * ambiguous rather than guessing (invariant 9).
     */
    async selectResource(
        query: string,
        purpose: string,
        candidates: InternalResource[],
        correlationId: string
    ): Promise<SelectionOutcome> {
        if (candidates.length === 0) {
            return {
                kind: 'none',
                judgement: this.syntheticJudgement(
                    'Die private Quelle lieferte keine Kandidaten zu dieser Beschreibung.',
                    'low',
                    0
                )
            };
        }

        const fence = createFence();
        const raw = await this.invoke(
            SELECTION_SYSTEM_PROMPT(fence.nonce),
            buildSelectionUserPrompt(fence, query, purpose, candidates),
            'selection',
            correlationId
        );
        const parsed = this.parse(selectionResponseSchema, raw, 'selection', correlationId);

        const judgement: JudgementRecord = {
            model: this.client.model,
            confidence: parsed.confidence,
            reasoning: parsed.reasoning,
            sensitivity: parsed.sensitivity,
            uncertainties: parsed.uncertainties,
            createdAt: new Date().toISOString()
        };

        await this.audit.record('judge_invoked', {
            correlationId,
            detail: {
                task: 'selection',
                model: this.client.model,
                candidateCount: candidates.length,
                decision: parsed.decision,
                candidate: parsed.candidate ?? null,
                confidence: parsed.confidence,
                sensitivity: parsed.sensitivity,
                reasoning: parsed.reasoning,
                uncertainties: parsed.uncertainties
            }
        });

        if (parsed.decision !== 'select') {
            return parsed.decision === 'ambiguous' ? { kind: 'ambiguous', judgement } : { kind: 'none', judgement };
        }

        const index = (parsed.candidate ?? 0) - 1;
        const resource = candidates[index];
        if (!resource) {
            this.log.warn('Modell nannte einen unbekannten Kandidaten. Ergebnis gilt als nicht eindeutig.', {
                candidate: parsed.candidate,
                candidateCount: candidates.length
            });
            await this.audit.record('judge_output_rejected', {
                correlationId,
                detail: {
                    task: 'selection',
                    reason: 'candidate_out_of_range',
                    candidate: parsed.candidate ?? null,
                    candidateCount: candidates.length
                }
            });
            return { kind: 'ambiguous', judgement };
        }

        return {
            kind: 'selected',
            resource,
            safeLabel: this.deriveSafeLabel(parsed.safeLabel, resource),
            judgement
        };
    }

    /** Assesses a concrete resource-to-target transfer before it is offered for approval. */
    async assessEgress(
        resource: InternalResource,
        purpose: string,
        targetLabel: string,
        targetPurpose: string,
        correlationId: string
    ): Promise<EgressAssessment> {
        const fence = createFence();
        const raw = await this.invoke(
            EGRESS_SYSTEM_PROMPT(fence.nonce),
            buildEgressUserPrompt(fence, resource, purpose, targetLabel, targetPurpose),
            'egress',
            correlationId
        );
        const parsed = this.parse(egressResponseSchema, raw, 'egress', correlationId);

        const uncertainties = [...parsed.uncertainties];
        if (!parsed.purposeMatch) {
            uncertainties.unshift('Das lokale Modell hält den Versand für nicht durch den Zweck gedeckt.');
        }
        if (parsed.recommendManualReview) {
            uncertainties.unshift('Das lokale Modell empfiehlt eine genaue manuelle Prüfung.');
        }

        const judgement: JudgementRecord = {
            model: this.client.model,
            confidence: parsed.confidence,
            reasoning: parsed.reasoning,
            sensitivity: parsed.sensitivity,
            uncertainties,
            createdAt: new Date().toISOString()
        };

        await this.audit.record('judge_invoked', {
            correlationId,
            sourceId: resource.locator.sourceId,
            detail: {
                task: 'egress',
                model: this.client.model,
                nativeId: resource.locator.nativeId,
                purposeMatch: parsed.purposeMatch,
                confidence: parsed.confidence,
                sensitivity: parsed.sensitivity,
                recommendManualReview: parsed.recommendManualReview,
                reasoning: parsed.reasoning,
                uncertainties
            }
        });

        return {
            purposeMatch: parsed.purposeMatch,
            recommendManualReview: parsed.recommendManualReview,
            safeLabel: parsed.safeLabel ? sanitiseLabel(parsed.safeLabel) : undefined,
            judgement
        };
    }

    private async invoke(
        system: string,
        user: string,
        task: string,
        correlationId: string
    ): Promise<string> {
        try {
            return await this.client.chatJson(system, user);
        } catch (error) {
            if (error instanceof LocalModelUnavailableError) {
                await this.audit.record('judge_unavailable', {
                    correlationId,
                    detail: { task, model: this.client.model, error: describeError(error) }
                });
            }
            throw error;
        }
    }

    /**
     * Parses and validates a model response. A schema violation is not repaired
     * or retried with a nudge: an answer we cannot read is an answer we cannot
     * rely on, and the caller turns it into "no automatic action".
     */
    private parse<T extends z.ZodTypeAny>(
        schema: T,
        raw: string,
        task: string,
        correlationId: string
    ): z.infer<T> {
        let payload: unknown;
        try {
            payload = JSON.parse(extractJsonObject(raw));
        } catch (error) {
            void this.audit.record('judge_output_rejected', {
                correlationId,
                detail: { task, reason: 'not_json', error: describeError(error) }
            });
            throw new LocalModelResponseError(
                `Antwort des lokalen Modells (${task}) war kein gültiges JSON-Objekt.`
            );
        }
        const result = schema.safeParse(payload);
        if (!result.success) {
            const issues = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
            void this.audit.record('judge_output_rejected', {
                correlationId,
                detail: { task, reason: 'schema_violation', issues }
            });
            throw new LocalModelResponseError(
                `Antwort des lokalen Modells (${task}) verletzt das Schema: ${issues.join('; ')}`
            );
        }
        return result.data;
    }

    /**
     * The label is the one piece of model-authored text that crosses the trust
     * boundary, so it is scrubbed and length-capped. If the model omitted it, the
     * resource title is used — also scrubbed, never the raw path or id.
     */
    private deriveSafeLabel(proposed: string | undefined, resource: InternalResource): string {
        const candidate = proposed && proposed.trim().length > 0 ? proposed : resource.title;
        const label = sanitiseLabel(candidate);
        return label.length > 0 ? label : 'Ressource';
    }

    private syntheticJudgement(
        reasoning: string,
        sensitivity: 'low' | 'medium' | 'high',
        confidence: number
    ): JudgementRecord {
        return {
            model: this.client.model,
            confidence,
            reasoning,
            sensitivity,
            uncertainties: [],
            createdAt: new Date().toISOString()
        };
    }
}

/**
 * Isolates the outermost JSON object in a response. Even with `format: 'json'`
 * some runtimes prepend a stray token, and brace counting is more reliable here
 * than a regex.
 */
export function extractJsonObject(raw: string): string {
    const start = raw.indexOf('{');
    if (start === -1) {
        return raw.trim();
    }
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < raw.length; index += 1) {
        const char = raw[index];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (char === '\\') {
            escaped = true;
            continue;
        }
        if (char === '"') {
            inString = !inString;
            continue;
        }
        if (inString) {
            continue;
        }
        if (char === '{') {
            depth += 1;
        } else if (char === '}') {
            depth -= 1;
            if (depth === 0) {
                return raw.slice(start, index + 1);
            }
        }
    }
    return raw.slice(start).trim();
}
