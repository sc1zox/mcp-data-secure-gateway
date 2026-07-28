import type { LocalModelConfig } from '../config.js';
import { createLogger, describeError, type Logger } from '../util/log.js';

/**
 * Minimal client for the existing Ollama-compatible endpoint.
 *
 * There is no fallback path in this file and there must never be one: if the
 * local model is unreachable the gateway reports `local_model_unavailable` and
 * stops. Routing a private document to a cloud model to keep the flow alive is
 * exactly the failure this whole component exists to prevent (invariant 10).
 */
export class LocalModelUnavailableError extends Error {}
export class LocalModelResponseError extends Error {}

const MAX_PROBE_RESPONSE_BYTES = 1024 * 1024;

export class OllamaClient {
    private readonly log: Logger;

    constructor(private readonly config: LocalModelConfig, logger?: Logger) {
        this.log = (logger ?? createLogger('judge')).child('ollama');
    }

    get model(): string {
        return this.config.model;
    }

    /** Verifies the endpoint answers and the configured model is present. */
    async probe(): Promise<{ reachable: boolean; modelPresent: boolean; detail?: string }> {
        try {
            const controller = new AbortController();
            const response = await this.request('/api/tags', undefined, 'GET', controller);
            const payload = await this.readJsonBounded<{ models?: Array<{ name?: string }> }>(
                response.body,
                controller,
                MAX_PROBE_RESPONSE_BYTES
            );
            const names = (payload.models ?? [])
                .map((entry) => entry.name)
                .filter((name): name is string => typeof name === 'string');
            // Ollama reports `qwen3.5:9b`; a config naming the bare family should
            // still count as present.
            const modelPresent = names.some(
                (name) => name === this.config.model || name.startsWith(`${this.config.model}:`)
            );
            return {
                reachable: true,
                modelPresent,
                detail: modelPresent ? undefined : `Verfügbare Modelle: ${names.join(', ') || '(keine)'}`
            };
        } catch (error) {
            return { reachable: false, modelPresent: false, detail: describeError(error) };
        }
    }

