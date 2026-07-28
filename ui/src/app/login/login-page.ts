import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute, Router } from '@angular/router';
import { GatewayApi, describeApiError } from '../core/gateway-api';
import { GatewayState } from '../core/gateway-state';
import { SESSION_ENDED_REASON, safeRedirect } from '../core/auth';
import { Session } from '../core/session';
import { Icon } from '../shared/icon';

@Component({
    selector: 'ltg-login-page',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
        FormsModule,
        MatButtonModule,
        MatFormFieldModule,
        MatInputModule,
        MatProgressBarModule,
        Icon
    ],
    template: `
        <main class="screen">
            <form class="card" (ngSubmit)="submit()">
                @if (busy()) {
                    <mat-progress-bar mode="indeterminate" />
                }

                <header>
                    <span class="mark"><ltg-icon name="shield" [size]="22" /></span>
                    <div>
                        <h1>Local Trust Gateway</h1>
                        <p class="sub">Lokale Freigabe für Übertragungen privater Ressourcen</p>
                    </div>
                </header>

                @if (notice()) {
                    <p class="notice">{{ notice() }}</p>
                }

                <p class="hint">
                    Token aus der Startausgabe des Gateways. Es kommt aus der
                    Gateway-Umgebung und bleibt im Browser nur im
                    <code>sessionStorage</code> dieses Tabs.
                </p>

                <mat-form-field appearance="outline">
                    <mat-label>Zugriffstoken</mat-label>
                    <!--
                        Named and annotated so password managers leave it alone. This
                        is a per-start secret of a local process, not an account
                        credential, and an offer to save it would outlive the token
                        it saved.
                    -->
                    <input
                        matInput
                        type="password"
                        name="gateway-access-token"
                        autocomplete="off"
                        autocapitalize="off"
                        spellcheck="false"
                        data-lpignore="true"
                        data-1p-ignore="true"
                        data-bwignore="true"
                        data-form-type="other"
                        required
                        [disabled]="busy()"
                        [(ngModel)]="token"
                    />
                    @if (error()) {
                        <mat-error>{{ error() }}</mat-error>
                    }
                </mat-form-field>

                <button matButton="filled" type="submit" [disabled]="busy() || !token().trim()">
                    {{ busy() ? 'Prüfe Token …' : 'Anmelden' }}
                </button>
            </form>
        </main>
    `,
    styles: `
        .screen {
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            padding: 2rem 1.25rem;
            background:
                radial-gradient(
                    900px 420px at 50% -10%,
                    color-mix(in srgb, var(--mat-sys-primary) 14%, transparent),
                    transparent
                ),
                var(--mat-sys-surface);
        }

        .card {
            position: relative;
            display: flex;
            flex-direction: column;
            gap: var(--ltg-gap);
            width: 100%;
            max-width: 27rem;
            padding: 2rem;
            border: 1px solid var(--mat-sys-outline-variant);
            border-radius: var(--ltg-radius-lg);
            background: var(--mat-sys-surface-container-low);
            overflow: hidden;
        }

        mat-progress-bar {
            position: absolute;
            inset: 0 0 auto;
        }

        header {
            display: flex;
            align-items: center;
            gap: 0.85rem;
        }

        .mark {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 2.4rem;
            height: 2.4rem;
            border-radius: var(--ltg-radius-sm);
            background: var(--mat-sys-primary);
            color: var(--mat-sys-on-primary);
        }

        h1 {
            margin: 0;
            font-size: 1.05rem;
            font-weight: 650;
        }

        .sub,
        .hint {
            margin: 0;
            font-size: 0.83rem;
            color: var(--mat-sys-on-surface-variant);
        }

        .sub {
            margin-top: 0.15rem;
        }

        code {
            font-family: var(--ltg-mono);
            font-size: 0.85em;
        }

        .notice {
            margin: 0;
            padding: 0.7rem 0.9rem;
            border-radius: var(--ltg-radius-sm);
            border: 1px solid var(--ltg-caution);
            background: var(--ltg-caution-surface);
            color: var(--ltg-caution);
            font-size: 0.85rem;
        }
    `
})
export class LoginPage {
    private readonly api = inject(GatewayApi);
    private readonly session = inject(Session);
    private readonly state = inject(GatewayState);
    private readonly router = inject(Router);
    private readonly route = inject(ActivatedRoute);

    protected readonly token = signal('');
    protected readonly busy = signal(false);
    protected readonly error = signal('');
    protected readonly notice = signal(
        this.route.snapshot.queryParamMap.get('reason') === SESSION_ENDED_REASON
            ? 'Die Sitzung ist beendet — das Token gilt nicht mehr. Nach einem Neustart des Gateways vergibt es ein neues.'
            : ''
    );

    /**
     * Trying the token against a live endpoint is the only real proof it works.
     *
     * The order matters: prove first, then establish the session. Adopting the
     * token up front would start the background poller against a token that has
     * not been checked yet, and that poll's own 401 would tear down the login
     * attempt while it was still in flight.
     */
    protected async submit(): Promise<void> {
        const candidate = this.token().trim();
        if (candidate.length === 0 || this.busy()) {
            return;
        }
        this.busy.set(true);
        this.error.set('');
        this.notice.set('');

        try {
            const payload = await this.api.probe(candidate);
            this.session.adopt(candidate);
            // Seeded from the response that just proved the token, so the
            // dashboard arrives populated rather than empty for one poll.
            this.state.apply(payload);
            await this.router.navigateByUrl(
                safeRedirect(this.route.snapshot.queryParamMap.get('next')),
                { replaceUrl: true }
            );
        } catch (error) {
            this.token.set('');
            this.error.set(
                error instanceof HttpErrorResponse && error.status === 401
                    ? 'Token ungültig.'
                    : describeApiError(error)
            );
        } finally {
            this.busy.set(false);
        }
    }
}
