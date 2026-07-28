import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import { DefaultTelegramHttpClient } from '../src/approval/telegramApproval.js';
import type { TelegramTargetConfig } from '../src/config.js';
import { TelegramTarget } from '../src/targets/telegramTarget.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = originalFetch;
});

function stalledFetch(): typeof fetch {
    return ((_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
                reject(new DOMException('aborted', 'AbortError'));
            });
        })) as typeof fetch;
}

function target(): TelegramTarget {
    return new TelegramTarget(
        {
            id: 'private_telegram',
            kind: 'telegram',
            enabled: true,
            label: 'Telegram',
            purpose: 'Test',
            botToken: 'secret-token',
            chatId: '123',
            apiBaseUrl: 'https://telegram.invalid',
            maxAttachments: 1,
            maxAttachmentBytes: 1024
        } satisfies TelegramTargetConfig,
        undefined,
        { fetchImpl: globalThis.fetch, requestTimeoutMs: 20, maxResponseBytes: 1024 }
    );
}

function targetWithFetch(fetchImpl: typeof fetch): TelegramTarget {
    return new TelegramTarget(
        {
            id: 'private_telegram',
            kind: 'telegram',
            enabled: true,
            label: 'Telegram',
            purpose: 'Test',
            botToken: 'secret-token',
            chatId: '123',
            apiBaseUrl: 'https://telegram.invalid',
            maxAttachments: 1,
            maxAttachmentBytes: 1024
        } satisfies TelegramTargetConfig,
        undefined,
        { fetchImpl, requestTimeoutMs: 20, maxResponseBytes: 1024 }
    );
}

describe('Telegram-HTTP-Grenzen', () => {
    it('begrenzt die Header-Wartezeit des Freigabeadapters', async () => {
        const client = new DefaultTelegramHttpClient(
            () => 'secret-token',
            'https://telegram.invalid',
            stalledFetch(),
            { requestTimeoutMs: 20, longPollHeadroomMs: 10, maxResponseBytes: 1024 }
        );

        await assert.rejects(
            () => client.call('getUpdates', { timeout: 0 }),
            /Zeitüberschreitung/
        );
    });

    it('begrenzt und verwirft einen festgefahrenen Response-Body des Freigabeadapters', async () => {
        let cancelled = false;
        const client = new DefaultTelegramHttpClient(
            () => 'secret-token',
            'https://telegram.invalid',
            async () =>
                new Response(
                    new ReadableStream<Uint8Array>({
                        cancel() {
                            cancelled = true;
                        }
                    })
                ),
            { requestTimeoutMs: 20, longPollHeadroomMs: 10, maxResponseBytes: 1024 }
        );

        await assert.rejects(() => client.call('sendMessage', {}), /Zeitüberschreitung/);
        assert.equal(cancelled, true);
    });

    it('verwirft zu große Telegram-Antworten des Freigabeadapters', async () => {
        let cancelled = false;
        const client = new DefaultTelegramHttpClient(
            () => 'secret-token',
            'https://telegram.invalid',
            async () =>
                new Response(
                    new ReadableStream<Uint8Array>({
                        pull(controller) {
                            controller.enqueue(new Uint8Array(600));
                        },
                        cancel() {
                            cancelled = true;
                        }
                    })
                ),
            { requestTimeoutMs: 100, longPollHeadroomMs: 10, maxResponseBytes: 1024 }
        );

        await assert.rejects(() => client.call('sendMessage', {}), /zu groß/);
        assert.equal(cancelled, true);
    });

    it('begrenzt die Telegram-Zielanfrage bereits vor den Headern', async () => {
        globalThis.fetch = stalledFetch();
        await assert.rejects(
            () => target().deliver({ subject: 'x', body: '', attachments: [] }),
            /Zeitüberschreitung/
        );
    });

    it('begrenzt und verwirft einen festgefahrenen Response-Body des Telegram-Ziels', async () => {
        let cancelled = false;
        const telegram = targetWithFetch(
            async () =>
                new Response(
                    new ReadableStream<Uint8Array>({
                        cancel() {
                            cancelled = true;
                        }
                    })
                )
        );

        await assert.rejects(
            () => telegram.deliver({ subject: 'x', body: '', attachments: [] }),
            /Zeitüberschreitung/
        );
        assert.equal(cancelled, true);
    });
});
