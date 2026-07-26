import {
    REDACTION_PLACEHOLDERS,
    type ActionRecord,
    type ActionStatus,
    type ActionStatusReason,
    type RedactionPlaceholder,
    type ResourceRecord,
    type ResourceType,
    type TargetDescriptor
} from './types.js';

/**
 * The only place where data is shaped for Hermes.
 *
 * Two mechanisms work together here:
 *
 *  1. Construction by whitelist. Public payloads are built field by field from
 *     named inputs. No source response, resource record or action record is ever
 *     spread or serialised wholesale, so a new internal field cannot leak by
 *     being added to a type somewhere else.
 *
 *  2. A closed catalogue of prose. Every human-readable string Hermes receives
 *     comes from `EGRESS_NOTES` below. Free text is what would let a document's
 *     content — or a local model that has read that content — narrate itself
 *     across the boundary, so the boundary simply does not carry free text.
 *
 * There are exactly two exceptions, and both are model-authored text that a
 * human cleared:
 *
 *  - a resource's `safeLabel`, a short designation, length-capped and scrubbed
 *    here as a second line of defence;
 *  - a redacted summary, which is the entire point of `summarize_resource` and
 *    is the only free text that ever crosses this boundary. It crosses only
 *    after the user read the exact characters in the approval view and released
 *    them, and it passes the same guard as everything else on the way out.
 */

export type EgressNoteCode =
    | 'resource_resolved'
    | 'selection_required'
    | 'selection_pending'
    | 'selection_resolved'
    | 'not_found'
    | 'ambiguous_no_candidates'
    | 'source_unavailable'
    | 'local_model_unavailable'
    | 'purpose_mismatch'
    | 'reference_unknown'
    | 'reference_expired'
    | 'target_unknown'
    | 'target_unavailable'
    | 'recipient_required'
    | 'recipient_not_allowed'
    | 'attachment_too_large'
    | 'awaiting_local_approval'
    | 'action_executing'
    | 'action_completed'
    | 'action_rejected'
    | 'action_discarded'
    | 'action_expired'
    | 'action_failed'
    | 'resource_changed'
    | 'action_unknown'
    | 'invalid_request'
    | 'summary_awaiting_approval'
    | 'summary_released'
    | 'summary_not_released'
    | 'summary_rejected'
    | 'summary_no_text'
    | 'summary_unusable';

/**
 * Canned German notes. Wording is intentionally about the workflow and never
 * about the content: "die Ressource ist nicht eindeutig" tells Hermes what to do
 * next without revealing what was found.
 */
export const EGRESS_NOTES: Record<EgressNoteCode, string> = {
    resource_resolved: 'Eine passende Ressource wurde lokal ausgewählt und ist unter der Referenz ansprechbar.',
    selection_required:
        'Die Anfrage ist nicht eindeutig. Der Nutzer muss die Ressource lokal auswählen. Später mit derselben Auswahlreferenz erneut anfragen.',
    selection_pending: 'Die lokale Auswahl steht noch aus.',
    selection_resolved: 'Der Nutzer hat lokal eine Ressource ausgewählt.',
    not_found: 'Zu dieser Beschreibung wurde keine Ressource gefunden.',
    ambiguous_no_candidates:
        'Es konnte keine eindeutige Ressource bestimmt werden. Eine genauere Beschreibung kann helfen.',
    source_unavailable: 'Die private Datenquelle ist derzeit nicht erreichbar.',
    local_model_unavailable:
        'Die lokale semantische Bewertung ist derzeit nicht möglich. Es erfolgt keine Ersatzbewertung.',
    purpose_mismatch:
        'Die Referenz wurde für einen anderen Zweck erstellt. Für diesen Zweck ist eine neue Suche nötig.',
    reference_unknown: 'Die Referenz ist unbekannt.',
    reference_expired: 'Die Referenz ist abgelaufen. Eine neue Suche ist nötig.',
    target_unknown: 'Dieses Ziel ist nicht konfiguriert.',
    target_unavailable: 'Das Ziel ist derzeit nicht verfügbar.',
    recipient_required:
        'Dieses Ziel erfordert eine gültige Empfängeradresse in prepare_action; sie fehlt oder ist ungültig.',
    recipient_not_allowed: 'Für dieses Ziel ist kein Empfänger angebbar; er ist lokal fest konfiguriert.',
    attachment_too_large: 'Die Anhänge überschreiten die Größenbegrenzung dieses Ziels.',
    awaiting_local_approval: 'Die Aktion ist vorbereitet und wartet auf die lokale Freigabe.',
    action_executing: 'Die Aktion wurde freigegeben und wird ausgeführt.',
    action_completed: 'Die Aktion wurde abgeschlossen.',
    action_rejected: 'Die Freigabe wurde abgelehnt.',
    action_discarded: 'Die Aktion wurde verworfen und muss neu vorbereitet werden.',
    action_expired: 'Die Aktion ist ohne Entscheidung abgelaufen.',
    action_failed: 'Die Ausführung ist fehlgeschlagen.',
    resource_changed:
        'Die Ressource hat sich seit der Vorbereitung geändert. Die Aktion muss neu vorbereitet werden.',
    action_unknown: 'Diese Aktionsreferenz ist unbekannt.',
    invalid_request: 'Die Anfrage war unvollständig oder ungültig.',
    summary_awaiting_approval:
        'Eine redigierte Zusammenfassung wurde lokal erstellt und liegt dem Nutzer zur Prüfung vor. ' +
        'Der Text wird erst nach dessen Freigabe herausgegeben; danach ist er mit get_summary abrufbar.',
    summary_released: 'Der Nutzer hat die Zusammenfassung freigegeben.',
    summary_not_released:
        'Für diese Aktion liegt keine freigegebene Zusammenfassung vor. Der Text wird nicht herausgegeben.',
    summary_rejected: 'Der Nutzer hat die Zusammenfassung nicht freigegeben.',
    summary_no_text: 'Zu dieser Ressource liegt kein auswertbarer Text für eine Zusammenfassung vor.',
    summary_unusable:
        'Die lokal erstellte Zusammenfassung hat die lokale Prüfung nicht bestanden und wurde verworfen. ' +
        'Sie wird nicht zur Freigabe vorgelegt.'
};