    /**
     * Sends a chat completion and returns the raw assistant text.
     *
     * `format: 'json'` asks the runtime to constrain output to JSON. The caller
     * still validates the result against a schema, because a constrained decoder
     * guarantees syntax, not meaning.
     */
    async chatJson(system: string, user: string): Promise<string> {
        const body = {
            model: this.config.model,
            stream: true,
            // Ollama's /api/chat control is a top-level field. Keeping it out of
            // `options` is intentional: those are model inference parameters.
            think: this.config.think,
            format: 'json',
            keep_alive: this.config.keepAlive,
            options: {
                temperature: this.config.temperature,
                num_ctx: this.config.numCtx,
                num_predict: this.config.numPredict
            },
            messages: [
                { role: 'system', content: system },
                { role: 'user', content: user }
            ]
        };
        const controller = new AbortController();
        const response = await this.request('/api/chat', body, 'POST', controller);
        if (!response.body) {
            throw new LocalModelResponseError('Antwort des lokalen Modells enthielt keinen Stream.');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let pending = '';
        let content = '';
        let doneSeen = false;
        let frameCount = 0;
        let lastMetrics: OllamaMetrics | undefined;
        try {
            while (true) {
                const result = await this.readWithIdle(reader, controller);
                if (result.done) {
                    pending += decoder.decode();
                    break;
                }
                pending += decoder.decode(result.value, { stream: true });
                let newline: number;
                while ((newline = pending.indexOf('\n')) >= 0) {
                    const line = pending.slice(0, newline).trim();
                    pending = pending.slice(newline + 1);
                    if (line.length > 0) {
                        const frame = parseFrame(line);
                        if (doneSeen) {
                            throw new LocalModelResponseError(
                                'Antwort des lokalen Modells enthielt Daten nach done:true.'
                            );
                        }
                        content += frame.content;
                        frameCount += 1;
                        doneSeen = frame.done;
                        if (frame.metrics) {
                            lastMetrics = frame.metrics;
                        }
                        if (doneSeen) {
                            if (pending.trim().length > 0) {
                                throw new LocalModelResponseError(
                                    'Antwort des lokalen Modells enthielt Daten nach done:true.'
                                );
                            }
                            return await this.finishChat(reader, content, frameCount, lastMetrics);
                        }
                    }
                }
            }
        } catch (error) {
            await reader.cancel().catch(() => undefined);
            if (error instanceof LocalModelResponseError || error instanceof LocalModelUnavailableError) {
                throw error;
            }
            throw new LocalModelUnavailableError(
                `Stream des lokalen Modells wurde abrupt beendet: ${describeError(error)}`
            );
        }
        const tail = pending.trim();
        if (tail.length > 0) {
            const frame = parseFrame(tail);
            if (doneSeen) {
                throw new LocalModelResponseError(
                    'Antwort des lokalen Modells enthielt Daten nach done:true.'
                );
            }
            content += frame.content;
            frameCount += 1;
            doneSeen = frame.done;
            if (frame.metrics) {
                lastMetrics = frame.metrics;
            }
        }
        if (!doneSeen) {
            throw new LocalModelResponseError(
                'Antwort des lokalen Modells endete ohne terminales done:true.'
            );
        }
        if (content.trim().length === 0) {
            throw new LocalModelResponseError('Antwort des lokalen Modells enthielt keinen Inhalt.');
        }
        return await this.finishChat(reader, content, frameCount, lastMetrics);
    }

    private async finishChat(
        reader: ReadableStreamDefaultReader<Uint8Array>,
        content: string,
        frameCount: number,
        metrics?: OllamaMetrics
    ): Promise<string> {
        await reader.cancel().catch(() => undefined);
        if (content.trim().length === 0) {
            throw new LocalModelResponseError('Antwort des lokalen Modells enthielt keinen Inhalt.');
        }
        this.log.info('Lokale Modellinferenz abgeschlossen', {
            frames: frameCount,
            contentChars: content.length,
            promptTokens: metrics?.promptEvalCount,
            promptSeconds: metrics?.promptEvalDuration
                ? metrics.promptEvalDuration / 1_000_000_000
                : undefined,
            outputTokens: metrics?.evalCount,
            outputSeconds: metrics?.evalDuration ? metrics.evalDuration / 1_000_000_000 : undefined,
            totalSeconds: metrics?.totalDuration ? metrics.totalDuration / 1_000_000_000 : undefined
        });
        return content;
    }

    private async request(
        path: string,
        body: unknown,
        method: 'GET' | 'POST',
        suppliedController?: AbortController
    ): Promise<Response> {
        const url = new URL(path, this.config.baseUrl).toString();
        const headers: Record<string, string> = { Accept: 'application/json' };
        if (body !== undefined) {
            headers['Content-Type'] = 'application/json';
        }
        if (this.config.bearerToken) {
            headers.Authorization = `Bearer ${this.config.bearerToken}`;
        }

        const controller = suppliedController ?? new AbortController();
        let response: Response;
        try {
            response = await this.withIdle(
                fetch(url, {
                    method,
                    headers,
                    body: body === undefined ? undefined : JSON.stringify(body),
                    signal: controller.signal
                }),
                controller
            );
        } catch (error) {
            const reason =
                error instanceof Error && error.name === 'AbortError'
                    ? `keine Aktivität für ${this.config.idleTimeoutMs} ms`
                    : describeError(error);
            throw new LocalModelUnavailableError(`Lokales Modell nicht erreichbar (${url}): ${reason}`);
        }

        if (!response.ok) {
            await this.discardBounded(response.body, controller);
            // 4xx from the runtime usually means a bad model name, which is a
            // configuration fault, but it is still an unavailable local model as
            // far as the caller's decision is concerned.
            throw new LocalModelUnavailableError(
                `Lokales Modell antwortete mit HTTP ${response.status}.`
            );
        }
        this.log.debug('Anfrage an lokales Modell abgeschlossen', { path });
        return response;
    }

    private async readWithIdle(
        reader: ReadableStreamDefaultReader<Uint8Array>,
        controller: AbortController
    ): Promise<Awaited<ReturnType<typeof reader.read>>> {
        try {
            return await this.withIdle(reader.read(), controller);
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                throw new LocalModelUnavailableError(
                    `Lokales Modell lieferte ${this.config.idleTimeoutMs} ms lang keinen Fortschritt.`
                );
            }
            throw error;
        }
    }

