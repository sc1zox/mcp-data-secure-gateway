/**
 * Invariants 4 + 12 — a reference means something, and what it means cannot
 * quietly change underneath an approval.
 *
 * Every path that turns an opaque reference into bytes or metadata goes
 * through here first: that the reference exists, that it was minted for this
 * purpose, that its source is still reachable, and that the resource is still
 * in the state the reference (or a stored binding) pins it to. A caller gets
 * back either the resolved set or a closed error code — never a thrown
 * exception for an ordinary refusal — so the boundary-facing translation to a
 * `PublicActionState` stays entirely the caller's decision.
 */
import type { AuditLog } from '../store/auditLog.js';
import type { ReferenceStore } from '../store/referenceStore.js';
import type { PrivateSource, SourceFile } from '../sources/source.js';
import type { Judge, EgressAssessment, EgressEvidence, SummaryDraft } from '../judge/judge.js';
import { safeEqual } from '../util/hash.js';
import { createLogger, describeError, type Logger } from '../util/log.js';
import { resourceStateHash, isConsistentStoredResourceSet } from './binding.js';
import { isSafeAttachment } from './attachmentSafety.js';
import type { EgressNoteCode } from './egress.js';
import type { SourceLookup } from './orchestrator.js';
import type { ActionRecord, ActionResourceBinding, InternalResource, ResourceRecord } from './types.js';
import { resourceBindingsOf } from './types.js';

export class ResourceSetChangedError extends Error {}

export interface ResolvedResource {
    record: ResourceRecord;
    source: PrivateSource;
    current: InternalResource;
    currentStateHash: string;
}

export type ResourceGateResult =
    | { ok: true; resources: ResolvedResource[] }
    | { ok: false; code: EgressNoteCode; detail: Record<string, unknown> };

/**
 * Result of materialising and assessing the attachments of an already
 * resolved resource set. `local_model_failure` is kept apart from `rejected`
 * because the two answer Hermes through different vocabularies (invariant 10
 * has no note code of its own to reuse for an ordinary refusal).
 */
export type AttachmentPrepResult =
    | { ok: true; files: SourceFile[]; assessments: EgressAssessment[] }
    | { ok: false; kind: 'rejected'; code: EgressNoteCode; detail: Record<string, unknown> }
    | { ok: false; kind: 'local_model_failure'; error: unknown };

export class ResourceGate {
    private readonly log: Logger;

    constructor(
        private readonly references: ReferenceStore,
        private readonly sources: SourceLookup,
        private readonly audit: AuditLog,
        private readonly judge: Judge,
        logger?: Logger
    ) {
        this.log = logger ?? createLogger('orchestrator');
    }

    /**
     * Resolves and freshness-checks a complete resource set as one gate.
     *
     * The phases are intentionally set-wide: first every opaque reference and
     * purpose binding, then every source, then all metadata reads. No original
     * is downloaded until this entire method succeeds, and `allSettled` ensures
     * a changed first member does not prevent the remaining members from being
     * checked as part of the same decision.
     */
    async resolveSet(correlationId: string, references: string[], purpose: string): Promise<ResourceGateResult> {
        const records: ResourceRecord[] = [];
        for (const reference of references) {
            const record = this.references.resolve(reference);
            if (!record) {
                const known = this.references.all().some((entry) => entry.ref === reference);
                return {
                    ok: false,
                    code: known ? 'reference_expired' : 'reference_unknown',
                    detail: { resourceRef: reference }
                };
            }
            records.push(record);
        }

        for (const record of records) {
            if (!this.references.resolveForPurpose(record.ref, purpose)) {
                return {
                    ok: false,
                    code: 'purpose_mismatch',
                    detail: { resourceRef: record.ref, mintedFor: record.purpose, requestedFor: purpose }
                };
            }
        }

        const sourced: Array<{ record: ResourceRecord; source: PrivateSource }> = [];
        for (const record of records) {
            const source = this.sources.get(record.locator.sourceId);
            if (!source || !source.isAvailable()) {
                return {
                    ok: false,
                    code: 'source_unavailable',
                    detail: { sourceId: record.locator.sourceId }
                };
            }
            sourced.push({ record, source });
        }

        const metadata = await Promise.allSettled(
            sourced.map(({ record, source }) => source.fetchMetadata(record.locator.nativeId))
        );
        let unavailable = false;
        for (const [index, result] of metadata.entries()) {
            if (result.status === 'rejected') {
                unavailable = true;
                const entry = sourced[index]!;
                await this.audit.record('source_unavailable', {
                    correlationId,
                    sourceId: entry.source.id,
                    resourceRef: entry.record.ref,
                    detail: { error: describeError(result.reason), phase: 'fetch_metadata_set' }
                });
            }
        }
        if (unavailable) {
            return { ok: false, code: 'source_unavailable', detail: { reason: 'metadata_set_unavailable' } };
        }

        const missing = metadata.findIndex(
            (result) => result.status === 'fulfilled' && result.value === undefined
        );
        if (missing >= 0) {
            return {
                ok: false,
                code: 'reference_unknown',
                detail: { resourceRef: records[missing]!.ref, reason: 'resource_gone' }
            };
        }

        const resources: ResolvedResource[] = metadata.map((result, index) => {
            const current = (result as PromiseFulfilledResult<InternalResource>).value;
            const entry = sourced[index]!;
            return {
                ...entry,
                current,
                currentStateHash: resourceStateHash(current)
            };
        });
        let changed = false;
        for (const resolved of resources) {
            if (!safeEqual(resolved.currentStateHash, resolved.record.stateHash)) {
                changed = true;
                await this.audit.record('action_binding_mismatch', {
                    correlationId,
                    resourceRef: resolved.record.ref,
                    detail: {
                        expected: resolved.record.stateHash,
                        actual: resolved.currentStateHash,
                        phase: 'prepare_set'
                    }
                });
            }
        }
        if (changed) {
            return { ok: false, code: 'resource_changed', detail: { reason: 'resource_set_changed' } };
        }

        return { ok: true, resources };
    }

