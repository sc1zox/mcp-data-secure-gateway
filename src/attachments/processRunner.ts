/**
 * The one place a local optimization tool is allowed to be executed.
 *
 * Every property that keeps running qpdf and Ghostscript from becoming a hole
 * in the gateway lives here rather than at the call sites: no shell, arguments
 * as separate values, filenames the gateway invented rather than ones a source
 * chose, a hard deadline, a bounded amount of captured output, and a bounded
 * number of concurrent children. An adapter cannot opt out of any of it,
 * because an adapter cannot spawn anything itself.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A child that was still running when its deadline passed. */
export class ProcessTimeoutError extends Error {}
/** A child that could not be started at all — usually a missing binary. */
export class ProcessSpawnError extends Error {}

export interface ProcessResult {
    /** Exit code, or -1 when the child was killed by a signal. */
    code: number;
    stdout: string;
    stderr: string;
}

export interface ProcessSpec {
    command: string;
    args: string[];
    /** Concurrency lane, e.g. `ghostscript`. Unknown lanes are unlimited. */
    lane?: string;
    timeoutMs: number;
    cwd?: string;
}

/**
 * Counting semaphore. Ghostscript in particular is memory-hungry enough that
 * two concurrent runs over large scans can hurt more than the serialisation
 * costs, so the story pins it at one.
 */
export class Semaphore {
    private active = 0;
    private readonly waiting: Array<() => void> = [];

    constructor(private readonly limit: number) {}

    async run<T>(task: () => Promise<T>): Promise<T> {
        if (this.active >= this.limit) {
            await new Promise<void>((resolve) => this.waiting.push(resolve));
        }
        this.active += 1;
        try {
            return await task();
        } finally {
            this.active -= 1;
            this.waiting.shift()?.();
        }
    }
}

export class ProcessRunner {
    private readonly lanes = new Map<string, Semaphore>();

    constructor(
        private readonly concurrency: Record<string, number> = {},
        /** Captured stdout/stderr per stream. Enough to diagnose, not to leak. */
        private readonly maxOutputBytes = 64 * 1024
    ) {}

    private lane(name: string | undefined): Semaphore | undefined {
        if (!name) {
            return undefined;
        }
        const limit = this.concurrency[name];
        if (limit === undefined) {
            return undefined;
        }
        let semaphore = this.lanes.get(name);
        if (!semaphore) {
            semaphore = new Semaphore(limit);
            this.lanes.set(name, semaphore);
        }
        return semaphore;
    }

    async run(spec: ProcessSpec): Promise<ProcessResult> {
        const semaphore = this.lane(spec.lane);
        return semaphore ? semaphore.run(() => this.spawn(spec)) : this.spawn(spec);
    }

    private spawn(spec: ProcessSpec): Promise<ProcessResult> {
        return new Promise<ProcessResult>((resolve, reject) => {
            const child = spawn(spec.command, spec.args, {
                // No shell: `spec.args` are values, never fragments of a command
                // line, so nothing in a filename or a media type can become a
                // second command.
                shell: false,
                cwd: spec.cwd,
                stdio: ['ignore', 'pipe', 'pipe'],
                // Own process group, so a timeout can take down a tool that
                // spawned helpers of its own rather than orphaning them.
                detached: true
            });

            let stdout = '';
            let stderr = '';
            let settled = false;
            const capture = (chunk: Buffer, into: 'out' | 'err'): void => {
                // Keep draining after the cap so the child never blocks on a
                // full pipe; simply stop remembering what it says.
                const current = into === 'out' ? stdout : stderr;
                if (current.length >= this.maxOutputBytes) {
                    return;
                }
                const text = chunk.toString('utf8').slice(0, this.maxOutputBytes - current.length);
                if (into === 'out') {
                    stdout += text;
                } else {
                    stderr += text;
                }
            };
            child.stdout?.on('data', (chunk: Buffer) => capture(chunk, 'out'));
            child.stderr?.on('data', (chunk: Buffer) => capture(chunk, 'err'));

            const killGroup = (): void => {
                try {
                    // Negative pid addresses the whole group created by `detached`.
                    if (child.pid !== undefined) {
                        process.kill(-child.pid, 'SIGKILL');
                    }
                } catch {
                    // Already gone, or the group vanished between the check and
                    // the signal. Either way there is nothing left to kill.
                }
            };

            const timer = setTimeout(() => {
                if (settled) {
                    return;
                }
                settled = true;
                killGroup();
                reject(new ProcessTimeoutError(`${spec.command} überschritt ${spec.timeoutMs} ms.`));
            }, Math.max(spec.timeoutMs, 1));
            timer.unref?.();

            child.on('error', (error: NodeJS.ErrnoException) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                reject(
                    error.code === 'ENOENT'
                        ? new ProcessSpawnError(`${spec.command} ist nicht installiert.`)
                        : new ProcessSpawnError(`${spec.command} konnte nicht gestartet werden.`)
                );
            });

            child.on('close', (code) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                resolve({ code: code ?? -1, stdout, stderr });
            });
        });
    }
}

/**
 * Runs `fn` against a private temporary directory that is removed afterwards,
 * whether `fn` returned, threw, or was abandoned mid-timeout. The `finally` is
 * the entire point: AK-24 asks for temporary files to be gone on every path,
 * and the only way to promise that is to not have a path without one.
 */
export async function withWorkspace<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), 'ltg-attach-'));
    try {
        return await fn(dir);
    } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
}

/**
 * A path inside the workspace with a name the gateway chose.
 *
 * Source-supplied filenames never reach a command line. `attachmentSafety.ts`
 * already rejects path separators and control characters, but a name that
 * merely starts with `-` would still be read as an option by most tools, and
 * defending against that one character at a time is a losing game.
 */
export function workspacePath(dir: string, suffix: string): string {
    return join(dir, `${randomBytes(8).toString('hex')}${suffix}`);
}
