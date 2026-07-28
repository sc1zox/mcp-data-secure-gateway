import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import type { LocalModelConfig } from '../src/config.js';
import {
    LocalModelResponseError,
    LocalModelUnavailableError,
    OllamaClient
} from '../src/judge/ollamaClient.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = originalFetch;
});

function client(idleTimeoutMs = 100): OllamaClient {
    return new OllamaClient({
        baseUrl: 'http://127.0.0.1:11434',
        model: 'local-model',
        idleTimeoutMs,
        temperature: 0,
        numCtx: 4096
    } satisfies LocalModelConfig);
}

function stream(chunks: string[], close = true, delayMs = 0): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
        async start(controller) {
            for (const chunk of chunks) {
                if (delayMs > 0) {
                    await new Promise((resolve) => setTimeout(resolve, delayMs));
                }
                controller.enqueue(encoder.encode(chunk));
            }
            if (close) {
                controller.close();
            }
        }
    });
}

describe('OllamaClient: NDJSON-Streaming', () => {
    it('beendet bei done:true sofort und gibt den Reader frei, auch wenn die Verbindung offen bleibt', async () => {
        let cancelled = false;
        globalThis.fetch = async () =>
            new Response(
                new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(
                            new TextEncoder().encode(
                                '{"message":{"content":"fertig"},"done":true}\n'
                            )
                        );
                    },
                    cancel() {
                        cancelled = true;
                    }
                })
            );

        assert.equal(await client(1000).chatJson('s', 'u'), 'fertig');
        assert.equal(cancelled, true);
    });

    it('verwirft ein weiteres nicht-leeres Frame aus demselben Chunk nach done:true', async () => {
        let cancelled = false;
        globalThis.fetch = async () =>
            new Response(
                new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(
                            new TextEncoder().encode(
                                '{"message":{"content":"fertig"},"done":true}\n' +
                                    '{"message":{"content":"zu spät"}}\n'
                            )
                        );
                    },
                    cancel() {
                        cancelled = true;
                    }
                })
            );

        await assert.rejects(() => client(1000).chatJson('s', 'u'), /Daten nach done:true/);
        assert.equal(cancelled, true);
    });

    it('fordert Thinking an, verwirft Thinking-Frames und setzt JSON-Content zusammen', async () => {
        let requestBody: Record<string, unknown> | undefined;
        globalThis.fetch = async (_input, init) => {
            requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
            return new Response(
                stream([
                    '{"message":{"thinking":"interne Überlegung"}}\n',
                    '{"message":{"thinking":" darf nicht ausgeleitet werden","content":"{\\"answer\\":"}}\n',
                    '{"message":{"content":"\\"ok\\"}"',
                    '}}\n{"message":{"content":""},"done":true}\n'
                ])
            );
        };

        assert.equal(await client().chatJson('system', 'user'), '{"answer":"ok"}');
        assert.equal(requestBody?.stream, true);
        // `think` is an Ollama /api/chat request field, not an inference option.
        assert.equal(requestBody?.think, true);
        assert.equal((requestBody?.options as Record<string, unknown> | undefined)?.thinking, undefined);
    });

    it('verwirft fehlerhaftes NDJSON', async () => {
        globalThis.fetch = async () =>
            new Response(stream(['{"message":{"content":"ok"}}\nnot-json\n{"done":true}\n']));
        await assert.rejects(() => client().chatJson('s', 'u'), LocalModelResponseError);
    });

    it('verwirft Stream-Ende ohne terminales done:true', async () => {
        globalThis.fetch = async () =>
            new Response(stream(['{"message":{"content":"partial"}}\n']));
        await assert.rejects(() => client().chatJson('s', 'u'), /done/);
    });

    it('verwirft eine terminale Antwort ohne Inhalt', async () => {
        globalThis.fetch = async () => new Response(stream(['{"done":true}\n']));
        await assert.rejects(() => client().chatJson('s', 'u'), /keinen Inhalt/);
    });

    it('nimmt Thinking nicht in die Fehlermeldung eines inhaltslosen Streams auf', async () => {
        const thinking = 'vertrauliche interne Überlegung';
        globalThis.fetch = async () =>
            new Response(
                stream([
                    `${JSON.stringify({ message: { thinking } })}\n`,
                    '{"message":{"thinking":""},"done":true}\n'
                ])
            );

        await assert.rejects(
            () => client().chatJson('s', 'u'),
            (error: unknown) =>
                error instanceof LocalModelResponseError &&
                /keinen Inhalt/.test(error.message) &&
                !error.message.includes(thinking)
        );
    });

    it('bricht eine festgefahrene Headerphase nach Inaktivität ab', async () => {
        globalThis.fetch = (_input, init) =>
            new Promise((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () =>
                    reject(new DOMException('aborted', 'AbortError'))
                );
            });
        await assert.rejects(() => client(20).chatJson('s', 'u'), LocalModelUnavailableError);
    });

    it('setzt den Idle-Wächter bei fortlaufendem Stream-Fortschritt zurück', async () => {
        globalThis.fetch = async () =>
            new Response(
                stream(
                    [
                        '{"message":{"content":"a"}}\n',
                        '{"message":{"content":"b"}}\n',
                        '{"done":true}\n'
                    ],
                    true,
                    15
                )
            );
        assert.equal(await client(25).chatJson('s', 'u'), 'ab');
    });

    it('bricht einen nach einem Fragment festgefahrenen Stream ab', async () => {
        globalThis.fetch = async () =>
            new Response(stream(['{"message":{"content":"partial"}}\n'], false));
        await assert.rejects(() => client(20).chatJson('s', 'u'), LocalModelUnavailableError);
    });

    it('verwirft einen abrupt fehlerhaft beendeten Stream', async () => {
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode('{"message":{"content":"partial"}}\n'));
                controller.error(new Error('connection reset'));
            }
        });
        globalThis.fetch = async () => new Response(body);
        await assert.rejects(() => client().chatJson('s', 'u'), LocalModelUnavailableError);
    });

    it('liest Fehlerantworten nur begrenzt', async () => {
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                controller.enqueue(new Uint8Array(2048).fill(120));
            },
            cancel() {
                cancelled = true;
            }
        });
        globalThis.fetch = async () => new Response(body, { status: 500 });
        await assert.rejects(() => client().chatJson('s', 'u'), /HTTP 500/);
        assert.equal(cancelled, true);
    });

    it('begrenzt auch den erfolgreichen Probe-Response nach den Headern per Idle-Wächter', async () => {
        let cancelled = false;
        globalThis.fetch = async () =>
            new Response(
                new ReadableStream<Uint8Array>({
                    cancel() {
                        cancelled = true;
                    }
                })
            );

        const result = await client(20).probe();
        assert.equal(result.reachable, false);
        assert.equal(cancelled, true);
    });

    it('verwirft einen zu großen erfolgreichen Probe-Response', async () => {
        let cancelled = false;
        globalThis.fetch = async () =>
            new Response(
                new ReadableStream<Uint8Array>({
                    pull(controller) {
                        controller.enqueue(new Uint8Array(256 * 1024));
                    },
                    cancel() {
                        cancelled = true;
                    }
                })
            );

        const result = await client().probe();
        assert.equal(result.reachable, false);
        assert.equal(cancelled, true);
    });
});
