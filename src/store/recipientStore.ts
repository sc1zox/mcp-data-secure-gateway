import { sha256Text } from '../util/hash.js';
import { JsonlStore, storePath } from './jsonlStore.js';

/**
 * Which dynamic recipients the user has already vouched for.
 *
 * A target configured with `allowDynamicRecipient` lets the agent name the
 * address, and the user approves it by reading it. The second time the same
 * address comes round that reading is a formality; the *first* time it is the
 * whole decision. This store is what lets the approval view tell the two apart,
 * so a never-seen address can be presented as the exception it is instead of
 * looking like every other prepared action.
 *
 * Addresses are stored as digests. Equality is the only question ever asked of
 * this file, and a plaintext list of everyone the user has ever mailed is a
 * record worth not creating — especially one with no expiry.
 */
interface KnownRecipient {
    /** `sha256(targetId + '\0' + address)`. Scoped per target on purpose. */
    id: string;
    /** When it was first approved. Local only, for later inspection. */
    firstApprovedAt: string;
}

export class RecipientStore {
    private readonly store: JsonlStore<KnownRecipient>;

    constructor(dataDir: string) {
        this.store = new JsonlStore<KnownRecipient>(
            storePath(dataDir, 'recipients'),
            (record) => record.id
        );
    }

    async load(): Promise<void> {
        await this.store.load();
    }

    /** True when this exact address was approved for this target before. */
    isKnown(targetId: string, address: string): boolean {
        return this.store.get(identify(targetId, address)) !== undefined;
    }

    /**
     * Records an address as vouched for. Called when the user approves, not
     * when delivery succeeds: what makes an address known is that a person read
     * it and said yes, and a transport failure afterwards does not undo that.
     */
    async remember(targetId: string, address: string): Promise<void> {
        const id = identify(targetId, address);
        if (this.store.get(id)) {
            return;
        }
        await this.store.put({ id, firstApprovedAt: new Date().toISOString() });
    }
}

function identify(targetId: string, address: string): string {
    return sha256Text(`${targetId}\0${address.trim().toLowerCase()}`);
}