    /**
     * The checks every action has to pass before anything is built from a
     * reference: that it exists, that it was minted for this purpose, that its
     * source is reachable, and that the resource is still in the state the
     * reference was minted against.
     *
     * Shared between transfers and summaries deliberately. These four are the
     * gateway's promise about what a reference means, and a second copy of them
     * is a second place for one to be forgotten — a summary written from a
     * document that changed after the search would be exactly as wrong as a
     * transfer of it.
     */
    async resolveOne(
        correlationId: string,
        reference: string,
        purpose: string
    ): Promise<{ ok: true; resource: ResolvedResource } | { ok: false; code: EgressNoteCode; detail: Record<string, unknown> }> {
        const resolved = await this.resolveSet(correlationId, [reference], purpose);
        if (!resolved.ok) {
            return resolved;
        }
        return { ok: true, resource: resolved.resources[0]! };
    }

    /**
     * Reads a resolved resource's full text and has the local model redact it,
     * for `summarize_resource`. No text, no summary: summarising the metadata
     * instead would produce something that reads like a summary of the
     * document while never having seen it, which is worse than refusing.
     */
    async draftSummary(
        correlationId: string,
        resolved: ResolvedResource,
        purpose: string,
        focus: string | undefined
    ): Promise<
        | { ok: true; text: string; draft: SummaryDraft }
        | { ok: false; kind: 'rejected'; code: EgressNoteCode; detail: Record<string, unknown> }
        | { ok: false; kind: 'local_model_failure'; error: unknown }
    > {
        const { record, source, current } = resolved;
        let text: string | undefined;
        try {
            text = await source.fetchText?.(record.locator.nativeId);
        } catch (error) {
            await this.audit.record('source_unavailable', {
                correlationId,
                sourceId: source.id,
                resourceRef: record.ref,
                detail: { error: describeError(error), phase: 'fetch_text' }
            });
            return { ok: false, kind: 'rejected', code: 'source_unavailable', detail: { sourceId: source.id } };
        }
        if (!text || text.trim().length === 0) {
            return {
                ok: false,
                kind: 'rejected',
                code: 'summary_no_text',
                detail: { resourceRef: record.ref }
            };
        }
        try {
            const draft = await this.judge.summariseResource(current, text, purpose, focus, correlationId);
            return { ok: true, text, draft };
        } catch (error) {
            return { ok: false, kind: 'local_model_failure', error };
        }
    }

