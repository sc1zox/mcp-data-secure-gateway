import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig, type GatewayConfig } from '../src/config.js';
import { EgressGuard } from '../src/core/egress.js';
import { Orchestrator, type SourceLookup, type TargetLookup } from '../src/core/orchestrator.js';
import type { InternalResource, JudgementRecord, TargetDescriptor } from '../src/core/types.js';
import type {
    Judge,
    EgressAssessment,
    EgressEvidence,
    SelectionOutcome,
    SummaryDraft
} from '../src/judge/judge.js';
import { placeholdersIn, sanitiseSummary } from '../src/core/egress.js';
import { AuditLog } from '../src/store/auditLog.js';
import { ActionStore } from '../src/store/actionStore.js';
import { ReferenceStore } from '../src/store/referenceStore.js';
import { SelectionStore } from '../src/store/selectionStore.js';
import type { PrivateSource, SourceFile } from '../src/sources/source.js';
import type {
    DeliveryReceipt,
    EgressPayload,
    EgressTarget,
    TargetAvailability
} from '../src/targets/target.js';
import { setLogLevel } from '../src/util/log.js';

// Keep test output readable; the gateway logs to stderr at info by default.
setLogLevel('error');

export const TEST_SECRET_TOKEN = 'paperless-token-abc123456';

export function makeResource(overrides: Partial<InternalResource> = {}): InternalResource {
    return {
        locator: { sourceId: 'fake', nativeId: '4711', ...(overrides.locator ?? {}) },
        title: 'Lebenslauf 2026',
        type: 'document',
        createdAt: '2026-01-04T10:00:00.000Z',
        modifiedAt: '2026-02-01T08:30:00.000Z',
        mimeType: 'application/pdf',
        byteSize: 12,
        attributes: { Korrespondent: 'Eigene Unterlagen' },
        excerpt: 'Berufserfahrung, Ausbildung, Kenntnisse.',
        stateToken: 'modified:2026-02-01T08:30:00.000Z',
        ...overrides
    };
}

/** In-memory source. Records what was asked of it so tests can assert on access. */
export class FakeSource implements PrivateSource {
    readonly id = 'fake';
    readonly label = 'Testquelle';
    available = true;
    searchCalls: string[] = [];
    originalFetches: string[] = [];
    textFetches: string[] = [];
    bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    failSearch = false;
    /** Set to undefined to model a resource with no extractable text. */
    text: string | undefined = 'Lebenslauf von Max Mustermann, Musterstraße 1, geboren 1985.';

    constructor(public resources: InternalResource[] = [makeResource()]) {}

    async connect(): Promise<void> {}
    async close(): Promise<void> {}
    isAvailable(): boolean {
        return this.available;
    }

    async search(query: string): Promise<InternalResource[]> {
        this.searchCalls.push(query);
        if (this.failSearch) {
            throw new Error('Quelle antwortet nicht');
        }
        return this.resources;
    }

    async fetchMetadata(nativeId: string): Promise<InternalResource | undefined> {
        return this.resources.find((resource) => resource.locator.nativeId === nativeId);
    }

    async fetchOriginal(nativeId: string): Promise<SourceFile> {
        this.originalFetches.push(nativeId);
        return { filename: 'lebenslauf.pdf', mimeType: 'application/pdf', bytes: this.bytes };
    }

    async fetchText(nativeId: string): Promise<string | undefined> {
        this.textFetches.push(nativeId);
        return this.text;
    }
}

/** In-memory target. Captures exactly what would have left the machine. */
export class FakeTarget implements EgressTarget {
    delivered: EgressPayload[] = [];
    failDelivery = false;

    constructor(
        readonly id = 'private_mail',
        private readonly descriptor: Partial<TargetDescriptor> = {}
    ) {}

    describe(): TargetDescriptor {
        return {
            id: this.id,
            label: 'Private E-Mail',
            purpose: 'Versand an das eigene Postfach.',
            recipientDisplay: 'i**@example.org',
            dynamicRecipient: false,
            supportsAttachments: true,
            maxAttachmentBytes: 1024 * 1024,
            ...this.descriptor
        };
    }

