import { z } from 'zod';
import type {
    InternalResource,
    JudgementBasis,
    JudgementRecord,
    RedactionPlaceholder
} from '../core/types.js';
import { placeholdersIn, sanitiseLabel, sanitiseSummary } from '../core/egress.js';
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
    SUMMARY_SYSTEM_PROMPT,
    buildEgressUserPrompt,
    buildSelectionUserPrompt,
    buildSummaryUserPrompt
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

const summaryResponseSchema = z.object({
    summary: z.string().min(1).max(8000),
    purposeMatch: z.boolean(),
    confidence: z.number().min(0).max(1),
    sensitivity: z.enum(['low', 'medium', 'high']),
    reasoning: z.string().min(1).max(2000),
    uncertainties: z.array(z.string().max(500)).max(10).default([]),
    residualRisk: z.boolean()
});

const egressResponseSchema = z.object({
    /**
     * Defaulted to the cautious value rather than required.
     *
     * A model that leaves this out has not said the transfer is covered, and
     * silence must not read as approval — but neither should one dropped boolean
     * cost an action whose other attachments were already assessed. Missing
     * becomes "not confirmed", and the omission is named in the uncertainties.
     */
    purposeMatch: z.boolean().default(false),
    confidence: z.number().min(0).max(1),
    sensitivity: z.enum(['low', 'medium', 'high']),
    safeLabel: z.string().optional(),
    reasoning: z.string().min(1).max(2000),
    uncertainties: z.array(z.string().max(500)).max(10).default([]),
    /** Same reasoning as `purposeMatch`, in the direction that asks the user. */
    recommendManualReview: z.boolean().default(true),
    /**
     * The model's claim that it read the document and found it to be the one the
     * title and the purpose describe. Older prompts did not ask for it, so a
     * missing field means "did not check" rather than a schema violation.
     */
    contentChecked: z.boolean().default(false)
});

/**
 * The same three answers as JSON Schema, handed to the runtime as `format` so
 * that a constrained decoder can only produce a complete object.
 *
 * Deliberately written out rather than derived from the schemas above, because
 * the two say different things. This is what the gateway *asks* for: every field
 * required, nothing else allowed. The Zod schemas are what it is willing to
 * *accept*, and they accept an incomplete answer by filling in the cautious
 * value — a runtime that ignores `format`, or a bare `'json'` constraint, still
 * has to land somewhere safe. `test/judge.test.ts` holds the two in step on
 * field names.
 */
const NULLABLE_INTEGER = { anyOf: [{ type: 'integer' }, { type: 'null' }] } as const;
const SENSITIVITY = { type: 'string', enum: ['low', 'medium', 'high'] } as const;
const UNCERTAINTIES = { type: 'array', items: { type: 'string' }, maxItems: 10 } as const;

const SELECTION_RESPONSE_FORMAT = {
    type: 'object',
    properties: {
        decision: { type: 'string', enum: ['select', 'ambiguous', 'none'] },
        candidate: NULLABLE_INTEGER,
        confidence: { type: 'number' },
        safeLabel: { type: 'string' },
        sensitivity: SENSITIVITY,
        reasoning: { type: 'string' },
        uncertainties: UNCERTAINTIES
    },
    required: [
        'decision',
        'candidate',
        'confidence',
        'safeLabel',
        'sensitivity',
        'reasoning',
        'uncertainties'
    ],
    additionalProperties: false
} as const;

const EGRESS_RESPONSE_FORMAT = {
    type: 'object',
    // Ordered as the system prompt lists them, so the field the model commits to
    // first is the one it is asked for first.
    properties: {
        contentChecked: { type: 'boolean' },
        purposeMatch: { type: 'boolean' },
        confidence: { type: 'number' },
        sensitivity: SENSITIVITY,
        safeLabel: { type: 'string' },
        reasoning: { type: 'string' },
        uncertainties: UNCERTAINTIES,
        recommendManualReview: { type: 'boolean' }
    },
    required: [
        'contentChecked',
        'purposeMatch',
        'confidence',
        'sensitivity',
        'safeLabel',
        'reasoning',
        'uncertainties',
        'recommendManualReview'
    ],
    additionalProperties: false
} as const;

const SUMMARY_RESPONSE_FORMAT = {
    type: 'object',
    properties: {
        summary: { type: 'string' },
        purposeMatch: { type: 'boolean' },
        confidence: { type: 'number' },
        sensitivity: SENSITIVITY,
        reasoning: { type: 'string' },
        uncertainties: UNCERTAINTIES,
        residualRisk: { type: 'boolean' }
    },
    required: [
        'summary',
        'purposeMatch',
        'confidence',
        'sensitivity',
        'reasoning',
        'uncertainties',
        'residualRisk'
    ],
    additionalProperties: false
} as const;

/** Paired for the drift check in `test/judge.test.ts`: asked for, accepted. */
export const RESPONSE_CONTRACTS = {
    selection: { request: SELECTION_RESPONSE_FORMAT, accept: selectionResponseSchema },
    egress: { request: EGRESS_RESPONSE_FORMAT, accept: egressResponseSchema },
    summary: { request: SUMMARY_RESPONSE_FORMAT, accept: summaryResponseSchema }
} as const;

