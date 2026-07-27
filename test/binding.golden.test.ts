import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { computeBindingHash, resourceStateHash } from '../src/core/orchestrator.js';
import type { SendResourcePlan, SummariseResourcePlan } from '../src/core/types.js';
import { makeResource } from './helpers.js';

/**
 * Golden vectors for the binding hash, taken against `14728fe` before any of
 * `orchestrator.ts` moves. If moving `computeBindingHash` / `resourceStateHash`
 * into `core/binding.ts` changes any of these digests, a byte in the hashed
 * shape changed along the way — the exact failure this suite exists to catch,
 * because every action stored with the old digest would then be rejected as
 * inconsistent at `approveAction` (see plan section 3, B0).
 */
describe('Bindungs-Hash: Golden-Vektoren (vor Zerlegung eingefroren)', () => {
    const sendPlan: SendResourcePlan = {
        kind: 'send_resource',
        targetId: 'private_mail',
        recipientDisplay: 'i**@example.org',
        dynamicRecipient: false,
        subject: 'Bewerbung',
        body: 'Guten Tag,\n\nanbei meine Unterlagen.',
        attachments: [
            { filename: 'lebenslauf.pdf', mimeType: 'application/pdf', byteSize: 12345, sha256: 'ab'.repeat(32) }
        ],
        authoredByAgent: { subject: true, body: true }
    };

    const summaryPlan: SummariseResourcePlan = {
        kind: 'summarize_resource',
        summary: 'Ein Schreiben von [REDACTED_ORG] zu einer laufenden Sache.',
        summarySha256: 'ef'.repeat(32),
        redactions: ['REDACTED_ORG'],
        model: 'test-model'
    };

    it('(a) Einzel-Overload + send_resource: fester Digest', () => {
        const digest = computeBindingHash('res_aaaaaaaaaaaa', 'state-hash-a', sendPlan);
        assert.equal(digest, 'f064603d66d521d4bfad154b7443c72d57c361089729df7360e9e4be4f505742');
    });

    it('(b) Set-Overload mit 2 Ressourcen: fester Digest', () => {
        const resources = [
            { resourceRef: 'res_aaaaaaaaaaaa', resourceStateHash: 'state-hash-a' },
            { resourceRef: 'res_bbbbbbbbbbbb', resourceStateHash: 'state-hash-b' }
        ];
        const digest = computeBindingHash(resources, sendPlan);
        assert.equal(digest, 'a822f6f9159abf59b04cfe2f66b99cc026ecd5815f4e3f34671d84802dbb1291');
    });

    it('(c) summarize_resource, Destination cloud_agent: fester Digest', () => {
        const digest = computeBindingHash('res_aaaaaaaaaaaa', 'state-hash-a', summaryPlan);
        assert.equal(digest, '76dbf44caec930ff163859fb82f074358034b11580a3d178ba68376356885f1d');
    });

    it('(d) resourceStateHash mit byteSize: undefined: fester Digest', () => {
        const resource = makeResource({ byteSize: undefined });
        const digest = resourceStateHash(resource);
        assert.equal(digest, 'd0433c1525d2868a7dd009a19b88be330708277e06d1ca20d39a7d7dbadf93c0');
    });
});