    async checkAvailability(): Promise<TargetAvailability> {
        return { available: true };
    }

    async deliver(payload: EgressPayload): Promise<DeliveryReceipt> {
        if (this.failDelivery) {
            throw new Error('SMTP nicht erreichbar');
        }
        this.delivered.push({
            subject: payload.subject,
            body: payload.body,
            attachments: payload.attachments.map((attachment) => ({ ...attachment })),
            recipient: payload.recipient
        });
        return { reference: `msg-${this.delivered.length}` };
    }
}

export type JudgeBehaviour =
    | { kind: 'select'; index?: number; safeLabel?: string; sensitivity?: 'low' | 'medium' | 'high' }
    | { kind: 'ambiguous' }
    | { kind: 'none' }
    | { kind: 'throw'; error: Error };

/**
 * Stands in for the local model. Casting to `Judge` keeps the orchestrator's real
 * signature; only the two methods it calls are needed.
 */
export function makeFakeJudge(
    behaviour: JudgeBehaviour,
    egressOverrides: Partial<EgressAssessment> = {},
    summaryText = 'Es handelt sich um einen Lebenslauf von [REDACTED_NAME] mit Stationen bei [REDACTED_ORG].',
    /** Fails only the summarising call, so search and reference minting still work. */
    summaryError?: Error,
    /** Receives what the orchestrator handed the judge to read, in call order. */
    evidenceSink: EgressEvidence[] = []
): Judge {
    const judgement = (sensitivity: 'low' | 'medium' | 'high' = 'low'): JudgementRecord => ({
        model: 'test-model',
        confidence: 0.9,
        reasoning: 'Testbegründung.',
        sensitivity,
        uncertainties: [],
        createdAt: new Date().toISOString()
    });

    return {
        async probe(): Promise<void> {},
        async selectResource(
            _query: string,
            _purpose: string,
            candidates: InternalResource[]
        ): Promise<SelectionOutcome> {
            if (behaviour.kind === 'throw') {
                throw behaviour.error;
            }
            if (behaviour.kind === 'ambiguous') {
                return { kind: 'ambiguous', judgement: judgement() };
            }
            if (behaviour.kind === 'none') {
                return { kind: 'none', judgement: judgement() };
            }
            const resource = candidates[behaviour.index ?? 0];
            if (!resource) {
                return { kind: 'ambiguous', judgement: judgement() };
            }
            return {
                kind: 'selected',
                resource,
                safeLabel: behaviour.safeLabel ?? 'Aktueller Lebenslauf',
                judgement: judgement(behaviour.sensitivity)
            };
        },
        async assessEgress(
            _resource: InternalResource,
            evidence: EgressEvidence
        ): Promise<EgressAssessment> {
            evidenceSink.push(evidence);
            if (behaviour.kind === 'throw') {
                throw behaviour.error;
            }
            return {
                purposeMatch: true,
                recommendManualReview: false,
                safeLabel: 'Aktueller Lebenslauf',
                judgement: judgement(),
                ...egressOverrides
            };
        },
        // Mirrors the real judge: the text is normalised and the placeholders are
        // derived from it rather than declared, so a test that hands back a bad
        // summary gets it treated exactly as a bad model answer would be.
        async summariseResource(): Promise<SummaryDraft> {
            if (summaryError) {
                throw summaryError;
            }
            if (behaviour.kind === 'throw') {
                throw behaviour.error;
            }
            const summary = sanitiseSummary(summaryText);
            return { summary, redactions: placeholdersIn(summary), judgement: judgement() };
        }
    } as unknown as Judge;
}

export function makeConfig(overrides: Record<string, unknown> = {}): GatewayConfig {
    return parseConfig({
        dataDir: './data',
        logLevel: 'error',
        sources: [
            {
                id: 'paperless',
                kind: 'paperless-mcp',
                transport: {
                    kind: 'stdio',
                    command: 'node',
                    args: ['noop.js'],
                    env: { PAPERLESS_API_TOKEN: TEST_SECRET_TOKEN }
                },
                maxCandidates: 8
            }
        ],
        localModel: { baseUrl: 'http://127.0.0.1:11434', model: 'qwen3.5:9b' },
        targets: [
            {
                id: 'private_mail',
                kind: 'smtp',
                smtp: { host: 'smtp.example.org', user: 'user', password: 'sehr-geheimes-passwort' },
                from: 'gateway@example.org',
                to: 'ich@example.org'
            }
        ],
        approval: { actionTtlSeconds: 1800, referenceTtlSeconds: 3600, selectionTtlSeconds: 1800 },
        ...overrides
    });
}

