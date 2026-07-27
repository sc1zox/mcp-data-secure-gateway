#!/usr/bin/env node
// Dependency-free structural checker for the LLM-agent-repository layer
// (AGENTS.md, CLAUDE.md, .ai-workflow/*.md, docs/wiki/*.md). No network, no
// clock comparisons, no writes. Exits 0 if every rule passes, 1 otherwise.
//
// Five rules, per .hermes/plans/llm-agent-repo-and-refactor.md §A3:
//   1. Every backtick repo-relative path mentioned in AGENTS.md, CLAUDE.md,
//      .ai-workflow/*.md or docs/wiki/*.md exists on disk, or is listed in
//      .gitignore (a path the repo deliberately keeps out of the checkout,
//      e.g. data/, is still a legitimate thing to name).
//   2. Every file under src/**/*.ts appears in .ai-workflow/source-map.md
//      exactly once.
//   3. The numbers 1-14 each appear exactly once as an invariant table row
//      in .ai-workflow/ownership.md.
//   4. Every docs/wiki/*.md file except README.md has a line starting with
//      "Quelle:", and every backtick target on that line is either an
//      existing path or a heading that exists in README.md (slug match).
//   5. Every command inside a ```bash block in AGENTS.md or CLAUDE.md is
//      listed in .ai-workflow/verification.md with a status.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const KNOWN_EXTENSIONS = new Set(['.md', '.ts', '.tsx', '.js', '.mjs', '.json', '.yml', '.yaml']);

const results = [];
function check(id, ok, detail) {
    results.push({ id, ok, detail });
}

function readIfExists(relPath) {
    const full = join(ROOT, relPath);
    return existsSync(full) ? readFileSync(full, 'utf8') : undefined;
}

function listMarkdownFiles(relDir) {
    const full = join(ROOT, relDir);
    if (!existsSync(full)) return [];
    return readdirSync(full)
        .filter((f) => f.endsWith('.md'))
        .map((f) => `${relDir}/${f}`)
        .sort();
}

function walkTsFiles(relDir) {
    const full = join(ROOT, relDir);
    const out = [];
    for (const entry of readdirSync(full, { withFileTypes: true })) {
        const rel = `${relDir}/${entry.name}`;
        if (entry.isDirectory()) {
            out.push(...walkTsFiles(rel));
        } else if (entry.isFile() && entry.name.endsWith('.ts')) {
            out.push(rel);
        }
    }
    return out;
}

const AI_WORKFLOW_DOCS = listMarkdownFiles('.ai-workflow');
const WIKI_DOCS = listMarkdownFiles('docs/wiki');
const DOC_FILES = ['AGENTS.md', 'CLAUDE.md', ...AI_WORKFLOW_DOCS, ...WIKI_DOCS];

const docContents = new Map();
for (const f of DOC_FILES) {
    const content = readIfExists(f);
    if (content !== undefined) {
        docContents.set(f, content);
    }
}

// --- Rule 1: every backtick repo-relative path exists ---------------------
{
    // Paths this repo deliberately keeps out of the checked-out tree (data/,
    // personal .claude/settings.local.json) are still legitimate to name in
    // prose. .gitignore is the record of "expected absent", so a path that
    // matches it is not a fabricated reference.
    const gitignoreLines = (readIfExists('.gitignore') ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#'));

    function isGitignored(bare) {
        return gitignoreLines.includes(bare) || gitignoreLines.includes(`${bare}/`);
    }

    function looksLikePath(token) {
        if (/\s/.test(token)) return false;
        if (token.includes('://')) return false;
        if (token.includes('*')) return false;
        if (token.startsWith('$')) return false;
        if (token.startsWith('node:')) return false;
        // A leading slash names a route or a CLI slash command (/code-review),
        // never a repo-relative path in this codebase's own convention.
        if (token.startsWith('/')) return false;
        if (/[(){}]/.test(token)) return false;
        if (/^\.[a-zA-Z0-9]+$/.test(token) && KNOWN_EXTENSIONS.has(token)) return false;
        if (token.includes('/')) return true;
        if (/^\.[a-zA-Z0-9_.-]+$/.test(token)) return true;
        return KNOWN_EXTENSIONS.has(extname(token.split('#')[0]));
    }

    const failures = [];
    for (const [file, rawContent] of docContents) {
        const content = rawContent.replace(/```[\s\S]*?```/g, '');
        const spanRe = /`([^`\n]+)`/g;
        let m;
        while ((m = spanRe.exec(content)) !== null) {
            const token = m[1].trim();
            if (!looksLikePath(token)) continue;
            const withoutFragment = token.split('#')[0];
            const bare = withoutFragment.endsWith('/') ? withoutFragment.slice(0, -1) : withoutFragment;
            if (bare.length === 0) continue;
            if (existsSync(join(ROOT, bare))) continue;
            if (isGitignored(bare)) continue;
            failures.push(`${file}: ${token}`);
        }
    }
    check('R1', failures.length === 0, failures.length ? `Pfad existiert nicht: ${failures.join(', ')}` : '');
}

// --- Rule 2: every src/**/*.ts file appears in source-map.md exactly once --
{
    const srcFiles = existsSync(join(ROOT, 'src')) ? walkTsFiles('src').sort() : [];
    const mapContent = readIfExists('.ai-workflow/source-map.md') ?? '';

    const missing = [];
    const duplicated = [];
    for (const f of srcFiles) {
        const needle = `\`${f}\``;
        const count = mapContent.split(needle).length - 1;
        if (count === 0) missing.push(f);
        else if (count > 1) duplicated.push(`${f} (${count}x)`);
    }
    const ok = missing.length === 0 && duplicated.length === 0;
    const detailParts = [];
    if (missing.length) detailParts.push(`fehlt in source-map.md: ${missing.join(', ')}`);
    if (duplicated.length) detailParts.push(`mehrfach in source-map.md: ${duplicated.join(', ')}`);
    check('R2', ok, detailParts.join('; '));
}

