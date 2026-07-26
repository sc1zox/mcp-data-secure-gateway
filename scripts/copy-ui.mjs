// Copies the approval UI's static assets into dist/, since tsc only emits .ts.
import { cp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(projectRoot, 'src', 'approval', 'ui');
const to = join(projectRoot, 'dist', 'approval', 'ui');

await mkdir(to, { recursive: true });
await cp(from, to, { recursive: true });
process.stdout.write(`UI kopiert: ${from} -> ${to}\n`);
