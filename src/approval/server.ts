import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, sep } from 'node:path';
import type { GatewayConfig } from '../config.js';
import { ApprovalConflictError, UnknownActionError, type Orchestrator } from '../core/orchestrator.js';
import type { ActionRecord } from '../core/types.js';
import type { AuditLog } from '../store/auditLog.js';
import { safeEqual } from '../util/hash.js';
import { createLogger, describeError, type Logger } from '../util/log.js';
import {
    API_TAB_ROUTES,
    type ApiAuditResponse,
    type ApiCancelSelectionResponse,
    type ApiHistoryEntry,
    type ApiOkResponse,
    type ApiReselectResponse,
    type ApiSelectResponse,
    type ApiStateResponse
} from './contract.js';

/**
 * The local approval interface (invariant 7).
 *
 * This server is the user's side of the trust boundary and is deliberately not a
 * network service: it binds to loopback by default. Hermes has no route to it —
 * it speaks MCP on a different port with a different credential, and none of the
 * endpoints below are reachable through that interface (invariant: Hermes cannot
 * grant or bypass a local approval).
 *
 * The static shell (the HTML plus the built JS/CSS bundles) is served without the
 * token — it carries no data of its own, and its only job is to render a login
 * form. Every `/api/*` request still carries the token generated on this machine,
 * either as a header once logged in or, for a one-shot link, as a query
 * parameter that the page immediately moves into its own session storage.
 *
 * The server itself stays on `node:http`. The component whose job is to hold the
 * mapping between opaque references and private documents should not pull a
 * framework's dependency tree into the process that reads private documents; the
 * UI framework lives entirely on the other side of the wire, in files this server
 * only ever hands out as bytes.
 *
 * Every response the API produces is pinned to `contract.ts` with `satisfies`.
 * That is what keeps the client's compile-time view of these payloads honest:
 * renaming a field in the domain model breaks this file, and a client template
 * still reading the old name breaks the UI build.
 */
export class ApprovalServer {
    private server?: Server;
    private readonly log: Logger;
    private readonly staticRoot: string;

    constructor(
        private readonly config: GatewayConfig,
        private readonly orchestrator: Orchestrator,
        private readonly audit: AuditLog,
        private readonly uiToken: string,
        logger?: Logger
    ) {
        this.log = (logger ?? createLogger('approval')).child('http');
        this.staticRoot = join(dirname(fileURLToPath(import.meta.url)), 'ui');
    }

    async start(): Promise<void> {
        const settings = this.config.approval;
        this.server = createServer((req, res) => {
            void this.handle(req, res).catch((error) => {
                this.log.error('Unbehandelter Fehler in der Freigabeoberfläche', {
                    error: describeError(error)
                });
                if (!res.headersSent) {
                    sendJson(res, 500, { error: 'internal_error' });
                }
            });
        });
        await new Promise<void>((resolveListen, rejectListen) => {
            this.server!.once('error', rejectListen);
            this.server!.listen(settings.port, settings.host, () => {
                this.server!.removeListener('error', rejectListen);
                resolveListen();
            });
        });
        this.log.info('Freigabeoberfläche aktiv', { url: this.url() });
        if (settings.host !== '127.0.0.1' && settings.host !== 'localhost' && settings.host !== '::1') {
            this.log.warn(
                'Die Freigabeoberfläche ist nicht auf Loopback gebunden. Sie sollte nicht über das Netz erreichbar sein.',
                { host: settings.host }
            );
        }
    }

    /** URL including the token, so the operator can open it directly from the log. */
    url(): string {
        const { host, port } = this.config.approval;
        return `http://${host}:${port}/?token=${this.uiToken}`;
    }

    async stop(): Promise<void> {
        if (!this.server) {
            return;
        }
        await new Promise<void>((resolveClose) => this.server!.close(() => resolveClose()));
        this.server = undefined;
    }

    private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        const path = url.pathname;

        // The static shell carries no data of its own — its only job is to render
        // the login form and, once authenticated, ask the API for everything else.
        // Gating it behind the token as well would make a login screen pointless:
        // the page could never load far enough to show one. The client owns real
        // URLs for its routes (History API, no server-side view state), so a fresh
        // load or a reload on any of them — a bookmark, a shared link, hitting F5 —
        // has to get the same shell back instead of a 404; the client's own router
        // decides from there whether the URL is actually reachable.
        if (req.method === 'GET' && CLIENT_SHELL_PATHS.has(path)) {
            await this.serveShell(res);
            return;
        }
        if (req.method === 'GET' && isAssetPath(path)) {
            await this.serveAsset(res, path.slice(1));
            return;
        }