/**
 * Fields of the egress answer that carry a cautious default, in the words the
 * approval view uses. A defaulted field is reported as unanswered rather than
 * quietly folded into the verdict.
 */
const EGRESS_DEFAULTED_FIELDS: ReadonlyArray<[keyof typeof egressResponseSchema.shape, string]> = [
    ['purposeMatch', 'ob der Zweck den Versand deckt'],
    ['recommendManualReview', 'ob eine manuelle Prüfung nötig ist']
];

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

/**
 * The document text handed to the egress assessment, and where it came from.
 *
 * Passed explicitly rather than read off the resource, because the difference
 * between "the source gave us the document" and "the source gave us the first
 * paragraph" and "the source gave us nothing" decides what the verdict is worth
 * — and only the caller, which did the reading, knows which of the three it is.
 */
export interface EgressEvidence {
    kind: JudgementBasis['kind'];
    /** The text itself. Absent exactly when `kind` is `none`. */
    text?: string;
}

/** A redacted summary as it came back from the local model, already normalised. */
export interface SummaryDraft {
    /** The exact characters that would be shown and, after approval, handed over. */
    summary: string;
    /** Placeholder categories actually present in the text. */
    redactions: RedactionPlaceholder[];
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

        const raw = await this.invoke(
            SELECTION_SYSTEM_PROMPT,
            buildSelectionUserPrompt(query, purpose, candidates),
            SELECTION_RESPONSE_FORMAT,
            'selection',
            correlationId
        );
        const { value: parsed } = this.parse(selectionResponseSchema, raw, 'selection', correlationId);

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

    /**
     * Assesses a concrete resource-to-target transfer before it is offered for
     * approval.
     *
     * The model is asked to check the document, not to recognise its name. That
     * distinction is the reason `evidence` is a parameter: a title, a
     * correspondent and three tags are enough to write a confident-sounding
     * paragraph about a file nobody opened, and the gateway has no way to tell
     * such a paragraph from a real one after the fact. So the prompt states how
     * much of the document the model is being given, the model reports back
     * whether it actually checked it, and both are recorded — with the report
     * overruled where it contradicts what was handed over.
     */
    async assessEgress(
        resource: InternalResource,
        evidence: EgressEvidence,
        purpose: string,
        targetLabel: string,
        targetPurpose: string,
        correlationId: string
    ): Promise<EgressAssessment> {
        const raw = await this.invoke(
            EGRESS_SYSTEM_PROMPT,
            buildEgressUserPrompt(resource, evidence, purpose, targetLabel, targetPurpose),
            EGRESS_RESPONSE_FORMAT,
            'egress',
            correlationId
        );
        const { value: parsed, provided } = this.parse(
            egressResponseSchema,
            raw,
            'egress',
            correlationId
        );
        // What the model did not answer, in the terms the user reads. The
        // defaults below are the gateway's caution, not the model's verdict, and
        // the difference belongs in the approval view.
        const defaulted = EGRESS_DEFAULTED_FIELDS.filter(([field]) => !provided.has(field));

        const uncertainties = [...parsed.uncertainties];
        // Without text there is nothing the model could have checked, so its own
        // account of having checked is discarded rather than believed, and the
        // two conclusions that would have to rest on the content are withdrawn.
        const blind = evidence.kind === 'none';
        const contentChecked = !blind && parsed.contentChecked;
        const purposeMatch = !blind && parsed.purposeMatch;
        const recommendManualReview = blind || !contentChecked || parsed.recommendManualReview;

        if (blind && parsed.contentChecked) {
            await this.audit.record('judge_output_rejected', {
                correlationId,
                detail: { task: 'egress', reason: 'content_check_without_content' }
            });
            this.log.warn(
                'Modell gibt eine Inhaltsprüfung an, obwohl kein Dokumenttext vorlag. Angabe verworfen.',
                { nativeId: resource.locator.nativeId }
            );
        }
        if (blind) {
            uncertainties.unshift(
                'Zu diesem Dokument lag kein auswertbarer Text vor. Das lokale Modell hat nur Titel und ' +
                    'Merkmale gesehen, nicht den Inhalt der Datei, die versandt würde.'
            );
        } else if (!contentChecked) {
            uncertainties.unshift(
                'Das lokale Modell hat nicht bestätigt, dass der Dokumentinhalt zu Titel und Zweck passt.'
            );
        }
        if (!purposeMatch && !blind) {
            uncertainties.unshift('Das lokale Modell hält den Versand für nicht durch den Zweck gedeckt.');
        }
        if (recommendManualReview) {
            uncertainties.unshift('Das lokale Modell empfiehlt eine genaue manuelle Prüfung.');
        }
        // Unshifted last so it stands first: it explains why the lines below it
        // sound like a verdict the model never actually gave.
        if (defaulted.length > 0) {
            uncertainties.unshift(
                'Die Antwort des lokalen Modells war unvollständig. Es hat nicht beantwortet, ' +
                    `${defaulted.map(([, label]) => label).join(' und ')}. Diese Punkte gelten ` +
                    'deshalb als offen, nicht als geklärt.'
            );
        }

        const basis: JudgementBasis = {
            kind: evidence.kind,
            textChars: evidence.text?.length ?? 0,
            contentChecked
        };
        const judgement: JudgementRecord = {
            model: this.client.model,
            confidence: parsed.confidence,
            reasoning: parsed.reasoning,
            sensitivity: parsed.sensitivity,
            uncertainties,
            basis,
            createdAt: new Date().toISOString()
        };

        await this.audit.record('judge_invoked', {
            correlationId,
            sourceId: resource.locator.sourceId,
            detail: {
                task: 'egress',
                model: this.client.model,
                nativeId: resource.locator.nativeId,
                basis,
                claimedContentChecked: parsed.contentChecked,
                claimedPurposeMatch: parsed.purposeMatch,
                defaultedFields: defaulted.map(([field]) => field),
                purposeMatch,
                confidence: parsed.confidence,
                sensitivity: parsed.sensitivity,
                recommendManualReview,
                reasoning: parsed.reasoning,
                uncertainties
            }
        });

        return {
            purposeMatch,
            recommendManualReview,
            safeLabel: parsed.safeLabel ? sanitiseLabel(parsed.safeLabel) : undefined,
            judgement
        };
    }

