import { inject } from '@angular/core';
import {
    HttpContextToken,
    HttpErrorResponse,
    type HttpInterceptorFn
} from '@angular/common/http';
import { Router, type CanActivateFn, type UrlTree } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { Session } from './session';

/**
 * Opts a single request out of the global "401 means log out" reaction.
 *
 * The login attempt is the one request where a 401 is an expected answer rather
 * than an expired session: it means the token the user just typed is wrong, and
 * the right response is an error under the input field, not a redirect to the
 * form they are already looking at.
 */
export const EXPECTS_UNAUTHORIZED = new HttpContextToken<boolean>(() => false);

/** Reason carried to the login screen when a session ended involuntarily. */
export const SESSION_ENDED_REASON = 'expired';

export const tokenInterceptor: HttpInterceptorFn = (request, next) => {
    const session = inject(Session);
    const router = inject(Router);
    const token = session.token();

    // A request that already carries a token is testing that specific one — the
    // login probe. The session must not override it.
    const authorised =
        token && !request.headers.has('X-Gateway-Token')
            ? request.clone({ setHeaders: { 'X-Gateway-Token': token } })
            : request;

    return next(authorised).pipe(
        catchError((error: unknown) => {
            const isUnauthorized = error instanceof HttpErrorResponse && error.status === 401;
            if (isUnauthorized && !request.context.get(EXPECTS_UNAUTHORIZED)) {
                // The token stopped working mid-session — the gateway restarted
                // and minted a new one, or the tab sat open past its life. Drop it
                // rather than let every poll keep hammering a 401.
                session.clear();
                void router.navigate(['/login'], {
                    queryParams: { reason: SESSION_ENDED_REASON }
                });
            }
            return throwError(() => error);
        })
    );
};

/**
 * The single auth guard. Every way a route can be reached — typed, bookmarked,
 * back/forward, a redirect after login — passes through here, so there is exactly
 * one answer to "is this URL reachable right now".
 */
export const requiresSession: CanActivateFn = (_route, state): boolean | UrlTree => {
    const session = inject(Session);
    const router = inject(Router);
    if (session.isAuthenticated()) {
        return true;
    }
    return router.createUrlTree(['/login'], { queryParams: { next: state.url } });
};

/** Keeps an authenticated visitor off the login form instead of asking twice. */
export const requiresNoSession: CanActivateFn = (route): boolean | UrlTree => {
    const session = inject(Session);
    const router = inject(Router);
    if (!session.isAuthenticated()) {
        return true;
    }
    return router.parseUrl(safeRedirect(route.queryParamMap.get('next')));
};

/** Where to land after a successful login when nothing else applies. */
export const DEFAULT_ROUTE = '/app/approvals';

/**
 * Resolves the `next` parameter to a path that is safe to navigate to.
 *
 * `next` comes from the URL, so it is attacker-supplied in any scenario where
 * someone can get the user to open a crafted local link. Only a path on this
 * origin is followed — `//evil.example`, `https://…` and anything else that could
 * leave the page fall back to the default. Exported rather than duplicated,
 * because the login form needs exactly the same rule and two copies of a check
 * like this drift.
 */
export function safeRedirect(next: string | null | undefined): string {
    if (typeof next !== 'string' || !next.startsWith('/') || next.startsWith('//')) {
        return DEFAULT_ROUTE;
    }
    return next;
}