        // Everything from here on is the API surface and requires the token —
        // as a header from the page's own login flow, or still as a query
        // parameter for a one-shot link (e.g. the URL the gateway prints on
        // startup), which the client immediately moves into session storage.
        if (!this.isAuthorised(req, url)) {
            sendJson(res, 401, { error: 'unauthorized', hint: 'Token fehlt oder ist ungültig.' });
            return;
        }

        if (req.method === 'GET' && path === '/api/state') {
            sendJson(res, 200, {
                actions: this.orchestrator.localPendingActions(),
                selections: this.orchestrator.localOpenSelections(),
                history: this.orchestrator.localHistory(50).map(toHistoryEntry),
                serverTime: new Date().toISOString()
            } satisfies ApiStateResponse);
            return;
        }
        if (req.method === 'GET' && path === '/api/audit') {
            const limit = Number(url.searchParams.get('limit') ?? '100');
            sendJson(res, 200, {
                events: await this.audit.tail(Number.isFinite(limit) ? Math.min(limit, 500) : 100)
            } satisfies ApiAuditResponse);
            return;
        }
        if (req.method === 'POST' && path === '/api/approve') {
            await this.handleApprove(req, res);
            return;
        }
        if (req.method === 'POST' && path === '/api/reject') {
            await this.handleDecision(req, res, false);
            return;
        }
        if (req.method === 'POST' && path === '/api/discard') {
            await this.handleDecision(req, res, true);
            return;
        }
        if (req.method === 'POST' && path === '/api/select') {
            await this.handleSelect(req, res);
            return;
        }
        if (req.method === 'POST' && path === '/api/reselect') {
            const body = await readJsonBody(req);
            const actionId = stringField(body, 'action_id');
            if (!actionId) {
                sendJson(res, 400, { error: 'action_id fehlt' });
                return;
            }
            try {
                const result = await this.orchestrator.requestReselection(actionId);
                sendJson(res, 200, {
                    ok: true,
                    selection_id: result.selectionId
                } satisfies ApiReselectResponse);
            } catch (error) {
                if (error instanceof UnknownActionError) {
                    sendJson(res, 404, { error: error.message });
                    return;
                }
                sendJson(res, 409, { error: describeError(error) });
            }
            return;
        }
        if (req.method === 'POST' && path === '/api/cancel-selection') {
            const body = await readJsonBody(req);
            const selectionId = stringField(body, 'selection_id');
            if (!selectionId) {
                sendJson(res, 400, { error: 'selection_id fehlt' });
                return;
            }
            try {
                const outcome = await this.orchestrator.cancelSelection(selectionId);
                sendJson(res, 200, { ok: true, action: outcome } satisfies ApiCancelSelectionResponse);
            } catch (error) {
                sendJson(res, 409, { error: describeError(error) });
            }
            return;
        }

