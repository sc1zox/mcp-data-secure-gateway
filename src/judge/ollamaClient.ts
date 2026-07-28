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
        let thinkingChars = 0;
        let lastMetrics: OllamaMetrics | undefined;
        let doneReason: string | undefined;
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
                        thinkingChars += frame.thinkingChars;
                        frameCount += 1;
                        doneSeen = frame.done;
                        if (frame.metrics) {
                            lastMetrics = frame.metrics;
                        }
                        if (frame.doneReason) {
                            doneReason = frame.doneReason;
                        }
                        if (doneSeen) {
                            if (pending.trim().length > 0) {
                                throw new LocalModelResponseError(
                                    'Antwort des lokalen Modells enthielt Daten nach done:true.'
                                );
                            }
                            return await this.finishChat(reader, {
                                content,
                                frameCount,
                                thinkingChars,
                                metrics: lastMetrics,
                                doneReason
                            });
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
            thinkingChars += frame.thinkingChars;
            frameCount += 1;
            doneSeen = frame.done;
            if (frame.metrics) {
                lastMetrics = frame.metrics;
            }
            if (frame.doneReason) {
                doneReason = frame.doneReason;
            }
        }
        if (!doneSeen) {
            throw new LocalModelResponseError(
                'Antwort des lokalen Modells endete ohne terminales done:true.'
            );
        }
        // `finishChat` makes the same emptiness check, but only after it has had
        // a chance to name truncation as the cause. Checking here first would
        // report an answer cut off at token zero as "no content".
        return await this.finishChat(reader, {
            content,
            frameCount,
            thinkingChars,
            metrics: lastMetrics,
            doneReason
        });
    }

    /**
     * Turns the runtime's own account of why it stopped into a diagnosis.
     *
     * `done_reason: 'length'` means the answer was cut off at the token budget,
     * so the JSON object never closed. Read as a parse failure that is exactly
     * what it looks like downstream — the caller reports "war kein gültiges
     * JSON" and the operator goes looking at the prompt instead of at
     * `numPredict`/`numCtx`, which is where the fault actually is.
     */
    private assertNotTruncated(doneReason: string | undefined, metrics?: OllamaMetrics): void {
        if (doneReason !== 'length') {
            return;
        }
        const promptTokens = metrics?.promptEvalCount;
        const budget =
            promptTokens !== undefined
                ? ` Der Prompt belegte ${promptTokens} von ${this.config.numCtx} Kontext-Tokens.`
                : '';
        throw new LocalModelResponseError(
            `Antwort des lokalen Modells wurde nach ${this.config.numPredict} Tokens abgeschnitten ` +
                `(done_reason: length) und ist deshalb unvollständig.${budget} ` +
                'Erhöhen Sie localModel.numCtx, senken Sie localModel.numPredict oder schalten Sie ' +
                'localModel.think ab.'
        );
    }

    /**
     * Warns when prompt and token budget together do not fit the context window.
     *
     * The runtime does not refuse such a request: it silently drops the oldest
     * tokens once the window is full, which takes the system prompt and the
     * candidates away from the model mid-answer. The result reads like a model
     * that lost the plot, and nothing in the response says why.
     */
    private warnOnContextPressure(metrics?: OllamaMetrics): void {
        const promptTokens = metrics?.promptEvalCount;
        if (promptTokens === undefined) {
            return;
        }
        const needed = promptTokens + this.config.numPredict;
        if (needed <= this.config.numCtx) {
            return;
        }
        this.log.warn(
            'Prompt und Token-Budget passen nicht in das Kontextfenster. Das Modell verliert bei ' +
                'langen Antworten seine Anweisungen.',
            {
                promptTokens,
                numPredict: this.config.numPredict,
                numCtx: this.config.numCtx,
                fehlend: needed - this.config.numCtx
            }
        );
    }

    /**
     * Explains an answer that never arrived.
     *
     * A reasoning model with a context window too small for its own prompt
     * spends the whole remaining budget thinking and emits no `content` at all.
     * "Enthielt keinen Inhalt" is true of that, and of a dozen unrelated
     * faults, so the numbers that separate them are named here. The reasoning
     * text stays local — only its length is reported.
     */
    private describeEmptyAnswer(thinkingChars: number, metrics?: OllamaMetrics): string {
        if (thinkingChars === 0) {
            return 'Antwort des lokalen Modells enthielt keinen Inhalt.';
        }
        const promptTokens = metrics?.promptEvalCount;
        const window =
            promptTokens !== undefined
                ? ` Der Prompt belegte ${promptTokens} von ${this.config.numCtx} Kontext-Tokens.`
                : ` Das Kontextfenster ist auf ${this.config.numCtx} Tokens gesetzt.`;
        return (
            `Das lokale Modell hat ausschließlich intern nachgedacht (${thinkingChars} Zeichen) und ` +
            `keine Antwort ausgegeben.${window} Setzen Sie localModel.think auf false oder erhöhen ` +
            'Sie localModel.numCtx, damit nach dem Prompt noch Platz für die Antwort bleibt.'
        );
    }

    private async finishChat(
        reader: ReadableStreamDefaultReader<Uint8Array>,
        outcome: StreamOutcome
    ): Promise<string> {
        const { content, frameCount, thinkingChars, metrics, doneReason } = outcome;
        await reader.cancel().catch(() => undefined);
        this.warnOnContextPressure(metrics);
        this.assertNotTruncated(doneReason, metrics);
        if (content.trim().length === 0) {
            throw new LocalModelResponseError(this.describeEmptyAnswer(thinkingChars, metrics));
        }
        this.log.info('Lokale Modellinferenz abgeschlossen', {
            frames: frameCount,
            contentChars: content.length,
            thinkingChars,
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

/** What one completed `/api/chat` stream yielded, as the reader saw it. */
interface StreamOutcome {
    content: string;
    frameCount: number;
    /** Length of the reasoning output; never the reasoning itself. */
    thinkingChars: number;
    metrics?: OllamaMetrics;
    doneReason?: string;
}

export interface OllamaMetrics {
    totalDuration?: number;
    loadDuration?: number;
    promptEvalCount?: number;
    promptEvalDuration?: number;
    evalCount?: number;
    evalDuration?: number;
}

function parseFrame(line: string): {
    content: string;
    /** Length only — the reasoning text itself never leaves this function. */
    thinkingChars: number;
    done: boolean;
    doneReason?: string;
    metrics?: OllamaMetrics;
} {
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
        done_reason?: unknown;
        error?: unknown;
        total_duration?: unknown;
        load_duration?: unknown;
        prompt_eval_count?: unknown;
        prompt_eval_duration?: unknown;
        eval_count?: unknown;
        eval_duration?: unknown;
    };
    // The runtime reports a mid-stream failure as a bare `{"error": "..."}`
    // frame with no `done`. Without this the stream just ends and the caller is
    // told the model "endete ohne terminales done:true", which describes the
    // symptom and hides the cause.
    if (typeof frame.error === 'string' && frame.error.length > 0) {
        throw new LocalModelUnavailableError(
            `Lokales Modell meldete einen Fehler: ${frame.error.slice(0, 200)}`
        );
    }
    if (frame.done !== undefined && typeof frame.done !== 'boolean') {
        throw new LocalModelResponseError('Antwort des lokalen Modells enthielt ein ungültiges done-Feld.');
    }
    let content = '';
    let thinkingChars = 0;
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
        // Thinking stays local and is deliberately neither accumulated nor
        // logged. Its *length* is carried out, because "the model only thought
        // and never answered" is the difference between a diagnosable failure
        // and a mystery, and a character count reveals nothing about content.
        thinkingChars = (message.thinking ?? '').length;
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

    return {
        content,
        thinkingChars,
        done: frame.done === true,
        doneReason: typeof frame.done_reason === 'string' ? frame.done_reason : undefined,
        metrics
    };
}
