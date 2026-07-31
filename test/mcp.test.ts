import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createHermesServer } from '../src/mcp/hermesServer.js';
import { makeHarness, makeResource, type Harness } from './helpers.js';

/**
 * The MCP surface as Hermes actually meets it.
 *
 * The rest of the suite calls the orchestrator directly, which is the right
 * level for the decision logic but stops one layer short of the boundary the
 * invariants are about. Here the tools are invoked over a real MCP client, so
 * what is asserted is the JSON a cloud agent would receive — including the fact
 * that the tool list contains no way to read a document.
 */

const cleanups: Array<() => Promise<void>> = [];
after(async () => {
    for (const cleanup of cleanups) {
        await cleanup();
    }
});

const QUERY = 'mein aktueller Lebenslauf';
const PURPOSE = 'Bewerbung auf eine Stelle';

interface Connected {
    client: Client;
    harness: Harness;
}

async function connect(options: Parameters<typeof makeHarness>[0] = {}): Promise<Connected> {
    const harness = await makeHarness(options);
    const server = createHermesServer(harness.orchestrator);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-agent', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.push(async () => {
        await client.close();
        await harness.cleanup();
    });
    return { client, harness };
}

/**
 * Tool results carry the payload as JSON in a text block. Deliberately typed
 * loosely: these tests assert on the wire shape a foreign client sees, so
 * borrowing the gateway's own types here would let a renamed field pass.
 */
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as Array<{ type: string; text: string }>;
    assert.equal(content[0]?.type, 'text');
    return JSON.parse(content[0]!.text);
}

describe('Werkzeugoberfläche', () => {
    it('bietet genau die abstrakten Werkzeuge an', async () => {
        const { client } = await connect();
        const names = (await client.listTools()).tools.map((tool) => tool.name).sort();

        assert.deepEqual(names, [
            'await_action_decision',
            'find_resource',
            'get_action_status',
            'get_summary',
            'list_targets',
            'prepare_action',
            'summarize_resource'
        ]);
    });

    it('nimmt eine geordnete Liste opaker Referenzen an, ohne Anhangsdaten zurückzugeben', async () => {
        const first = makeResource({
            title: 'Lebenslauf intern',
            locator: { sourceId: 'fake', nativeId: '4711' },
            stateToken: 'cv:v1'
        });
        const second = makeResource({
            title: 'Anschreiben intern',
            locator: { sourceId: 'fake', nativeId: '4712' },
            stateToken: 'letter:v1'
        });
        const { client, harness } = await connect({ resources: [first] });
        const foundFirst = await call(client, 'find_resource', { query: 'Lebenslauf', purpose: PURPOSE });
        harness.source.resources = [second];
        const foundSecond = await call(client, 'find_resource', { query: 'Anschreiben', purpose: PURPOSE });
        harness.source.resources = [first, second];
        harness.source.files.set('4711', {
            filename: 'lebenslauf.pdf',
            mimeType: 'application/pdf',
            bytes: new Uint8Array([1, 2, 3])
        });
        harness.source.files.set('4712', {
            filename: 'anschreiben.pdf',
            mimeType: 'application/pdf',
            bytes: new Uint8Array([4, 5, 6])
        });

        const state = await call(client, 'prepare_action', {
            references: [foundFirst.resource.reference, foundSecond.resource.reference],
            target: 'private_mail',
            purpose: PURPOSE
        });

        assert.equal(state.status, 'awaiting_local_approval');
        assert.deepEqual(Object.keys(state).sort(), ['action_id', 'note', 'reason', 'status']);
        assert.doesNotMatch(JSON.stringify(state), /Lebenslauf intern|Anschreiben intern|4711|4712|fake/);
        const view = harness.orchestrator.localAction(state.action_id);
        assert.ok(view?.kind === 'send_resource');
        assert.equal(view.resources.length, 2);
        assert.equal(view.egress.attachments.length, 2);
    });

    it('behält die bisherige einzelne reference-Form an der MCP-Grenze bei', async () => {
        const { client } = await connect();
        const found = await call(client, 'find_resource', { query: QUERY, purpose: PURPOSE });
        const targets = await call(client, 'list_targets', {});
        assert.equal(targets.targets[0].max_attachments, 10);
        assert.equal(targets.targets[0].max_attachment_bytes, 1024 * 1024);
        assert.deepEqual(
            Object.keys(targets.targets[0]).sort(),
            [
                'accepts_attachments',
                'dynamic_recipient',
                'max_attachment_bytes',
                'max_attachments',
                'purpose',
                'target'
            ]
        );

        const state = await call(client, 'prepare_action', {
            reference: found.resource.reference,
            target: 'private_mail',
            purpose: PURPOSE
        });

        assert.equal(state.status, 'awaiting_local_approval');
    });
});

describe('summarize_resource über MCP', () => {
    it('antwortet mit einer wartenden Aktion und ohne Text', async () => {
        const { client } = await connect();
        const found = await call(client, 'find_resource', { query: QUERY, purpose: PURPOSE });

        const state = await call(client, 'summarize_resource', {
            reference: found.resource.reference,
            purpose: PURPOSE,
            focus: 'Berufserfahrung'
        });

        assert.equal(state.status, 'awaiting_local_approval');
        assert.equal(state.summary, undefined);
        assert.doesNotMatch(JSON.stringify(state), /REDACTED|Mustermann/);
    });

    it('gibt den Text erst nach der lokalen Freigabe heraus', async () => {
        const { client, harness } = await connect();
        const found = await call(client, 'find_resource', { query: QUERY, purpose: PURPOSE });
        const state = await call(client, 'summarize_resource', {
            reference: found.resource.reference,
            purpose: PURPOSE
        });

        const before = await call(client, 'get_summary', { action_id: state.action_id });
        assert.equal(before.summary, undefined);

        const view = harness.orchestrator.localAction(state.action_id);
        assert.ok(view?.kind === 'summarize_resource');
        await harness.orchestrator.approveAction(state.action_id);
        await harness.orchestrator.awaitActionDecision(state.action_id, 5);

        const after = await call(client, 'get_summary', { action_id: state.action_id });
        assert.equal(after.status, 'completed');
        // Exactly the characters the approval view displayed, nothing appended.
        assert.equal(after.summary, view.summary.text);
        assert.deepEqual(after.redactions, ['REDACTED_NAME', 'REDACTED_ORG']);
    });

    it('meldet dem Agenten den Ablauf, ohne ihn beschleunigen zu lassen', async () => {
        const { client } = await connect();
        const found = await call(client, 'find_resource', { query: QUERY, purpose: PURPOSE });
        const state = await call(client, 'summarize_resource', {
            reference: found.resource.reference,
            purpose: PURPOSE
        });

        assert.match(state.note, /Freigabe/);
        // Waiting is the only lever the agent has, and it does not pull anything.
        const waited = await call(client, 'await_action_decision', {
            action_id: state.action_id,
            timeout_seconds: 1
        });
        assert.equal(waited.status, 'awaiting_local_approval');
        assert.equal((await call(client, 'get_summary', { action_id: state.action_id })).summary, undefined);
    });
});