        sendJson(res, 404, { error: 'not_found' });
    }

    /**
     * Approval requires the binding hash the page displayed. That is what makes an
     * approval specific to the exact resource state, target and payload that were
     * on screen: if anything changed, the hash no longer matches and the user is
     * asked to look again instead of releasing something else.
     */
    private async handleApprove(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const body = await readJsonBody(req);
        const actionId = stringField(body, 'action_id');
        const bindingHash = stringField(body, 'binding_hash');
        if (!actionId || !bindingHash) {
            sendJson(res, 400, { error: 'action_id und binding_hash sind erforderlich.' });
            return;
        }
        try {
            // The decision endpoints answer with nothing but an acknowledgement.
            // The client's next state poll is what actually updates the view, and
            // it is the only path that has to stay correct; echoing the whole
            // local action view here as well would be a second, unused copy of
            // private document metadata on the wire.
            await this.orchestrator.approveAction(actionId, bindingHash);
            sendJson(res, 200, { ok: true } satisfies ApiOkResponse);
        } catch (error) {
            if (error instanceof ApprovalConflictError) {
                sendJson(res, 409, { error: error.message });
                return;
            }
            if (error instanceof UnknownActionError) {
                sendJson(res, 404, { error: error.message });
                return;
            }
            throw error;
        }
    }

    private async handleDecision(
        req: IncomingMessage,
        res: ServerResponse,
        discard: boolean
    ): Promise<void> {
        const body = await readJsonBody(req);
        const actionId = stringField(body, 'action_id');
        if (!actionId) {
            sendJson(res, 400, { error: 'action_id fehlt' });
            return;
        }
        try {
            await this.orchestrator.rejectAction(actionId, discard);
            sendJson(res, 200, { ok: true } satisfies ApiOkResponse);
        } catch (error) {
            if (error instanceof ApprovalConflictError) {
                sendJson(res, 409, { error: error.message });
                return;
            }
            if (error instanceof UnknownActionError) {
                sendJson(res, 404, { error: error.message });
                return;
            }
            throw error;
        }
    }

    private async handleSelect(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const body = await readJsonBody(req);
        const selectionId = stringField(body, 'selection_id');
        const candidateId = stringField(body, 'candidate_id');
        if (!selectionId || !candidateId) {
            sendJson(res, 400, { error: 'selection_id und candidate_id sind erforderlich.' });
            return;
        }
        try {
            const result = await this.orchestrator.resolveSelection(selectionId, candidateId);
            sendJson(res, 200, {
                ok: true,
                reference: result.ref,
                action: result.action
            } satisfies ApiSelectResponse);
        } catch (error) {
            if (error instanceof ApprovalConflictError) {
                sendJson(res, 409, { error: error.message });
                return;
            }
            if (error instanceof UnknownActionError) {
                sendJson(res, 404, { error: error.message });
                return;
            }
            throw error;
        }
    }

    private isAuthorised(req: IncomingMessage, url: URL): boolean {
        const header = req.headers['x-gateway-token'];
        if (typeof header === 'string' && safeEqual(header, this.uiToken)) {
            return true;
        }
        const queryToken = url.searchParams.get('token');
        if (queryToken && safeEqual(queryToken, this.uiToken)) {
            return true;
        }
        return false;
    }

    /**
     * Serves the HTML shell with a fresh style nonce.
     *
     * The client framework applies component styles by inserting `<style>`
     * elements at runtime, which `style-src 'self'` alone forbids — correctly so:
     * the alternative, `'unsafe-inline'`, would also permit any style injected by
     * a document title that made it into the page as markup, and this page renders
     * attacker-influenceable strings by design. A per-response nonce keeps the
     * blanket ban and grants exactly the framework's own styles an exception. It
     * is generated per request and never reused, so it cannot be pre-computed by
     * anything that only got to read an earlier response.
     */
    private async serveShell(res: ServerResponse): Promise<void> {
        const nonce = randomBytes(16).toString('base64');
        try {
            const template = await readFile(join(this.staticRoot, 'index.html'), 'utf8');
            if (!template.includes(NONCE_PLACEHOLDER)) {
                // Without the placeholder the page would load and then silently
                // render unstyled, which on an approval screen is worse than not
                // loading at all: the layout is part of how the user tells the
                // egress facts apart from the model's opinion about them.
                throw new Error(
                    `index.html enthält den Platzhalter ${NONCE_PLACEHOLDER} nicht. Wurde die Oberfläche gebaut?`
                );
            }
            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                ...securityHeaders(nonce)
            });
            res.end(template.replaceAll(NONCE_PLACEHOLDER, nonce));
        } catch (error) {
            this.log.error('Oberfläche nicht auslieferbar', { error: describeError(error) });
            sendJson(res, 500, { error: 'ui_unavailable' });
        }
    }

    /**
     * Serves one built bundle. `name` has already been shape-checked by
     * `isAssetPath`; resolving it and requiring the result to stay inside the
     * asset root is the check that survives someone later loosening that pattern.
     */
    private async serveAsset(res: ServerResponse, name: string): Promise<void> {
        const target = resolve(this.staticRoot, name);
        if (target !== resolve(this.staticRoot) && !target.startsWith(resolve(this.staticRoot) + sep)) {
            sendJson(res, 400, { error: 'invalid_path' });
            return;
        }
        try {
            const content = await readFile(target);
            res.writeHead(200, {
                'Content-Type': name.endsWith('.css')
                    ? 'text/css; charset=utf-8'
                    : 'text/javascript; charset=utf-8',
                ...securityHeaders()
            });
            res.end(content);
        } catch (error) {
            this.log.error('Statische Datei nicht lesbar', { name, error: describeError(error) });
            sendJson(res, 404, { error: 'not_found' });
        }
    }
}

