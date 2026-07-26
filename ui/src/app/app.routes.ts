import type { Routes } from '@angular/router';
import { requiresNoSession, requiresSession } from './core/auth';
import { LoginPage } from './login/login-page';
import { ShellPage } from './shell/shell-page';
import { ApprovalsPage } from './approvals/approvals-page';
import { SelectionsPage } from './selections/selections-page';
import { HistoryPage } from './history/history-page';
import { AuditPage } from './audit/audit-page';

/**
 * Real, bookmarkable URLs rather than hidden view state: `/login` and
 * `/app/<tab>` are what the address bar shows, what back and forward move
 * between, and what a reload lands on. The approval server serves the same shell
 * for every one of these paths (see `CLIENT_SHELL_PATHS` in `server.ts`, built
 * from the same `API_TAB_ROUTES` constant), so the two route tables cannot drift
 * into a state where a tab works on click but 404s on refresh.
 *
 * Every view is imported eagerly. The whole application is a few hundred
 * kilobytes served from loopback, so route-level splitting would save nothing
 * measurable and cost a request per tab — and each additional chunk is another
 * file the server has to be willing to hand out under `default-src 'none'`. One
 * bundle keeps that surface at exactly two files.
 */
export const routes: Routes = [
    {
        path: 'login',
        component: LoginPage,
        title: 'Anmelden – Local Trust Gateway',
        canActivate: [requiresNoSession]
    },
    {
        path: 'app',
        component: ShellPage,
        canActivate: [requiresSession],
        children: [
            { path: '', pathMatch: 'full', redirectTo: 'approvals' },
            {
                path: 'approvals',
                component: ApprovalsPage,
                title: 'Freigaben – Local Trust Gateway'
            },
            {
                path: 'selections',
                component: SelectionsPage,
                title: 'Auswahl – Local Trust Gateway'
            },
            {
                path: 'history',
                component: HistoryPage,
                title: 'Verlauf – Local Trust Gateway'
            },
            {
                path: 'audit',
                component: AuditPage,
                title: 'Protokoll – Local Trust Gateway'
            }
        ]
    },
    { path: '', pathMatch: 'full', redirectTo: 'app/approvals' },
    { path: '**', redirectTo: 'app/approvals' }
];
