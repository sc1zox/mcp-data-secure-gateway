import { DestroyRef, Injectable, computed, effect, inject, signal } from '@angular/core';
import type { ApiActionView, ApiHistoryEntry, ApiSelectionView, ApiStateResponse } from '@gateway/contract';
import { GatewayApi, describeApiError } from './gateway-api';
import { Session } from './session';

const POLL_INTERVAL_MS = 2000;

export type ConnectionState = 'connecting' | 'online' | 'offline';

/**
 * The dashboard's view of the gateway, kept current by polling.
 *
 * Polling rather than a stream because the thing being watched is a local process
 * on loopback and the payload is small; a dropped connection then needs no
 * reconnect logic, just a poll that fails and one that later succeeds.
 *
 * Two details matter more than they look. Polling stops while the tab is hidden —
 * the interface exists to be read by a person, and there is no one to read it. And
 * a failed poll leaves the last known data on screen while flipping the connection
 * indicator: blanking the list would suggest the pending approvals went away,
 * which is the opposite of what a lost connection means.
 */
@Injectable({ providedIn: 'root' })
export class GatewayState {
    private readonly api = inject(GatewayApi);
    private readonly session = inject(Session);

    private readonly _actions = signal<ApiActionView[]>([]);
    private readonly _selections = signal<ApiSelectionView[]>([]);
    private readonly _history = signal<ApiHistoryEntry[]>([]);
    private readonly _serverTime = signal<string | null>(null);
    private readonly _connection = signal<ConnectionState>('connecting');
    private readonly _lastError = signal<string | null>(null);

    readonly actions = this._actions.asReadonly();
    readonly selections = this._selections.asReadonly();
    readonly history = this._history.asReadonly();
    readonly serverTime = this._serverTime.asReadonly();
    readonly connection = this._connection.asReadonly();
    readonly lastError = this._lastError.asReadonly();

    readonly pendingCount = computed(() => this._actions().length);
    readonly openSelectionCount = computed(() => this._selections().length);

    private handle: ReturnType<typeof setInterval> | null = null;
    private inFlight = false;

    constructor() {
        const destroyRef = inject(DestroyRef);

        // Polling follows the session, not a call site: logging in starts it,
        // logging out or a 401 stops it. Nothing else has to remember to.
        effect(() => {
            if (this.session.isAuthenticated()) {
                this.start();
            } else {
                this.stop();
                this.reset();
            }
        });

        const onVisibility = (): void => {
            if (document.visibilityState === 'visible' && this.session.isAuthenticated()) {
                this.start();
                void this.refresh();
            } else if (document.visibilityState === 'hidden') {
                this.stop();
            }
        };
        document.addEventListener('visibilitychange', onVisibility);
        destroyRef.onDestroy(() => {
            document.removeEventListener('visibilitychange', onVisibility);
            this.stop();
        });
    }

    /** Seeds the dashboard from a response that was already fetched, e.g. by the login probe. */
    apply(payload: ApiStateResponse): void {
        this._actions.set(payload.actions);
        this._selections.set(payload.selections);
        this._history.set(payload.history);
        this._serverTime.set(payload.serverTime);
        this._connection.set('online');
        this._lastError.set(null);
    }

    async refresh(): Promise<void> {
        if (this.inFlight) {
            // A slow gateway must not accumulate a queue of identical polls.
            return;
        }
        this.inFlight = true;
        try {
            this.apply(await this.api.state());
        } catch (error) {
            // A 401 is already handled globally by the interceptor, which clears
            // the session; the effect above then stops this poll.
            this._connection.set('offline');
            this._lastError.set(describeApiError(error));
        } finally {
            this.inFlight = false;
        }
    }

    action(actionId: string): ApiActionView | undefined {
        return this._actions().find((candidate) => candidate.actionId === actionId);
    }

    private start(): void {
        if (this.handle !== null) {
            return;
        }
        this.handle = setInterval(() => void this.refresh(), POLL_INTERVAL_MS);
        void this.refresh();
    }

    private stop(): void {
        if (this.handle !== null) {
            clearInterval(this.handle);
            this.handle = null;
        }
    }

    private reset(): void {
        this._actions.set([]);
        this._selections.set([]);
        this._history.set([]);
        this._serverTime.set(null);
        this._connection.set('connecting');
        this._lastError.set(null);
    }
}