export interface Harness {
    orchestrator: Orchestrator;
    source: FakeSource;
    target: FakeTarget;
    audit: AuditLog;
    references: ReferenceStore;
    actions: ActionStore;
    selections: SelectionStore;
    guard: EgressGuard;
    /** What the orchestrator gave the judge to read, per `assessEgress` call. */
    egressEvidence: EgressEvidence[];
    dataDir: string;
    cleanup(): Promise<void>;
}

export async function makeHarness(options: {
    judge?: JudgeBehaviour;
    resources?: InternalResource[];
    config?: Record<string, unknown>;
    egressOverrides?: Partial<EgressAssessment>;
    targetDescriptor?: Partial<TargetDescriptor>;
    /** What the stand-in local model returns from `summariseResource`. */
    summaryText?: string;
    /** Makes only the summarising call fail; search and judgement still work. */
    summaryError?: Error;
} = {}): Promise<Harness> {
    const dataDir = await mkdtemp(join(tmpdir(), 'ltg-test-'));
    const config = makeConfig({ ...(options.config ?? {}), dataDir });

    const audit = new AuditLog(join(dataDir, 'audit.jsonl'));
    await audit.init();
    const references = new ReferenceStore(dataDir, audit);
    const actions = new ActionStore(dataDir, audit);
    const selections = new SelectionStore(dataDir, audit);
    await references.load();
    await actions.load();
    await selections.load();

    const source = new FakeSource(options.resources ?? [makeResource()]);
    const target = new FakeTarget('private_mail', options.targetDescriptor ?? {});
    const sources: SourceLookup = {
        get: (id) => (id === source.id ? source : undefined),
        all: () => [source],
        available: () => (source.isAvailable() ? [source] : [])
    };
    const targets: TargetLookup = {
        get: (id) => (id === target.id ? target : undefined),
        describeAll: () => [target.describe()]
    };

    const guard = new EgressGuard();
    guard.registerSecret(TEST_SECRET_TOKEN);
    guard.registerSecret('sehr-geheimes-passwort');
    guard.registerSecret('ich@example.org');

    const egressEvidence: EgressEvidence[] = [];
    const orchestrator = new Orchestrator(
        config,
        sources,
        targets,
        makeFakeJudge(
            options.judge ?? { kind: 'select' },
            options.egressOverrides,
            options.summaryText,
            options.summaryError,
            egressEvidence
        ),
        references,
        actions,
        selections,
        audit,
        guard
    );

    return {
        orchestrator,
        source,
        target,
        audit,
        references,
        actions,
        selections,
        guard,
        egressEvidence,
        dataDir,
        cleanup: async () => {
            await rm(dataDir, { recursive: true, force: true });
        }
    };
}

/**
 * Delivery runs detached after approval and touches the filesystem, so ticking the
 * microtask queue is not enough — this polls the action's status until it settles.
 */
export async function waitForAction(
    orchestrator: Orchestrator,
    actionId: string,
    expected: string[],
    timeoutMs = 5000
): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let last = orchestrator.getActionStatus(actionId).status as string;
    while (Date.now() < deadline) {
        last = orchestrator.getActionStatus(actionId).status as string;
        if (expected.includes(last)) {
            return last;
        }
        await new Promise((resolveTick) => setTimeout(resolveTick, 10));
    }
    throw new Error(
        `Aktion ${actionId} erreichte keinen der Status ${expected.join('/')} (letzter: ${last}).`
    );
}

/** Waits until an action is in any terminal state. */
export async function waitForTerminal(
    orchestrator: Orchestrator,
    actionId: string,
    timeoutMs = 5000
): Promise<string> {
    return waitForAction(orchestrator, actionId, ['completed', 'failed', 'rejected', 'expired'], timeoutMs);
}
