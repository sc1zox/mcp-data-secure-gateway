export class HttpTimeoutError extends Error {}
export class HttpResponseTooLargeError extends Error {}
export class HttpInvalidJsonError extends Error {}

export interface BoundedJsonOptions {
    timeoutMs: number;
    maxResponseBytes: number;
}

export async function fetchJsonBounded<T>(
    fetchImpl: typeof fetch,
    input: string,
    init: RequestInit,
    options: BoundedJsonOptions
): Promise<{ response: Response; payload: T }> {
    const controller = new AbortController();
    const externalSignal = init.signal;
    const abortFromExternal = () => controller.abort();
    externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
    if (externalSignal?.aborted) {
        controller.abort();
    }
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
        const response = await raceAbort(
            fetchImpl(input, { ...init, signal: controller.signal }),
            controller.signal
        );
        const bytes = await readBounded(response.body, controller.signal, options.maxResponseBytes);
        let payload: T;
        try {
            payload = JSON.parse(new TextDecoder().decode(bytes)) as T;
        } catch {
            throw new HttpInvalidJsonError('HTTP-Antwort war kein JSON.');
        }
        return { response, payload };
    } catch (error) {
        if (controller.signal.aborted && !externalSignal?.aborted) {
            throw new HttpTimeoutError(`Zeitüberschreitung nach ${options.timeoutMs} ms.`);
        }
        throw error;
    } finally {
        clearTimeout(timeout);
        externalSignal?.removeEventListener('abort', abortFromExternal);
    }
}

async function readBounded(
    body: ReadableStream<Uint8Array> | null,
    signal: AbortSignal,
    maxBytes: number
): Promise<Uint8Array> {
    if (!body) {
        return new Uint8Array();
    }
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
        while (true) {
            const result = await raceAbort(reader.read(), signal);
            if (result.done) {
                break;
            }
            length += result.value.byteLength;
            if (length > maxBytes) {
                throw new HttpResponseTooLargeError(
                    `HTTP-Antwort überschreitet ${maxBytes} Bytes.`
                );
            }
            chunks.push(result.value);
        }
    } finally {
        await reader.cancel().catch(() => undefined);
    }
    const joined = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        joined.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return joined;
}

function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
        return Promise.reject(new DOMException('aborted', 'AbortError'));
    }
    return new Promise<T>((resolve, reject) => {
        const aborted = () => reject(new DOMException('aborted', 'AbortError'));
        signal.addEventListener('abort', aborted, { once: true });
        operation.then(
            (value) => {
                signal.removeEventListener('abort', aborted);
                resolve(value);
            },
            (error: unknown) => {
                signal.removeEventListener('abort', aborted);
                reject(error);
            }
        );
    });
}
