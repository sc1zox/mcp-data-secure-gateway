import { randomBytes } from 'node:crypto';

/**
 * Opaque identifiers handed out across the trust boundary.
 *
 * They carry no information about the underlying resource: no source name, no
 * native id, no path. The only way to resolve one is the local reference store.
 * They are generated from a CSPRNG so Hermes cannot enumerate or guess handles
 * it was never given.
 */
function opaqueId(prefix: string, bytes: number): string {
    return `${prefix}_${randomBytes(bytes).toString('hex')}`;
}

/** Reference to a private resource, e.g. `res_7f29a1c4b8de`. */
export function newResourceRef(): string {
    return opaqueId('res', 6);
}

/** Reference to a prepared action, e.g. `act_39fb2c7d1a05`. */
export function newActionId(): string {
    return opaqueId('act', 6);
}

/** Reference to a pending local selection, e.g. `sel_4c1e88b2`. */
export function newSelectionId(): string {
    return opaqueId('sel', 6);
}

/** Local-only correlation id for audit entries. */
export function newEventId(): string {
    return opaqueId('evt', 8);
}

/** Local-only id for a single search invocation. */
export function newQueryId(): string {
    return opaqueId('qry', 6);
}