    private async withIdle<T>(operation: Promise<T>, controller: AbortController): Promise<T> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const idle = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
                controller.abort();
                reject(new DOMException('idle watchdog expired', 'AbortError'));
            }, this.config.idleTimeoutMs);
        });
        try {
            return await Promise.race([operation, idle]);
        } finally {
            if (timer) {
                clearTimeout(timer);
            }
        }
    }

    private async discardBounded(
        body: ReadableStream<Uint8Array> | null,
        controller: AbortController
    ): Promise<void> {
        if (!body) {
            return;
        }
        const reader = body.getReader();
        let bytes = 0;
        try {
            while (bytes < 4096) {
                const result = await this.readWithIdle(reader, controller);
                if (result.done) {
                    return;
                }
                bytes += result.value.byteLength;
            }
        } catch {
            // The status code is sufficient and safe diagnostic information.
        } finally {
            await reader.cancel().catch(() => undefined);
        }
    }

    private async readJsonBounded<T>(
        body: ReadableStream<Uint8Array> | null,
        controller: AbortController,
        maxBytes: number
    ): Promise<T> {
        if (!body) {
            throw new LocalModelResponseError('Antwort des lokalen Modells enthielt keinen Body.');
        }
        const reader = body.getReader();
        const chunks: Uint8Array[] = [];
        let length = 0;
        try {
            while (true) {
                const result = await this.readWithIdle(reader, controller);
                if (result.done) {
                    break;
                }
                length += result.value.byteLength;
                if (length > maxBytes) {
                    throw new LocalModelResponseError(
                        `Antwort des lokalen Modells überschritt ${maxBytes} Bytes.`
                    );
                }
                chunks.push(result.value);
            }
        } finally {
            await reader.cancel().catch(() => undefined);
        }
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
        }
        try {
            return JSON.parse(new TextDecoder().decode(bytes)) as T;
        } catch {
            throw new LocalModelResponseError('Antwort des lokalen Modells war kein JSON.');
        }
    }
}

export interface OllamaMetrics {
    totalDuration?: number;
    loadDuration?: number;
    promptEvalCount?: number;
    promptEvalDuration?: number;
    evalCount?: number;
    evalDuration?: number;
}

function parseFrame(line: string): { content: string; done: boolean; metrics?: OllamaMetrics } {
    let parsed: unknown;
    try {
        parsed = JSON.parse(line);
    } catch {
        throw new LocalModelResponseError('Antwort des lokalen Modells enthielt fehlerhaftes NDJSON.');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new LocalModelResponseError('Antwort des lokalen Modells enthielt ein ungültiges NDJSON-Frame.');
    }
    const frame = parsed as {
        message?: unknown;
        done?: unknown;
        total_duration?: unknown;
        load_duration?: unknown;
        prompt_eval_count?: unknown;
        prompt_eval_duration?: unknown;
        eval_count?: unknown;
        eval_duration?: unknown;
    };
    if (frame.done !== undefined && typeof frame.done !== 'boolean') {
        throw new LocalModelResponseError('Antwort des lokalen Modells enthielt ein ungültiges done-Feld.');
    }
    let content = '';
    if (frame.message !== undefined) {
        if (!frame.message || typeof frame.message !== 'object' || Array.isArray(frame.message)) {
            throw new LocalModelResponseError('Antwort des lokalen Modells enthielt ein ungültiges message-Feld.');
        }
        const message = frame.message as { content?: unknown; thinking?: unknown };
        if (message.thinking !== undefined && typeof message.thinking !== 'string') {
            throw new LocalModelResponseError(
                'Antwort des lokalen Modells enthielt ungültiges Thinking.'
            );
        }
        if (message.content !== undefined && typeof message.content !== 'string') {
            throw new LocalModelResponseError('Antwort des lokalen Modells enthielt ungültigen Inhalt.');
        }
        // Thinking stays local and is deliberately neither accumulated nor logged.
        content = message.content ?? '';
    }

    let metrics: OllamaMetrics | undefined;
    if (
        typeof frame.total_duration === 'number' ||
        typeof frame.prompt_eval_count === 'number' ||
        typeof frame.eval_count === 'number'
    ) {
        metrics = {
            totalDuration: typeof frame.total_duration === 'number' ? frame.total_duration : undefined,
            loadDuration: typeof frame.load_duration === 'number' ? frame.load_duration : undefined,
            promptEvalCount: typeof frame.prompt_eval_count === 'number' ? frame.prompt_eval_count : undefined,
            promptEvalDuration:
                typeof frame.prompt_eval_duration === 'number' ? frame.prompt_eval_duration : undefined,
            evalCount: typeof frame.eval_count === 'number' ? frame.eval_count : undefined,
            evalDuration: typeof frame.eval_duration === 'number' ? frame.eval_duration : undefined
        };
    }

    return { content, done: frame.done === true, metrics };
}
