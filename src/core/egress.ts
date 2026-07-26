import type { ActionRecord, ActionStatus, ActionStatusReason, ResourceRecord, ResourceType, TargetDescriptor } from './types.js';

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
 * The one exception is a resource's `safeLabel`, which is a short designation
 * the local model explicitly cleared for egress. It is length-capped and
 * scrubbed here as a second line of defence.
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
    | 'invalid_request';

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
    attachment_too_large: 'Die Ressource überschreitet die Größenbegrenzung dieses Ziels.',
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
    invalid_request: 'Die Anfrage war unvollständig oder ungültig.'
};

export const MAX_SAFE_LABEL_CHARS = 80;

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
}

export interface PublicActionState {
    action_id: string;
    status: ActionStatus;
    reason?: ActionStatusReason;
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
        accepts_attachments: descriptor.supportsAttachments
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

function noteCodeForAction(record: ActionRecord): EgressNoteCode {
    switch (record.status) {
        case 'awaiting_local_approval':
            return 'awaiting_local_approval';
        case 'selection_required':
            return 'selection_required';
        case 'executing':
            return 'action_executing';
        case 'completed':
            return 'action_completed';
        case 'rejected':
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

export function note(code: EgressNoteCode): string {
    return EGRESS_NOTES[code];
}
