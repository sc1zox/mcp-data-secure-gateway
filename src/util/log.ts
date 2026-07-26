export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: number = LEVEL_ORDER.info;

export function setLogLevel(level: LogLevel): void {
    threshold = LEVEL_ORDER[level];
}

/**
 * All diagnostic output goes to stderr. stdout is reserved for the MCP stdio
 * transport, and anything written there would corrupt the JSON-RPC stream.
 *
 * Log lines are for the operator of this machine. They may reference internal
 * ids, but callers should keep document contents out of them — the audit log is
 * the place for decision detail.
 */
function emit(level: LogLevel, scope: string, message: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < threshold) {
        return;
    }
    const line = {
        ts: new Date().toISOString(),
        level,
        scope,
        message,
        ...(fields ?? {})
    };
    process.stderr.write(`${JSON.stringify(line)}\n`);
}

export interface Logger {
    debug(message: string, fields?: Record<string, unknown>): void;
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
    error(message: string, fields?: Record<string, unknown>): void;
    child(subScope: string): Logger;
}

export function createLogger(scope: string): Logger {
    return {
        debug: (m, f) => emit('debug', scope, m, f),
        info: (m, f) => emit('info', scope, m, f),
        warn: (m, f) => emit('warn', scope, m, f),
        error: (m, f) => emit('error', scope, m, f),
        child: (subScope: string) => createLogger(`${scope}.${subScope}`)
    };
}

/** Turns unknown throwables into a short, loggable description. */
export function describeError(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    if (typeof error === 'string') {
        return error;
    }
    return 'unbekannter Fehler';
}