    /**
     * Writes a redacted summary of a document.
     *
     * This is the only task whose output is meant to leave the machine as prose,
     * so the model's answer is treated as a draft rather than as a result: the
     * text is normalised into the exact characters that will be displayed, the
     * placeholders it claims are re-derived from the text itself rather than
     * taken on trust, and everything the model says about its own work is filed
     * under "uncertainties" for the user to read. The gateway never concludes
     * from a confident answer here that the summary is safe — only the person
     * reading it does that.
     */
    async summariseResource(
        resource: InternalResource,
        text: string,
        purpose: string,
        focus: string | undefined,
        correlationId: string
    ): Promise<SummaryDraft> {
        const raw = await this.invoke(
            SUMMARY_SYSTEM_PROMPT,
            buildSummaryUserPrompt(resource, text, purpose, focus),
            SUMMARY_RESPONSE_FORMAT,
            'summary',
            correlationId
        );
        const { value: parsed } = this.parse(summaryResponseSchema, raw, 'summary', correlationId);

        const summary = sanitiseSummary(parsed.summary);
        // Derived from the finished text, not from a field the model filled in:
        // what it says it redacted and what the text actually contains are two
        // different claims, and only the second one is checkable.
        const redactions = placeholdersIn(summary);
        const uncertainties = [...parsed.uncertainties];
        if (parsed.residualRisk) {
            uncertainties.unshift(
                'Das lokale Modell hält es für möglich, dass der Text noch schützenswerte Angaben enthält.'
            );
        }
        if (!parsed.purposeMatch) {
            uncertainties.unshift(
                'Das lokale Modell sieht den angegebenen Zweck durch den Dokumentinhalt nicht gedeckt.'
            );
        }

        const judgement: JudgementRecord = {
            model: this.client.model,
            confidence: parsed.confidence,
            reasoning: parsed.reasoning,
            sensitivity: parsed.sensitivity,
            uncertainties,
            // A summary is only ever written from the document's text — the
            // orchestrator refuses the call outright when there is none — so the
            // basis here is a fact about the path, not a report from the model.
            basis: { kind: 'fulltext', textChars: text.length, contentChecked: true },
            createdAt: new Date().toISOString()
        };

        await this.audit.record('judge_invoked', {
            correlationId,
            sourceId: resource.locator.sourceId,
            detail: {
                task: 'summary',
                model: this.client.model,
                nativeId: resource.locator.nativeId,
                inputChars: text.length,
                // The text itself is not duplicated here: it is stored with the
                // action, and the audit trail should not become a second place
                // that holds it.
                summaryChars: summary.length,
                redactions,
                purposeMatch: parsed.purposeMatch,
                residualRisk: parsed.residualRisk,
                confidence: parsed.confidence,
                sensitivity: parsed.sensitivity,
                reasoning: parsed.reasoning,
                uncertainties
            }
        });

        return { summary, redactions, judgement };
    }

    private async invoke(
        system: string,
        user: string,
        format: unknown,
        task: string,
        correlationId: string
    ): Promise<string> {
        try {
            return await this.client.chatJson(system, user, format);
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
     *
     * The keys the model actually sent come back alongside the parsed value,
     * because a schema default is indistinguishable from an answer once it has
     * been applied — and the caller has to tell the user which of the two it is.
     */
    private parse<T extends z.ZodTypeAny>(
        schema: T,
        raw: string,
        task: string,
        correlationId: string
    ): { value: z.infer<T>; provided: Set<string> } {
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
        const provided =
            payload && typeof payload === 'object' && !Array.isArray(payload)
                ? new Set(Object.keys(payload))
                : new Set<string>();
        return { value: result.data, provided };
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
