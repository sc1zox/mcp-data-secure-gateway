import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { GatewayConfig } from '../config.js';
import type { Orchestrator } from '../core/orchestrator.js';
import { safeEqual } from '../util/hash.js';
import { createLogger, describeError, type Logger } from '../util/log.js';

/**
 * The gateway's public face.
 *
 * This is the complete surface Hermes can reach. Five tools, all abstract:
 * describe what you want, ask where things may go, prepare something, ask how it
 * went, wait for how it went. There is intentionally no tool to read a document,
 * no tool to download anything, no passthrough to a source's own tools, and no
 * tool that approves (invariants 1, 2, 3, 7).
 *
 * `await_action_decision` is the deliberate answer to "how does the agent learn
 * that the user released something?". It is a wait, not a callback: the gateway
 * never opens a connection outwards on its own initiative, so the direction of
 * every byte that leaves this machine stays a consequence of a request that came
 * in — which is the property a webhook would have given up.
 *
 * The handlers here are thin. Every decision lives in the orchestrator, and every
 * response shape comes from the egress guard, so this file cannot become a second
 * place where the boundary is defined.
 */
export function createHermesServer(orchestrator: Orchestrator, logger?: Logger): McpServer {
    const log = (logger ?? createLogger('mcp')).child('hermes');
    const server = new McpServer(
        { name: 'local-trust-gateway', version: '0.1.0' },
        {
            capabilities: { tools: {} },
            instructions: [
                'Dieses Gateway vermittelt kontrollierten Zugriff auf private Dienste des Nutzers.',
                '',
                'Ablauf: find_resource (Beschreibung + Zweck) liefert eine opake Referenz.',
                'list_targets nennt die erlaubten Ziele. prepare_action verbindet Referenz, Ziel',
                'und Zweck zu einer Aktion, die auf die lokale Freigabe des Nutzers wartet.',
                'get_action_status meldet den Fortschritt, await_action_decision wartet auf die',
                'Entscheidung des Nutzers. Ein Rückruf an den Agenten findet nicht statt: das',
                'Gateway ruft von sich aus nirgends an, es antwortet nur.',
                '',
                'Wichtig: Dokumentinhalte, interne Kennungen und Zugangsdaten sind über dieses',
                'Gateway nicht abrufbar. Jede Übertragung erfordert eine lokale Freigabe durch',
                'den Nutzer; sie kann nicht über dieses Interface erteilt oder beschleunigt werden.',
                'Empfänger sind für die meisten Ziele lokal fest konfiguriert und nicht wählbar.',
                'list_targets meldet pro Ziel dynamic_recipient: bei true verlangt (und erlaubt)',
                'prepare_action zusätzlich einen konkreten recipient; bei false wird ein',
                'angegebener recipient abgelehnt. Auch ein dynamischer Empfänger wird stets',
                'in voller Form in der lokalen Freigabeoberfläche gezeigt und nur nach',
                'ausdrücklicher lokaler Bestätigung genau dieser Adresse verwendet.'
            ].join('\n')
        }
    );

    server.registerTool(
        'find_resource',
        {
            title: 'Ressource suchen',
            description: [
                'Sucht in den privaten Datenquellen des Nutzers nach einer Ressource, die zu einer',
                'natürlichen Beschreibung und einem Zweck passt. Die Auswahl trifft ein lokales',
                'Sprachmodell.',
                '',
                'Ergebnis ist eine opake Referenz (z. B. res_7f29a1c4b8de), niemals der Inhalt und',
                'niemals eine interne Kennung. Ist die Anfrage nicht eindeutig, wird',
                'status="selection_required" mit einer Auswahlreferenz zurückgegeben; der Nutzer',
                'entscheidet dann lokal. Frage danach mit pending_selection erneut an.'
            ].join('\n'),
            inputSchema: {
                query: z
                    .string()
                    .min(1)
                    .max(500)
                    .describe('Beschreibung der gesuchten Ressource in natürlicher Sprache.'),
                purpose: z
                    .string()
                    .min(1)
                    .max(500)
                    .describe(
                        'Wozu die Ressource benötigt wird. Bindend: die Referenz gilt nur für diesen Zweck.'
                    ),
                pending_selection: z
                    .string()
                    .max(64)
                    .optional()
                    .describe('Auswahlreferenz aus einer früheren Antwort mit status="selection_required".')
            },
            annotations: { readOnlyHint: true, openWorldHint: false }
        },
        async (args) => {
            const result = await orchestrator.findResource({
                query: args.query,
                purpose: args.purpose,
                pendingSelection: args.pending_selection
            });
            return jsonResult(result);
        }
    );

    server.registerTool(
        'list_targets',
        {
            title: 'Ziele anzeigen',
            description: [
                'Nennt die lokal konfigurierten Ziele und ihren Zweck. Nur diese abstrakten',
                'Bezeichnungen sind in prepare_action verwendbar. Jedes Ziel meldet',
                'dynamic_recipient: true bedeutet, prepare_action braucht dafür einen',
                'recipient-Parameter; false bedeutet, der Empfänger ist fest und ein',
                'angegebener recipient wird abgelehnt.'
            ].join('\n'),
            annotations: { readOnlyHint: true, openWorldHint: false }
        },
        async () => jsonResult({ targets: orchestrator.listTargets() })
    );

    server.registerTool(
        'prepare_action',
        {
            title: 'Aktion vorbereiten',
            description: [
                'Verbindet eine Ressourcenreferenz mit einem erlaubten Ziel und einem Zweck und',
                'bereitet daraus eine Aktion vor. Es wird nichts übertragen: die Aktion wartet auf',
                'die ausdrückliche lokale Freigabe des Nutzers.',
                '',
                'Der Zweck muss dem Zweck der Suche entsprechen, mit der die Referenz entstanden ist.',
                'recipient ist nur für Ziele mit dynamic_recipient=true zulässig (dort zwingend);',
                'bei jedem anderen Ziel führt ein angegebener recipient zur Ablehnung der Anfrage.',
                '',
                'subject und body sind optional. Werden sie gesetzt, gehen sie unverändert als',
                'Betreff und Nachrichtentext hinaus; ohne sie stellt das Gateway einen neutralen',
                'Hinweistext zusammen. Beides wird dem Nutzer vor der Freigabe vollständig und',
                'als vom Agenten verfasst gekennzeichnet angezeigt und ist Teil der Freigabe-',
                'bindung: nachträglich ist daran nichts mehr änderbar.',
                '',
                'Status danach über get_action_status abfragen oder mit await_action_decision',
                'auf die Entscheidung des Nutzers warten.'
            ].join('\n'),
            inputSchema: {
                reference: z.string().min(1).max(64).describe('Opake Ressourcenreferenz aus find_resource.'),
                target: z
                    .string()
                    .min(1)
                    .max(64)
                    .describe('Abstrakte Zielbezeichnung aus list_targets, z. B. private_mail.'),
                purpose: z
                    .string()
                    .min(1)
                    .max(500)
                    .describe('Zweck der Übertragung. Muss zum Zweck der Suche passen.'),
                note: z
                    .string()
                    .max(500)
                    .optional()
                    .describe(
                        'Optionaler kurzer Hinweis, der der vom Gateway zusammengestellten Nachricht als ' +
                            'ausdrücklich zugeschriebener Agentenhinweis beigefügt wird. Wird ignoriert, ' +
                            'wenn body gesetzt ist — dann ist der gesamte Text ohnehin vom Agenten.'
                    ),
                subject: z
                    .string()
                    .max(200)
                    .optional()
                    .describe(
                        'Betreff der Nachricht, wörtlich übernommen. Ohne Angabe erzeugt das Gateway ' +
                            'einen neutralen Betreff aus der Ressourcenbezeichnung. Zeilenumbrüche ' +
                            'werden entfernt.'
                    ),
                body: z
                    .string()
                    .max(10000)
                    .optional()
                    .describe(
                        'Nachrichtentext, wörtlich übernommen — ohne Zusätze, Fußzeile oder Hinweis ' +
                            'des Gateways. Ohne Angabe stellt das Gateway einen neutralen Text aus ' +
                            'Bezeichnung, Zweck und Zeitpunkt zusammen. Der Nutzer liest den Text ' +
                            'vollständig, bevor er freigibt.'
                    ),
                recipient: z
                    .string()
                    .min(3)
                    .max(320)
                    .email()
                    .optional()
                    .describe(
                        'Konkrete Empfängeradresse. Nur zulässig und erforderlich, wenn list_targets für ' +
                            'dieses Ziel dynamic_recipient=true meldet. Wird vor jeder Übertragung ' +
                            'unverkürzt in der lokalen Freigabeoberfläche angezeigt; ohne deren ' +
                            'ausdrückliche Bestätigung genau dieser Adresse wird nichts versendet.'
                    )
            },
            annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
        },
        async (args) => {
            const result = await orchestrator.prepareAction({
                reference: args.reference,
                target: args.target,
                purpose: args.purpose,
                note: args.note,
                subject: args.subject,
                body: args.body,
                recipient: args.recipient
            });
            return jsonResult(result);
        }
    );

    server.registerTool(
        'get_action_status',
        {
            title: 'Aktionsstatus abrufen',
            description: [
                'Meldet den Status einer vorbereiteten Aktion:',
                'awaiting_local_approval, selection_required, executing, completed, rejected,',
                'failed oder expired. Enthält keine Inhalte und keine Zieldetails.'
            ].join('\n'),
            inputSchema: {
                action_id: z.string().min(1).max(64).describe('Aktionsreferenz aus prepare_action.')
            },
            annotations: { readOnlyHint: true, openWorldHint: false }
        },
        async (args) => jsonResult(orchestrator.getActionStatus(args.action_id))
    );

    server.registerTool(
        'await_action_decision',
        {
            title: 'Auf Entscheidung warten',
            description: [
                'Wartet, bis der Nutzer über eine vorbereitete Aktion entschieden und das Gateway',
                'sie zu Ende geführt hat, und antwortet dann mit demselben Statusobjekt wie',
                'get_action_status. Das ist der vorgesehene Weg, eine Freigabe mitzubekommen:',
                'es gibt keinen Rückruf und keinen Webhook, das Gateway ruft von sich aus nirgends an.',
                '',
                'Antwortet frühestens, wenn die Aktion endgültig ist (completed, rejected, failed,',
                'expired). Läuft das Zeitfenster vorher ab, kommt der aktuelle Zwischenstand',
                '(in der Regel awaiting_local_approval) zurück; der Aufruf kann dann einfach',
                'wiederholt werden. Warten beschleunigt oder ersetzt die lokale Freigabe nicht.'
            ].join('\n'),
            inputSchema: {
                action_id: z.string().min(1).max(64).describe('Aktionsreferenz aus prepare_action.'),
                timeout_seconds: z
                    .number()
                    .int()
                    .min(1)
                    .max(600)
                    .optional()
                    .describe('Maximale Wartezeit in Sekunden (Standard 60, Obergrenze 600).')
            },
            annotations: { readOnlyHint: true, openWorldHint: false }
        },
        async (args) =>
            jsonResult(await orchestrator.awaitActionDecision(args.action_id, args.timeout_seconds))
    );

    log.debug('MCP-Server für Hermes aufgebaut');
    return server;
}