export const MAX_SAFE_LABEL_CHARS = 80;

/**
 * Upper bound on a summary. A summary is context, not a copy: a cap is what
 * keeps `summarize_resource` from becoming a way to read a document out of the
 * gateway one approval at a time.
 */
export const MAX_SUMMARY_CHARS = 1800;

/** Resource shape crossing the boundary: a handle, a designation, a kind. */
export interface PublicResourceRef {
    reference: string;
    label: string;
    type: ResourceType;
}

export type PublicFindResult =
    | { status: 'resolved'; resource: PublicResourceRef; note: string }
    | { status: 'selection_required'; selection_reference: string; note: string }
    | { status: 'selection_pending'; selection_reference: string; note: string }
    | { status: 'not_found'; note: string }
    | { status: 'unavailable'; note: string };

export interface PublicTarget {
    target: string;
    purpose: string;
    accepts_attachments: boolean;
    /** True when `prepare_action` for this target requires a `recipient`. */
    dynamic_recipient: boolean;
    /** Maximum number of opaque references accepted by one action. */
    max_attachments: number;
}

export interface PublicActionState {
    action_id: string;
    status: ActionStatus;
    reason?: ActionStatusReason;
    note: string;
}

/**
 * A released summary on its way to the agent.
 *
 * `summary` is the only field in this file whose contents the gateway did not
 * choose from a closed catalogue. It is here because a human read those exact
 * characters and pressed the button, and it still passes `EgressGuard` on the
 * way out like everything else.
 */
export interface PublicSummary {
    action_id: string;
    status: ActionStatus;
    /** Present only when the user released it. */
    summary?: string;
    /** Which categories of detail were removed, so the agent knows what it lacks. */
    redactions?: RedactionPlaceholder[];
    note: string;
}

/**
 * Strings that must never appear in anything sent to Hermes: source tokens,
 * SMTP credentials, bot tokens, base URLs of private services, the approval UI
 * secret. Registered at startup from the config.
 */
export class EgressGuard {
    private readonly secrets: string[] = [];

    /** Secrets shorter than this are ignored: matching them would flag ordinary text. */
    private static readonly MIN_SECRET_LENGTH = 6;

    registerSecret(value: string | undefined): void {
        if (!value || value.length < EgressGuard.MIN_SECRET_LENGTH) {
            return;
        }
        if (!this.secrets.includes(value)) {
            this.secrets.push(value);
        }
    }

