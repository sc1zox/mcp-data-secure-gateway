import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Append-only, single-writer record store backed by one JSONL file per
 * collection, with the latest version of each key held in memory.
 *
 * Deliberately dependency-free: the gateway is the component that holds the
 * mapping from opaque references to real documents, and every native module in
 * its dependency tree is attack surface for that mapping. A single local user
 * with a few hundred live references does not need a database.
 *
 * Durability model: every mutation is appended and awaited before the caller
 * continues, so a crash can lose at most an in-flight write, never reorder
 * history. Writes are serialised through a promise chain because interleaved
 * `appendFile` calls could otherwise split a line.
 */
export class JsonlStore<T extends object> {
    private readonly index = new Map<string, T>();
    private writeChain: Promise<void> = Promise.resolve();
    private loaded = false;

    constructor(
        private readonly filePath: string,
        private readonly keyOf: (record: T) => string
    ) {}

    async load(): Promise<void> {
        await mkdir(dirname(this.filePath), { recursive: true });
        this.index.clear();
        if (existsSync(this.filePath)) {
            const content = await readFile(this.filePath, 'utf8');
            let lineNumber = 0;
            for (const line of content.split('\n')) {
                lineNumber += 1;
                const trimmed = line.trim();
                if (trimmed.length === 0) {
                    continue;
                }
                let parsed: unknown;
                try {
                    parsed = JSON.parse(trimmed);
                } catch {
                    // A torn final line from an interrupted write is expected and
                    // recoverable; anything else would be corruption we cannot
                    // silently repair, so surface it.
                    throw new Error(
                        `Beschädigte Zeile ${lineNumber} in ${this.filePath}. Datei manuell prüfen.`
                    );
                }
                if (isTombstone(parsed)) {
                    this.index.delete(parsed.__deleted);
                    continue;
                }
                const record = parsed as T;
                this.index.set(this.keyOf(record), record);
            }
        }
        this.loaded = true;
    }

    private assertLoaded(): void {
        if (!this.loaded) {
            throw new Error(`Store ${this.filePath} wurde nicht geladen.`);
        }
    }

    get(key: string): T | undefined {
        this.assertLoaded();
        return this.index.get(key);
    }

    has(key: string): boolean {
        this.assertLoaded();
        return this.index.has(key);
    }

    all(): T[] {
        this.assertLoaded();
        return [...this.index.values()];
    }

    /** Inserts or replaces a record. The in-memory index only updates once the append succeeded. */
    async put(record: T): Promise<void> {
        this.assertLoaded();
        const key = this.keyOf(record);
        await this.append(JSON.stringify(record));
        this.index.set(key, record);
    }

    async delete(key: string): Promise<void> {
        this.assertLoaded();
        if (!this.index.has(key)) {
            return;
        }
        await this.append(JSON.stringify({ __deleted: key }));
        this.index.delete(key);
    }

    private append(line: string): Promise<void> {
        const next = this.writeChain.then(() => appendFile(this.filePath, `${line}\n`, 'utf8'));
        // Keep the chain alive even after a failed write so later writes still run,
        // while still propagating the error to this caller.
        this.writeChain = next.catch(() => undefined);
        return next;
    }

    /**
     * Rewrites the file so it contains exactly the live records. Called on
     * startup after expiry pruning, which is the only point where the log is
     * guaranteed to have no concurrent readers.
     */
    async compact(): Promise<void> {
        this.assertLoaded();
        const snapshot = [...this.index.values()];
        const temporaryPath = `${this.filePath}.tmp`;
        await this.writeChain;
        const payload = snapshot.map((record) => JSON.stringify(record)).join('\n');
        await writeFile(temporaryPath, payload.length > 0 ? `${payload}\n` : '', 'utf8');
        await rename(temporaryPath, this.filePath);
    }
}

function isTombstone(value: unknown): value is { __deleted: string } {
    return (
        typeof value === 'object' &&
        value !== null &&
        typeof (value as { __deleted?: unknown }).__deleted === 'string'
    );
}

export function storePath(dataDir: string, name: string): string {
    return join(dataDir, `${name}.jsonl`);
}
