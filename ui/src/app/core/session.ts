import { Injectable, computed, signal } from '@angular/core';

const TOKEN_STORAGE_KEY = 'ltg-ui-token';

/**
 * The one place that knows whether there is a session.
 *
 * The previous interface kept this in four places at once — a DOM `hidden`
 * attribute, a CSS class, a module-level variable and the URL — and they could
 * disagree; that is exactly how a login form ended up rendered on top of an
 * authenticated dashboard. Here the token is a single signal, every consumer
 * derives from it, and the router guard is the only thing that turns it into
 * something the user sees.
 *
 * The token lives in `sessionStorage`, so it dies with the tab.
 */
@Injectable({ providedIn: 'root' })
export class Session {
    private readonly _token = signal<string | null>(readStored());

    readonly token = this._token.asReadonly();
    readonly isAuthenticated = computed(() => this._token() !== null);

    adopt(token: string): void {
        const trimmed = token.trim();
        if (trimmed.length === 0) {
            return;
        }
        this._token.set(trimmed);
        write(trimmed);
    }

    clear(): void {
        this._token.set(null);
        write(null);
    }
}

/**
 * Takes a `?token=…` out of the URL and into storage, before anything else runs.
 *
 * The gateway prints such a link on startup so the operator can open the
 * interface straight from the log. It is honoured exactly once: a token left in
 * the address bar ends up in history, in autocomplete and in every screenshot of
 * this window.
 *
 * This is deliberately a plain function called before `bootstrapApplication`
 * rather than work done inside a component. The router evaluates the auth guard
 * as part of its initial navigation, and a component constructor is not reliably
 * earlier than that — doing it here means the guard cannot run against a session
 * that is about to exist.
 */
export function consumeTokenFromUrl(): void {
    const url = new URL(window.location.href);
    const token = url.searchParams.get('token');
    if (!token) {
        return;
    }
    write(token.trim());
    url.searchParams.delete('token');
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
}

function readStored(): string | null {
    try {
        const stored = sessionStorage.getItem(TOKEN_STORAGE_KEY);
        return stored && stored.length > 0 ? stored : null;
    } catch {
        // Storage can be unavailable in strict private-browsing modes. The
        // session then lasts for one page load instead of failing outright.
        return null;
    }
}

function write(token: string | null): void {
    try {
        if (token === null) {
            sessionStorage.removeItem(TOKEN_STORAGE_KEY);
        } else {
            sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
        }
    } catch {
        // See `readStored`.
    }
}