    /**
     * Last-resort check on a fully built public payload. Reaching this with a
     * finding means an earlier layer is broken, so it throws rather than
     * redacting: silently shipping a partially scrubbed payload would hide the
     * bug and still leak the rest.
     */
    assertClean(payload: unknown, context: string): void {
        const serialised = JSON.stringify(payload ?? null);
        for (const secret of this.secrets) {
            if (serialised.includes(secret)) {
                throw new EgressViolationError(
                    `Ausgabe an Hermes (${context}) enthält ein registriertes Geheimnis. Übertragung abgebrochen.`
                );
            }
        }
        const suspicious = findSuspiciousPattern(serialised);
        if (suspicious) {
            throw new EgressViolationError(
                `Ausgabe an Hermes (${context}) enthält ein verbotenes Muster (${suspicious}). Übertragung abgebrochen.`
            );
        }
    }
}

export class EgressViolationError extends Error {}

/**
 * Structural patterns that have no business in an abstract answer: absolute
 * URLs, Windows and POSIX paths, and Paperless-style API routes. Opaque
 * references (`res_…`, `act_…`, `sel_…`) are hex and match none of these.
 */
const SUSPICIOUS_PATTERNS: Array<[string, RegExp]> = [
    ['URL', /\bhttps?:\/\//i],
    ['Windows-Pfad', /\b[A-Za-z]:[\\/]/],
    ['UNC-Pfad', /\\\\[A-Za-z0-9_.-]+\\/],
    ['POSIX-Pfad', /(^|[\s"'(])\/(?:home|root|etc|var|usr|mnt|media|opt|tmp|srv)\//],
    ['API-Pfad', /\/api\/[a-z_]+/i],
    ['Datei-URI', /\bfile:\/\//i]
];

function findSuspiciousPattern(serialised: string): string | undefined {
    for (const [name, pattern] of SUSPICIOUS_PATTERNS) {
        if (pattern.test(serialised)) {
            return name;
        }
    }
    return undefined;
}

/**
 * Normalises a model-proposed label: collapses whitespace, strips characters
 * that could carry structure (quotes, braces, path separators) and truncates.
 * A label is a designation, not a sentence and not a locator.
 */
export function sanitiseLabel(raw: string): string {
    const collapsed = raw
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/[<>{}[\]"'`\\|/]+/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
    if (collapsed.length <= MAX_SAFE_LABEL_CHARS) {
        return collapsed;
    }
    return `${collapsed.slice(0, MAX_SAFE_LABEL_CHARS - 1).trimEnd()}…`;
}

/**
 * Normalises a model-written summary into the exact characters that would be
 * shown and, later, sent.
 *
 * Shown and sent must be the same string, so this runs once, before the text is
 * ever stored — not again on the way out. Control characters go rather than get
 * escaped, for the same reason as in an outgoing mail body: they are invisible
 * in the approval view, and an approval screen whose job is to display precisely
 * what leaves cannot contain characters the reader has no way of seeing.
 */
export function sanitiseSummary(raw: string): string {
    const normalised = raw
        .replace(/\r\n?/g, '\n')
        // Everything in Unicode’s "other" category except the newline: control
        // characters, but also zero-width and bidi-override characters, which could
        // make the approval view render something other than what is sent.
        .replace(/[^\P{C}\n]/gu, '')
        .replace(/[ \t]+$/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    if (normalised.length <= MAX_SUMMARY_CHARS) {
        return normalised;
    }
    return `${normalised.slice(0, MAX_SUMMARY_CHARS - 1).trimEnd()}…`;
}

/** Which of the allowed placeholders a summary actually uses, in fixed order. */
export function placeholdersIn(summary: string): RedactionPlaceholder[] {
    return REDACTION_PLACEHOLDERS.filter((placeholder) => summary.includes(`[${placeholder}]`));
}

/**
 * Something in a summary that looks like it should have been redacted and was
 * not. Local only: it exists to be put in front of the user, never to be
 * reported to the agent.
 */
export interface ResidualFinding {
    /** Short German label of what the pattern looks like. */
    kind: string;
    /** The matching text, for the approval view to point at. */
    sample: string;
}

/**
 * Patterns that a redacted summary should no longer contain.
 *
 * This is a second opinion, not a filter. The local model was asked to remove
 * these things and says it did; a regex that agrees proves nothing, but a regex
 * that disagrees is worth putting in front of the person about to release the
 * text. Findings are therefore surfaced loudly in the approval view and never
 * used to auto-approve anything.
 */
const RESIDUAL_PATTERNS: Array<[string, RegExp]> = [
    ['E-Mail-Adresse', /[^\s@]+@[^\s@]+\.[A-Za-z]{2,}/],
    ['IBAN', /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/],
    // Anchored on `+` or a leading zero rather than on "digits, separator,
    // digits": the loose form flags any sentence with two numbers in it, and a
    // detector that cries wolf is one the user learns to click past.
    ['Telefonnummer', /(?:\+|\b0)\d[\d\s/()-]{6,}\d/],
    ['Geldbetrag', /\d[\d.]*,\d{2}\s?(?:€|EUR)|(?:€|EUR)\s?\d/],
    // A long unbroken run, or groups joined by punctuation — file numbers,
    // customer numbers and precise dates look like this; prose does not.
    ['Nummer oder Kennzeichen', /\b\d{6,}\b|\b\d{2,}[./-]\d{2,}(?:[./-]\d{2,})?\b/]
];

/**
 * Unknown bracketed tokens. The model is told to use the closed placeholder set;
 * anything else in brackets is either an invented placeholder or, worse, real
 * content the model bracketed instead of removing.
 */
const BRACKETED = /\[([^\]\n]{1,80})\]/g;

export function findResiduals(summary: string): ResidualFinding[] {
    const findings: ResidualFinding[] = [];
    for (const [kind, pattern] of RESIDUAL_PATTERNS) {
        const match = pattern.exec(summary);
        if (match) {
            findings.push({ kind, sample: match[0].trim().slice(0, 60) });
        }
    }
    for (const match of summary.matchAll(BRACKETED)) {
        const token = match[1]!;
        if (!(REDACTION_PLACEHOLDERS as readonly string[]).includes(token)) {
            findings.push({ kind: 'unbekannter Platzhalter', sample: match[0].slice(0, 60) });
        }
    }
    return findings;
}

/** Builds the public view of a stored reference. */
export function publicResourceRef(record: ResourceRecord): PublicResourceRef {
    return {
        reference: record.ref,
        label: sanitiseLabel(record.safeLabel),
        type: record.type
    };
}

export function publicTarget(descriptor: TargetDescriptor): PublicTarget {
    return {
        target: descriptor.id,
        purpose: descriptor.purpose,
        accepts_attachments: descriptor.supportsAttachments,
        dynamic_recipient: descriptor.dynamicRecipient,
        max_attachments: descriptor.maxAttachments ?? 1
    };
}

/**
 * Maps an action's internal state onto the closed status vocabulary. Note the
 * absence of any local detail: no recipient, no subject, no attachment names,
 * no delivery ids.
 */
export function publicActionState(record: ActionRecord): PublicActionState {
    const state: PublicActionState = {
        action_id: record.actionId,
        status: record.status,
        note: EGRESS_NOTES[noteCodeForAction(record)]
    };
    if (record.statusReason) {
        state.reason = record.statusReason;
    }
    return state;
}

/**
 * The note tells the agent what to do next, so it has to distinguish the two
 * kinds of action: an approved transfer is finished business, while an approved
 * summary is a text now waiting to be collected.
 */
function noteCodeForAction(record: ActionRecord): EgressNoteCode {
    const summarising = record.plan.kind === 'summarize_resource';
    switch (record.status) {
        case 'awaiting_local_approval':
            return summarising ? 'summary_awaiting_approval' : 'awaiting_local_approval';
        case 'selection_required':
            return 'selection_required';
        case 'executing':
            return 'action_executing';
        case 'completed':
            return summarising ? 'summary_released' : 'action_completed';
        case 'rejected':
            if (summarising) {
                return 'summary_rejected';
            }
            return record.statusReason === 'user_discarded' ? 'action_discarded' : 'action_rejected';
        case 'expired':
            return 'action_expired';
        case 'failed':
            return failureNote(record.statusReason);
    }
}

function failureNote(reason: ActionStatusReason | undefined): EgressNoteCode {
    switch (reason) {
        case 'resource_changed':
            return 'resource_changed';
        case 'resource_expired':
            return 'reference_expired';
        case 'source_unavailable':
            return 'source_unavailable';
        case 'local_model_unavailable':
            return 'local_model_unavailable';
        case 'target_unavailable':
            return 'target_unavailable';
        default:
            return 'action_failed';
    }
}

/**
 * Builds the answer to `get_summary`.
 *
 * The text is only ever attached for a released summary. Every other status
 * yields the same shape with the field simply absent — not an empty string, not
 * a partial text, and not an explanation of what the summary would have said.
 */
export function publicSummary(record: ActionRecord): PublicSummary {
    const state: PublicSummary = {
        action_id: record.actionId,
        status: record.status,
        note: EGRESS_NOTES[noteCodeForAction(record)]
    };
    if (record.status === 'completed' && record.plan.kind === 'summarize_resource') {
        state.summary = record.plan.summary;
        state.redactions = record.plan.redactions;
    }
    return state;
}

export function note(code: EgressNoteCode): string {
    return EGRESS_NOTES[code];
}