// --- Rule 3: invariants 1-14 each appear exactly once as a table row ------
{
    const ownershipContent = readIfExists('.ai-workflow/ownership.md') ?? '';
    const rowRe = /^\|\s*(\d{1,2})\s*\|/gm;
    const counts = new Map();
    let m;
    while ((m = rowRe.exec(ownershipContent)) !== null) {
        const n = Number(m[1]);
        counts.set(n, (counts.get(n) ?? 0) + 1);
    }
    const missing = [];
    const duplicated = [];
    for (let n = 1; n <= 14; n += 1) {
        const count = counts.get(n) ?? 0;
        if (count === 0) missing.push(n);
        else if (count > 1) duplicated.push(`${n} (${count}x)`);
    }
    const ok = missing.length === 0 && duplicated.length === 0;
    const detailParts = [];
    if (missing.length) detailParts.push(`fehlt in ownership.md: ${missing.join(', ')}`);
    if (duplicated.length) detailParts.push(`mehrfach in ownership.md: ${duplicated.join(', ')}`);
    check('R3', ok, detailParts.join('; '));
}

// --- Rule 4: every wiki page except README.md has one Quelle: line --------
{
    function slugify(text) {
        return text
            .trim()
            .toLowerCase()
            .replace(/[^\p{L}\p{N}\s-]/gu, '')
            .trim()
            .replace(/\s+/g, '-');
    }

    const readme = readIfExists('README.md') ?? '';
    const headingSlugs = new Set();
    const headingRe = /^#{1,6}\s+(.+)$/gm;
    let hm;
    while ((hm = headingRe.exec(readme)) !== null) {
        headingSlugs.add(slugify(hm[1]));
    }

    const failures = [];
    const pages = WIKI_DOCS.filter((f) => f !== 'docs/wiki/README.md');
    for (const page of pages) {
        const content = docContents.get(page) ?? '';
        const sourceLines = content.split('\n').filter((line) => line.trim().startsWith('Quelle:'));
        if (sourceLines.length !== 1) {
            failures.push(`${page}: ${sourceLines.length} Quelle:-Zeilen (erwartet genau 1)`);
            continue;
        }
        const line = sourceLines[0];
        const targets = [...line.matchAll(/`([^`\n]+)`/g)].map((m) => m[1].trim());
        if (targets.length === 0) {
            failures.push(`${page}: Quelle:-Zeile ohne Backtick-Ziel`);
            continue;
        }
        for (const target of targets) {
            const [pathPart, fragment] = target.split('#');
            if (fragment !== undefined) {
                if (pathPart !== 'README.md' && pathPart !== '') {
                    if (!existsSync(join(ROOT, pathPart))) {
                        failures.push(`${page}: Quelle-Ziel existiert nicht: ${target}`);
                        continue;
                    }
                }
                if (!headingSlugs.has(fragment)) {
                    failures.push(`${page}: Anker nicht in README.md gefunden: ${target}`);
                }
            } else {
                const bare = pathPart.endsWith('/') ? pathPart.slice(0, -1) : pathPart;
                if (!existsSync(join(ROOT, bare))) {
                    failures.push(`${page}: Quelle-Ziel existiert nicht: ${target}`);
                }
            }
        }
    }
    check('R4', failures.length === 0, failures.join('; '));
}

// --- Rule 5: every ```bash command in AGENTS.md/CLAUDE.md is in verification.md
{
    const verification = readIfExists('.ai-workflow/verification.md') ?? '';
    const failures = [];
    for (const file of ['AGENTS.md', 'CLAUDE.md']) {
        const content = docContents.get(file);
        if (content === undefined) continue;
        const blockRe = /```bash\n([\s\S]*?)```/g;
        let bm;
        while ((bm = blockRe.exec(content)) !== null) {
            const lines = bm[1]
                .split('\n')
                .map((l) => l.trim())
                .filter((l) => l.length > 0);
            for (const line of lines) {
                if (!verification.includes(line)) {
                    failures.push(`${file}: "${line}" nicht in verification.md geführt`);
                }
            }
        }
    }
    check('R5', failures.length === 0, failures.join('; '));
}

// --- report ------------------------------------------------------------------
let allOk = true;
for (const { id, ok, detail } of results) {
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${id}`);
    if (!ok) {
        allOk = false;
        console.log(`     ${detail}`);
    }
}

process.exit(allOk ? 0 : 1);
