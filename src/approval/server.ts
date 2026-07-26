import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import type { GatewayConfig } from '../config.js';
import { ApprovalConflictError, UnknownActionError, type Orchestrator } from '../core/orchestrator.js';
import type { AuditLog } from '../store/auditLog.js';
import { safeEqual } from '../util/hash.js';
import { createLogger, describeError, type Logger } from '../util/log.js';

/**
 * The local approval interface (invariant 7).
 *
 * This server is the user's side of the trust boundary and is deliberately not a
 * network service: it binds to loopback by default. Hermes has no route to it —
 * it speaks MCP on a different port with a different credential, and none of the
 * endpoints below are reachable through that interface (invariant: Hermes cannot
 * grant or bypass a local approval).
 *
 * The static shell (`/`, `/app.js`, `/styles.css`) is served without the token —
 * it carries no data of its own, and its only job is to render a login form.
 * Every `/api/*` request still carries the token generated on this machine,
 * either as a header once logged in or, for a one-shot link, as a query
 * parameter that the page immediately moves into its own session storage.
 *
 * Written against `node:http` on purpose. The component whose job is to hold the
 * mapping between opaque references and private documents should not pull in a
 * framework's dependency tree to render four pages.
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
        // the login form and, once submitted, ask the API for everything else.
        // Gating it behind the token as well would make a login screen pointless:
        // the page could never load far enough to show one.
        if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
            await this.serveStatic(res, 'index.html', 'text/html; charset=utf-8');
            return;
        }
        if (req.method === 'GET' && path === '/app.js') {
            await this.serveStatic(res, 'app.js', 'text/javascript; charset=utf-8');
            return;
        }
        if (req.method === 'GET' && path === '/styles.css') {
            await this.serveStatic(res, 'styles.css', 'text/css; charset=utf-8');
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
                history: this.orchestrator.localHistory(50),
                serverTime: new Date().toISOString()
            });
            return;
        }
        if (req.method === 'GET' && path === '/api/audit') {
            const limit = Number(url.searchParams.get('limit') ?? '100');
            sendJson(res, 200, {
                events: await this.audit.tail(Number.isFinite(limit) ? Math.min(limit, 500) : 100)
            });
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
                sendJson(res, 200, { ok: true, selection_id: result.selectionId });
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
                await this.orchestrator.cancelSelection(selectionId);
                sendJson(res, 200, { ok: true });
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
            const view = await this.orchestrator.approveAction(actionId, bindingHash);
            sendJson(res, 200, { ok: true, action: view });
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
            const view = await this.orchestrator.rejectAction(actionId, discard);
            sendJson(res, 200, { ok: true, action: view });
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
            sendJson(res, 200, { ok: true, reference: result.ref });
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

    private async serveStatic(res: ServerResponse, name: string, contentType: string): Promise<void> {
        // `name` is a fixed literal at every call site; normalising and rejecting
        // separators keeps that true if someone later wires it to user input.
        const safeName = normalize(name).replace(/^([.][.][\\/])+/, '');
        if (safeName.includes('/') || safeName.includes('\\')) {
            sendJson(res, 400, { error: 'invalid_path' });
            return;
        }
        try {
            const content = await readFile(join(this.staticRoot, safeName), 'utf8');
            res.writeHead(200, {
                'Content-Type': contentType,
                // The page renders private document metadata; it must not be cached
                // by anything and must not reach out to the network.
                'Cache-Control': 'no-store',
                'Content-Security-Policy':
                    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'none'; connect-src 'self'; form-action 'none'; base-uri 'none'",
                'Referrer-Policy': 'no-referrer',
                'X-Content-Type-Options': 'nosniff',
                'X-Frame-Options': 'DENY'
            });
            res.end(content);
        } catch (error) {
            this.log.error('Statische Datei nicht lesbar', { name: safeName, error: describeError(error) });
            sendJson(res, 500, { error: 'ui_unavailable' });
        }
    }
}

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
