import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { GatewayState } from '../core/gateway-state';
import { Session } from '../core/session';
import { formatTime } from '../core/format';
import { Icon } from '../shared/icon';

/**
 * The frame around every authenticated view: identity of the tool, whether it is
 * still talking to the gateway, and where to go.
 *
 * The connection indicator is not cosmetic. This interface polls, so a stale view
 * and a current view look identical; if the gateway process died, the pending
 * approvals on screen are history rather than a list of decisions still open, and
 * that difference has to be visible without reading the timestamp.
 */
@Component({
    selector: 'ltg-shell-page',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
        RouterLink,
        RouterLinkActive,
        RouterOutlet,
        MatButtonModule,
        MatTooltipModule,
        Icon
    ],
    template: `
        <div class="frame">
            <header class="topbar">
                <div class="brand">
                    <span class="mark"><ltg-icon name="shield" [size]="20" /></span>
                    <div>
                        <p class="name">Local Trust Gateway</p>
                        <p class="sub">Lokale Freigabe für Übertragungen privater Ressourcen</p>
                    </div>
                </div>

                <div class="status">
                    <span
                        class="conn"
                        [class]="connection()"
                        [matTooltip]="connectionTooltip()"
                        matTooltipPosition="below"
                    >
                        <span class="dot"></span>
                        {{ connectionLabel() }}
                    </span>
                    <span class="clock">{{ serverTime() }}</span>
                    <button matButton type="button" (click)="logout()">
                        <ltg-icon name="logout" [size]="16" />
                        Abmelden
                    </button>
                </div>
            </header>

            <nav class="tabs">
                <a
                    routerLink="/app/approvals"
                    routerLinkActive="active"
                    class="tab"
                    #approvalsLink="routerLinkActive"
                    [attr.aria-current]="approvalsLink.isActive ? 'page' : null"
                >
                    Freigaben
                    @if (pending() > 0) {
                        <span class="count alarm">{{ pending() }}</span>
                    }
                </a>
                <a
                    routerLink="/app/selections"
                    routerLinkActive="active"
                    class="tab"
                    #selectionsLink="routerLinkActive"
                    [attr.aria-current]="selectionsLink.isActive ? 'page' : null"
                >
                    Auswahl
                    @if (openSelections() > 0) {
                        <span class="count">{{ openSelections() }}</span>
                    }
                </a>
                <a routerLink="/app/history" routerLinkActive="active" class="tab">Verlauf</a>
                <a routerLink="/app/audit" routerLinkActive="active" class="tab">Protokoll</a>
                <a
                    routerLink="/app/telegram-approval"
                    routerLinkActive="active"
                    class="tab"
                >
                    Telegram
                </a>
            </nav>

            @if (connection() === 'offline') {
                <p class="banner">
                    <ltg-icon name="alert" [size]="16" />
                    <span>
                        Keine Verbindung zum Gateway. Die Anzeige unten ist der letzte bekannte
                        Stand und kann veraltet sein. {{ lastError() }}
                    </span>
                </p>
            }

            <main><router-outlet /></main>
        </div>
    `,
    styles: `
        .frame {
            display: flex;
            flex-direction: column;
            min-height: 100vh;
        }

        .topbar {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: var(--ltg-gap);
            flex-wrap: wrap;
            padding: 0.85rem 1.5rem;
            border-bottom: 1px solid var(--mat-sys-outline-variant);
            background: var(--mat-sys-surface-container);
            position: sticky;
            top: 0;
            z-index: 10;
        }

        .brand {
            display: flex;
            align-items: center;
            gap: 0.7rem;
        }

        .mark {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 2.1rem;
            height: 2.1rem;
            border-radius: var(--ltg-radius-sm);
            background: var(--mat-sys-primary);
            color: var(--mat-sys-on-primary);
        }

        .name {
            margin: 0;
            font-weight: 650;
            font-size: 0.98rem;
        }

        .sub {
            margin: 0.1rem 0 0;
            font-size: 0.78rem;
            color: var(--mat-sys-on-surface-variant);
        }

        .status {
            display: flex;
            align-items: center;
            gap: 0.9rem;
            font-size: 0.8rem;
        }

        .conn {
            display: inline-flex;
            align-items: center;
            gap: 0.4rem;
            padding: 0.2rem 0.65rem;
            border-radius: 999px;
            border: 1px solid currentColor;
            font-weight: 600;
            cursor: default;
        }

        .conn .dot {
            width: 0.45em;
            height: 0.45em;
            border-radius: 999px;
            background: currentColor;
        }

        .conn.online {
            color: var(--ltg-settled);
            background: var(--ltg-settled-surface);
        }

        .conn.offline {
            color: var(--ltg-alarm);
            background: var(--ltg-alarm-surface);
        }

        .conn.connecting {
            color: var(--mat-sys-on-surface-variant);
        }

        .clock {
            color: var(--mat-sys-on-surface-variant);
            font-variant-numeric: tabular-nums;
        }

        .tabs {
            display: flex;
            gap: 0.25rem;
            padding: 0.55rem 1.5rem;
            border-bottom: 1px solid var(--mat-sys-outline-variant);
            background: var(--mat-sys-surface-container-low);
            overflow-x: auto;
        }

        .tab {
            display: inline-flex;
            align-items: center;
            gap: 0.45rem;
            padding: 0.42rem 0.95rem;
            border-radius: 999px;
            color: var(--mat-sys-on-surface-variant);
            text-decoration: none;
            font-size: 0.87rem;
            font-weight: 550;
            white-space: nowrap;
            transition:
                background-color 0.15s ease,
                color 0.15s ease;
        }

        .tab:hover {
            background: var(--mat-sys-surface-container-high);
            color: var(--mat-sys-on-surface);
        }

        .tab.active {
            background: var(--mat-sys-primary);
            color: var(--mat-sys-on-primary);
        }

        .count {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            min-width: 1.4em;
            height: 1.4em;
            padding: 0 0.4em;
            border-radius: 999px;
            background: var(--mat-sys-surface-container-highest);
            color: var(--mat-sys-on-surface);
            font-size: 0.72rem;
            font-weight: 700;
        }

        .count.alarm {
            background: var(--ltg-alarm);
            color: #fff;
        }

        .tab.active .count {
            background: color-mix(in srgb, #fff 25%, transparent);
            color: inherit;
        }

        .banner {
            display: flex;
            align-items: center;
            gap: 0.6rem;
            margin: 0;
            padding: 0.7rem 1.5rem;
            background: var(--ltg-alarm-surface);
            color: var(--ltg-alarm);
            font-size: 0.85rem;
            font-weight: 550;
        }

        main {
            flex: 1;
            padding: var(--ltg-gap-lg);
            max-width: 1400px;
            width: 100%;
            margin: 0 auto;
        }

        @media (max-width: 700px) {
            .topbar,
            .tabs,
            .banner {
                padding-inline: 1rem;
            }

            main {
                padding: var(--ltg-gap);
            }

            .sub {
                display: none;
            }
        }
    `
})
export class ShellPage {
    private readonly state = inject(GatewayState);
    private readonly session = inject(Session);
    private readonly router = inject(Router);

    protected readonly connection = this.state.connection;
    protected readonly lastError = this.state.lastError;
    protected readonly pending = this.state.pendingCount;
    protected readonly openSelections = this.state.openSelectionCount;

    protected readonly serverTime = computed(() => {
        const time = this.state.serverTime();
        return time === null ? '' : formatTime(time);
    });

    protected readonly connectionLabel = computed(
        () =>
            ({
                connecting: 'verbinde …',
                online: 'verbunden',
                offline: 'getrennt'
            })[this.connection()]
    );

    protected readonly connectionTooltip = computed(() =>
        this.connection() === 'online'
            ? 'Der Stand wird alle zwei Sekunden vom lokalen Gateway geholt.'
            : 'Zuletzt gezeigter Stand — das Gateway antwortet gerade nicht.'
    );

    protected logout(): void {
        this.session.clear();
        void this.router.navigate(['/login']);
    }
}