/**
 * MCP tool results carry text content. The payload is serialised JSON so Hermes
 * gets a stable shape, and it has already passed the egress guard inside the
 * orchestrator.
 */
function jsonResult(payload: unknown): { content: Array<{ type: 'text'; text: string }> } {
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

/** Connects the server to stdio, for the case where Hermes spawns the gateway. */
export async function serveStdio(server: McpServer, logger?: Logger): Promise<void> {
    const log = (logger ?? createLogger('mcp')).child('stdio');
    await server.connect(new StdioServerTransport());
    log.info('MCP-Schnittstelle über stdio aktiv');
}

/**
 * Serves the MCP endpoint over Streamable HTTP.
 *
 * Three gates run before the MCP layer sees a request: a bearer token compared in
 * constant time, an optional Host allow-list, and binding to the configured
 * interface. The token is mandatory at config level, because an open endpoint here
 * would expose the entire private-source surface to anyone who can reach the port.
 *
 * A transport instance in stateful mode belongs to exactly one MCP session, so one
 * is created per `initialize` and retired when the session closes. Sharing a single
 * instance would make the gateway reject Hermes after its first reconnect.
 */
export async function serveHttp(
    createServerInstance: () => McpServer,
    config: GatewayConfig,
    logger?: Logger
): Promise<{ close: () => Promise<void> }> {
    const log = (logger ?? createLogger('mcp')).child('http');
    const settings = config.hermesInterface.http;
    const expectedToken = settings.bearerToken;
    if (!expectedToken) {
        throw new Error('HTTP-Transport ohne bearerToken ist nicht zulässig.');
    }

    const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();

    const httpServer: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
        void (async () => {
            const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
            if (url.pathname !== settings.path) {
                respond(res, 404, { error: 'not_found' });
                return;
            }
            if (!isAuthorised(req, expectedToken)) {
                log.warn('MCP-Anfrage ohne gültiges Token abgewiesen', {
                    remote: req.socket.remoteAddress
                });
                respond(res, 401, { error: 'unauthorized' });
                return;
            }
            if (settings.allowedHosts.length > 0 && !settings.allowedHosts.includes(req.headers.host ?? '')) {
                respond(res, 403, { error: 'forbidden_host' });
                return;
            }

            const sessionId = headerValue(req, 'mcp-session-id');
            try {
                if (sessionId) {
                    const existing = sessions.get(sessionId);
                    if (!existing) {
                        respond(res, 404, { error: 'unknown_session' });
                        return;
                    }
                    await existing.transport.handleRequest(req, res);
                    return;
                }

                // No session yet: only an `initialize` may open one.
                const body = await readJsonBody(req);
                if (!isInitializeRequest(body)) {
                    respond(res, 400, { error: 'missing_session' });
                    return;
                }

                const transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: () => randomUUID(),
                    allowedHosts: settings.allowedHosts.length > 0 ? settings.allowedHosts : undefined,
                    enableDnsRebindingProtection: settings.allowedHosts.length > 0,
                    onsessioninitialized: (newSessionId) => {
                        sessions.set(newSessionId, { transport, server });
                        log.info('MCP-Sitzung eröffnet', { sessionId: newSessionId, open: sessions.size });
                    },
                    onsessionclosed: (closedSessionId) => {
                        sessions.delete(closedSessionId);
                        log.info('MCP-Sitzung beendet', { sessionId: closedSessionId, open: sessions.size });
                    }
                });
                const server = createServerInstance();
                transport.onclose = () => {
                    if (transport.sessionId) {
                        sessions.delete(transport.sessionId);
                    }
                };
                await server.connect(transport);
                await transport.handleRequest(req, res, body);
            } catch (error) {
                log.error('Fehler bei der Verarbeitung einer MCP-Anfrage', {
                    error: describeError(error)
                });
                if (!res.headersSent) {
                    respond(res, 500, { error: 'internal_error' });
                }
            }
        })();
    });

    await new Promise<void>((resolveListen, rejectListen) => {
        httpServer.once('error', rejectListen);
        httpServer.listen(settings.port, settings.host, () => {
            httpServer.removeListener('error', rejectListen);
            resolveListen();
        });
    });
    log.info('MCP-Schnittstelle über HTTP aktiv', {
        url: `http://${settings.host}:${settings.port}${settings.path}`,
        dnsRebindingProtection: settings.allowedHosts.length > 0
    });

    return {
        close: async () => {
            await new Promise<void>((resolveClose) => httpServer.close(() => resolveClose()));
            for (const session of sessions.values()) {
                await session.transport.close();
            }
            sessions.clear();
        }
    };
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
    const value = req.headers[name];
    if (typeof value === 'string' && value.length > 0) {
        return value;
    }
    return Array.isArray(value) ? value[0] : undefined;
}

/** Body cap: an MCP request to this gateway is a few hundred bytes of intent. */
const MAX_MCP_BODY_BYTES = 256 * 1024;

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
        const buffer = chunk as Buffer;
        total += buffer.byteLength;
        if (total > MAX_MCP_BODY_BYTES) {
            throw new Error('MCP-Anfrage zu groß.');
        }
        chunks.push(buffer);
    }
    if (total === 0) {
        return undefined;
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        return undefined;
    }
}

function isAuthorised(req: IncomingMessage, expectedToken: string): boolean {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.toLowerCase().startsWith('bearer ')) {
        return false;
    }
    return safeEqual(header.slice(7).trim(), expectedToken);
}

function respond(res: ServerResponse, status: number, payload: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
}