    /**
     * Turns a resolved set into what `prepare_action` needs to build a plan:
     * the original bytes, read sequentially and bounded while they are being
     * read rather than after, and a content-based egress assessment per member.
     * No original is fetched until `resolveSet` has already cleared the whole
     * set, and every member gets its own judgement — one document's assessment
     * must never be displayed as if it covered another.
     *
     * `bounds` is what the gateway is willing to *hold*, which since attachment
     * optimization exists is no longer the same number as what the target will
     * *accept*. For a target that may compress, a 30 MiB scan is a legitimate
     * thing to read and stage even though no mail server would take it; the
     * budget is enforced after the pipeline instead. For a target that may not,
     * the caller passes the target's own limit here and nothing changed.
     */
    async prepareAttachments(
        correlationId: string,
        resources: ResolvedResource[],
        purpose: string,
        target: { label: string; purpose: string },
        bounds: { totalBytes: number; singleBytes?: number }
    ): Promise<AttachmentPrepResult> {
        const files: SourceFile[] = [];
        let totalBytes = 0;
        for (const { record, source } of resources) {
            let file: SourceFile;
            try {
                file = await source.fetchOriginal(record.locator.nativeId);
            } catch (error) {
                await this.audit.record('source_unavailable', {
                    correlationId,
                    sourceId: source.id,
                    resourceRef: record.ref,
                    detail: { error: describeError(error), phase: 'fetch_original_set' }
                });
                return { ok: false, kind: 'rejected', code: 'source_unavailable', detail: { sourceId: source.id } };
            }
            if (!isSafeAttachment(file)) {
                await this.audit.record('invariant_blocked', {
                    correlationId,
                    resourceRef: record.ref,
                    detail: { invariant: 'safe_attachment_set' }
                });
                return {
                    ok: false,
                    kind: 'rejected',
                    code: 'invalid_request',
                    detail: { reason: 'unsafe_attachment_set' }
                };
            }
            if (bounds.singleBytes !== undefined && file.bytes.byteLength > bounds.singleBytes) {
                return {
                    ok: false,
                    kind: 'rejected',
                    code: 'attachment_too_large',
                    detail: { bytes: file.bytes.byteLength, limit: bounds.singleBytes, scope: 'single' }
                };
            }
            totalBytes += file.bytes.byteLength;
            if (totalBytes > bounds.totalBytes) {
                return {
                    ok: false,
                    kind: 'rejected',
                    code: 'attachment_too_large',
                    detail: { bytes: totalBytes, limit: bounds.totalBytes, scope: 'total' }
                };
            }
            files.push(file);
        }

        // Every member receives its own content-based assessment. One judgement
        // about the first document must never be displayed as if it covered all
        // attachments.
        const assessments: EgressAssessment[] = [];
        for (const resolved of resources) {
            const evidence = await this.readEvidence(
                resolved.source,
                resolved.record.locator.nativeId,
                resolved.current,
                correlationId
            );
            try {
                assessments.push(
                    await this.judge.assessEgress(
                        resolved.current,
                        evidence,
                        purpose,
                        target.label,
                        target.purpose,
                        correlationId
                    )
                );
            } catch (error) {
                return { ok: false, kind: 'local_model_failure', error };
            }
        }
        return { ok: true, files, assessments };
    }

    /**
     * Reads as much of a document as the source will give, for the egress
     * assessment to judge. Three outcomes, all legitimate: the extracted text,
     * the short excerpt a search left behind, or nothing at all — a scan
     * without OCR has no text to read, and there is no honest way to conjure
     * one. A missing text does not refuse the request; the model is told the
     * truth about what it was given instead.
     */
    private async readEvidence(
        source: PrivateSource,
        nativeId: string,
        current: InternalResource,
        correlationId: string
    ): Promise<EgressEvidence> {
        try {
            const text = await source.fetchText?.(nativeId);
            if (text && text.trim().length > 0) {
                return { kind: 'fulltext', text };
            }
        } catch (error) {
            await this.audit.record('source_unavailable', {
                correlationId,
                sourceId: source.id,
                detail: { error: describeError(error), phase: 'fetch_text_for_assessment' }
            });
            this.log.warn('Volltext für die Bewertung nicht lesbar; es bleibt der Auszug.', {
                sourceId: source.id,
                error: describeError(error)
            });
        }
        const excerpt = current.excerpt?.trim();
        if (excerpt && excerpt.length > 0) {
            return { kind: 'excerpt', text: current.excerpt };
        }
        return { kind: 'none' };
    }

    /**
     * Re-reads metadata for every approved member immediately before any target
     * is called. All reads settle before one combined verdict is made, so a
     * failure or change can only block the whole set, never produce a partial
     * payload.
     */
    async revalidateForExecution(
        action: ActionRecord
    ): Promise<Array<{ binding: ActionResourceBinding; record: ResourceRecord; source: PrivateSource }>> {
        const bindings = resourceBindingsOf(action);
        if (!isConsistentStoredResourceSet(action, bindings)) {
            throw new ResourceSetChangedError('Die gespeicherte Ressourcenmenge ist inkonsistent.');
        }

        const resolved: Array<{
            binding: ActionResourceBinding;
            record: ResourceRecord;
            source: PrivateSource;
        }> = [];
        for (const binding of bindings) {
            const record = this.references.resolve(binding.resourceRef);
            if (!record || !this.references.resolveForPurpose(binding.resourceRef, action.purpose)) {
                throw new ResourceSetChangedError(
                    'Mindestens eine Referenz ist abgelaufen oder nicht mehr zweckgebunden.'
                );
            }
            const source = this.sources.get(record.locator.sourceId);
            if (!source || !source.isAvailable()) {
                throw new Error('Mindestens eine Quelle ist nicht verfügbar.');
            }
            resolved.push({ binding, record, source });
        }

        const metadata = await Promise.allSettled(
            resolved.map(({ record, source }) => source.fetchMetadata(record.locator.nativeId))
        );
        if (metadata.some((result) => result.status === 'rejected')) {
            throw new Error('Mindestens eine Ressource konnte nicht erneut geprüft werden.');
        }

        let changed = false;
        for (const [index, result] of metadata.entries()) {
            const current = (result as PromiseFulfilledResult<InternalResource | undefined>).value;
            const binding = resolved[index]!.binding;
            if (!current || !safeEqual(resourceStateHash(current), binding.resourceStateHash)) {
                changed = true;
            }
        }
        if (changed) {
            throw new ResourceSetChangedError('Mindestens eine Ressource hat sich seit der Freigabe geändert.');
        }
        return resolved;
    }
}
