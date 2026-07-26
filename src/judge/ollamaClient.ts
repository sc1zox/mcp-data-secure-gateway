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
            const response = await this.request('/api/tags', undefined, 'GET');
            const payload = (await response.json()) as { models?: Array<{ name?: string }> };
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
            stream: false,
            format: 'json',
            options: {
                temperature: this.config.temperature,
                num_ctx: this.config.numCtx
            },
            messages: [
                { role: 'system', content: system },
                { role: 'user', content: user }
            ]
        };
        const response = await this.request('/api/chat', body, 'POST');
        let payload: unknown;
        try {
            payload = await response.json();
        } catch (error) {
            throw new LocalModelResponseError(
                `Antwort des lokalen Modells war kein JSON: ${describeError(error)}`
            );
        }
        const content = (payload as { message?: { content?: unknown } }).message?.content;
        if (typeof content !== 'string' || content.trim().length === 0) {
            throw new LocalModelResponseError('Antwort des lokalen Modells enthielt keinen Inhalt.');
        }
        return content;
    }

    private async request(path: string, body: unknown, method: 'GET' | 'POST'): Promise<Response> {
        const url = new URL(path, this.config.baseUrl).toString();
        const headers: Record<string, string> = { Accept: 'application/json' };
        if (body !== undefined) {
            headers['Content-Type'] = 'application/json';
        }
        if (this.config.bearerToken) {
            headers.Authorization = `Bearer ${this.config.bearerToken}`;
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
        let response: Response;
        try {
            response = await fetch(url, {
                method,
                headers,
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: controller.signal
            });
        } catch (error) {
            const reason =
                error instanceof Error && error.name === 'AbortError'
                    ? `Zeitüberschreitung nach ${this.config.requestTimeoutMs} ms`
                    : describeError(error);
            throw new LocalModelUnavailableError(`Lokales Modell nicht erreichbar (${url}): ${reason}`);
        } finally {
            clearTimeout(timeout);
        }

        if (!response.ok) {
            const detail = await response.text().catch(() => '');
            // 4xx from the runtime usually means a bad model name, which is a
            // configuration fault, but it is still an unavailable local model as
            // far as the caller's decision is concerned.
            throw new LocalModelUnavailableError(
                `Lokales Modell antwortete mit HTTP ${response.status}: ${detail.slice(0, 300)}`
            );
        }
        this.log.debug('Anfrage an lokales Modell abgeschlossen', { path });
        return response;
    }
}