/** Placeholder the built `index.html` carries where the style nonce belongs. */
const NONCE_PLACEHOLDER = '__CSP_NONCE__';

/**
 * The page renders private document metadata: it must not be cached by anything,
 * must not reach out to the network, and must not be framed. `style-src` gets the
 * shell's one-shot nonce; asset responses get no nonce because a stylesheet has
 * no business granting one.
 */
function securityHeaders(nonce?: string): Record<string, string> {
    const styleSrc = nonce ? `'self' 'nonce-${nonce}'` : "'self'";
    return {
        'Cache-Control': 'no-store',
        'Content-Security-Policy': [
            "default-src 'none'",
            "script-src 'self'",
            `style-src ${styleSrc}`,
            "img-src 'none'",
            "font-src 'none'",
            "connect-src 'self'",
            "form-action 'none'",
            // Not 'none'. The shell's routes are nested (`/app/approvals`), its
            // asset references are relative, and `base-uri 'none'` makes the
            // browser ignore the `<base href="/">` that reconciles the two — the
            // bundle then resolves to `/app/main.js` and the page never starts.
            // `'self'` keeps the part that matters, which is that a base URI can
            // never point at another origin.
            "base-uri 'self'",
            "frame-ancestors 'none'"
        ].join('; '),
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY'
    };
}

/**
 * Which request paths may reach a file on disk at all.
 *
 * The bundler names its own output, so unlike the route list below this cannot be
 * a closed set of literals. It is kept as tight as a pattern can be instead: one
 * path segment, no separators, no leading dot, and only the two extensions the
 * shell actually references. Source maps in particular are not servable — they
 * are switched off in the production build, and this makes that the case even if
 * a stray map file ends up in the directory.
 */
const ASSET_PATH = /^\/[A-Za-z0-9][A-Za-z0-9._-]*\.(js|css)$/;

function isAssetPath(path: string): boolean {
    return ASSET_PATH.test(path) && !path.includes('..');
}

/**
 * Narrows a stored action to what the history table shows.
 *
 * Written out field by field rather than passing the record through, because the
 * record also holds the full outgoing body and, for a dynamic-recipient target,
 * the literal address. Neither belongs in a list view, and an explicit projection
 * is the only version of this that stays true when the record grows a field.
 */
function toHistoryEntry(record: ActionRecord): ApiHistoryEntry {
    return {
        actionId: record.actionId,
        resourceRef: record.resourceRef,
        purpose: record.purpose,
        status: record.status,
        statusReason: record.statusReason,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
        decidedAt: record.decidedAt,
        executedAt: record.executedAt,
        localOutcome: record.localOutcome,
        plan:
            record.plan.kind === 'summarize_resource'
                ? {
                      kind: 'summarize_resource',
                      summaryChars: record.plan.summary.length,
                      summarySha256: record.plan.summarySha256,
                      redactions: record.plan.redactions
                  }
                : {
                      kind: 'send_resource',
                      targetId: record.plan.targetId,
                      recipientDisplay: record.plan.recipientDisplay,
                      dynamicRecipient: record.plan.dynamicRecipient,
                      subject: record.plan.subject,
                      attachments: record.plan.attachments
                  },
        judgement: record.judgement
    };
}

/**
 * Every path the client-side router can land on. Kept as an explicit, closed list
 * rather than a wildcard prefix match on `/app/*` — consistent with this project's
 * general preference for closed sets over open-ended matching, and it means a
 * typo'd path 404s instead of silently serving the shell. The tab names come from
 * the shared contract, so the two routers cannot drift into a state where a route
 * works on first click but 404s on reload.
 */
const CLIENT_SHELL_PATHS = new Set<string>([
    '/',
    '/index.html',
    '/login',
    '/app',
    ...API_TAB_ROUTES.map((tab) => `/app/${tab}`)
]);

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify(payload));
}

const MAX_BODY_BYTES = 64 * 1024;

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
        const buffer = chunk as Buffer;
        total += buffer.byteLength;
        if (total > MAX_BODY_BYTES) {
            throw new Error('Anfrage zu groß.');
        }
        chunks.push(buffer);
    }
    if (total === 0) {
        return {};
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        return {};
    }
}

function stringField(body: unknown, field: string): string | undefined {
    if (typeof body !== 'object' || body === null) {
        return undefined;
    }
    const value = (body as Record<string, unknown>)[field];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
