import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import type { ApiTelegramApprovalUpdateRequest } from '@gateway/contract';
import { GatewayApi } from '../core/gateway-api';
import { GatewayState } from '../core/gateway-state';
import { Notify } from '../core/notify';
import { Icon } from '../shared/icon';

/**
 * Local configuration for the optional Telegram decision channel.
 *
 * Credentials are write-only inputs. The API deliberately exposes only masked
 * status, so this component never has a value with which it could repopulate
 * the bot token (or accidentally render it elsewhere).
 */
@Component({
    selector: 'ltg-telegram-approval-page',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
        FormsModule,
        MatButtonModule,
        MatFormFieldModule,
        MatInputModule,
        MatProgressBarModule,
        MatSlideToggleModule,
        Icon
    ],
    template: `
        <section class="page">
            <header>
                <div>
                    <h1>Telegram-Freigabe</h1>
                    <p class="ltg-muted">
                        Optionaler zweiter Entscheidungskanal neben diesem lokalen Portal.
                    </p>
                </div>
                @if (status(); as current) {
                    <span
                        class="state"
                        [class.active]="current.enabled && current.polling"
                        [class.problem]="current.enabled && (!current.configured || !!current.lastError)"
                    >
                        {{ statusLabel() }}
                    </span>
                }
            </header>

            <div class="warning">
                <ltg-icon name="alert" [size]="20" />
                <div>
                    <strong>Metadaten und Nachrichtentext verlassen den Rechner.</strong>
                    <p>
                        Nach dem Aktivieren gehen Dokumentname, Quelle und Quellkennung,
                        Medientyp und Größe, Zweck, Ziel und Empfänger, Anhangsnamen mit
                        Prüfsummen, die Modellbewertung und bei einer Sendung Betreff und
                        Nachrichtentext im Wortlaut an Telegram. Was aus dem Dokument gelesen
                        wurde, bleibt hier: Dokumentinhalt, Textauszüge, Merkmale, die
                        Modellbegründung, der Text einer Zusammenfassung und Originaldateien —
                        und was dort nicht steht, ist dort auch nicht freigebbar:
                        Zusammenfassungen lassen sich in Telegram nur ablehnen.
                    </p>
                </div>
            </div>

            <p class="browser-note">
                <ltg-icon name="shield" [size]="18" />
                <span>
                    Die Browserfreigabe bleibt immer aktiv — auch wenn Telegram nicht
                    konfiguriert, deaktiviert oder vorübergehend nicht erreichbar ist.
                </span>
            </p>

            <form class="card" (ngSubmit)="save()">
                @if (loading() || busy()) {
                    <mat-progress-bar mode="indeterminate" />
                }

                <div class="toggle-row">
                    <div>
                        <h2>Kanal konfigurieren</h2>
                        <p class="ltg-muted">
                            Nur für einen privaten, fest zugeordneten Chat und Benutzer.
                            Die Angaben werden lokal authentifiziert verschlüsselt.
                            Der separate Schlüssel kommt aus der Gateway-Umgebung
                            und wird nie an dieses Portal übertragen.
                        </p>
                    </div>
                    <mat-slide-toggle
                        name="telegram-enabled"
                        [disabled]="loading() || busy()"
                        [(ngModel)]="enabled"
                    >
                        Aktiviert
                    </mat-slide-toggle>
                </div>

                @if (status(); as current) {
                    <dl class="current">
                        <div>
                            <dt>Bot-Token</dt>
                            <dd>{{ current.botTokenSet ? 'gespeichert' : 'nicht gespeichert' }}</dd>
                        </div>
                        <div>
                            <dt>Chat-ID</dt>
                            <dd class="ltg-mono">{{ current.chatIdMasked ?? 'nicht gespeichert' }}</dd>
                        </div>
                        <div>
                            <dt>Benutzer-ID</dt>
                            <dd class="ltg-mono">
                                {{ current.allowedUserIdMasked ?? 'nicht gespeichert' }}
                            </dd>
                        </div>
                        <div>
                            <dt>Long Polling</dt>
                            <dd>{{ current.polling ? 'läuft' : 'gestoppt' }}</dd>
                        </div>
                    </dl>

                    @if (current.lastError) {
                        <p class="runtime-error">
                            <ltg-icon name="alert" [size]="16" />
                            Telegram ist derzeit nicht erreichbar oder hat eine Anfrage
                            abgelehnt. Details bleiben im lokalen Gateway-Protokoll.
                        </p>
                    }
                }

                <div class="fields">
                    <mat-form-field appearance="outline">
                        <mat-label>Bot-Token</mat-label>
                        <input
                            matInput
                            type="password"
                            name="telegram-bot-token"
                            autocomplete="new-password"
                            autocapitalize="off"
                            spellcheck="false"
                            data-lpignore="true"
                            data-1p-ignore="true"
                            data-bwignore="true"
                            data-form-type="other"
                            [disabled]="loading() || busy()"
                            [(ngModel)]="botToken"
                        />
                        <mat-hint>
                            Bleibt das Feld leer, wird ein gespeicherter Token beibehalten.
                            Er wird niemals zurück ins Portal geladen.
                        </mat-hint>
                    </mat-form-field>

                    <mat-form-field appearance="outline">
                        <mat-label>Private Chat-ID</mat-label>
                        <input
                            matInput
                            type="text"
                            inputmode="numeric"
                            name="telegram-chat-id"
                            autocomplete="off"
                            autocapitalize="off"
                            spellcheck="false"
                            [disabled]="loading() || busy()"
                            [(ngModel)]="chatId"
                        />
                        <mat-hint>Leer lassen, um den maskiert angezeigten Wert beizubehalten.</mat-hint>
                    </mat-form-field>

                    <mat-form-field appearance="outline">
                        <mat-label>Erlaubte Telegram-Benutzer-ID</mat-label>
                        <input
                            matInput
                            type="text"
                            inputmode="numeric"
                            name="telegram-user-id"
                            autocomplete="off"
                            autocapitalize="off"
                            spellcheck="false"
                            [disabled]="loading() || busy()"
                            [(ngModel)]="allowedUserId"
                        />
                        <mat-hint>Nur dieser Benutzer darf im festgelegten Chat entscheiden.</mat-hint>
                    </mat-form-field>
                </div>

                <p class="exclusive">
                    Verwende einen eigenen Bot ausschließlich für dieses Gateway. Ein anderer
                    Long-Polling-Client für denselben Bot kann Telegram-Updates abfangen.
                </p>

                <footer>
                    <button
                        matButton="filled"
                        type="submit"
                        [disabled]="loading() || busy() || !canSave()"
                    >
                        {{ busyAction() === 'save' ? 'Speichert …' : 'Speichern' }}
                    </button>
                    <button
                        matButton="outlined"
                        type="button"
                        [disabled]="loading() || busy() || !status()?.botTokenSet"
                        (click)="test()"
                    >
                        {{ busyAction() === 'test' ? 'Testet …' : 'Verbindung testen' }}
                    </button>
                    @if (status()?.enabled) {
                        <button
                            matButton
                            type="button"
                            class="disable"
                            [disabled]="loading() || busy()"
                            (click)="disable()"
                        >
                            Deaktivieren
                        </button>
                    }
                </footer>

                <p class="test-note ltg-muted">
                    Der Verbindungstest verwendet den bereits gespeicherten Bot-Token und
                    sendet keine Nachricht. Neue Eingaben deshalb zuerst speichern.
                </p>
            </form>
        </section>
    `,
    styles: `
        .page {
            max-width: 58rem;
            margin: 0 auto;
        }

        header {
            display: flex;
            align-items: flex-start;
            justify-content: space-between;
            gap: var(--ltg-gap);
            margin-bottom: var(--ltg-gap);
        }

        h1,
        h2,
        header p {
            margin: 0;
        }

        h1 {
            font-size: 1.25rem;
            font-weight: 680;
        }

        h2 {
            font-size: 1rem;
            font-weight: 650;
        }

        header p,
        .toggle-row p {
            margin-top: 0.25rem;
            font-size: 0.84rem;
        }

        .state {
            flex: none;
            padding: 0.25rem 0.65rem;
            border: 1px solid var(--mat-sys-outline);
            border-radius: 999px;
            color: var(--mat-sys-on-surface-variant);
            font-size: 0.76rem;
            font-weight: 650;
        }

        .state.active {
            border-color: var(--ltg-settled);
            background: var(--ltg-settled-surface);
            color: var(--ltg-settled);
        }

        .state.problem {
            border-color: var(--ltg-alarm);
            background: var(--ltg-alarm-surface);
            color: var(--ltg-alarm);
        }

        .warning,
        .browser-note,
        .runtime-error {
            display: flex;
            align-items: flex-start;
            gap: 0.65rem;
            border-radius: var(--ltg-radius);
        }

        .warning {
            padding: 1rem;
            border: 1px solid var(--ltg-alarm);
            background: var(--ltg-alarm-surface);
            color: var(--ltg-alarm);
        }

        .warning p {
            margin: 0.3rem 0 0;
            line-height: 1.5;
        }

        .browser-note {
            margin: var(--ltg-gap) 0;
            padding: 0.8rem 1rem;
            border: 1px solid var(--ltg-settled);
            background: var(--ltg-settled-surface);
            color: var(--ltg-settled);
        }

        .browser-note span {
            line-height: 1.45;
        }

        .card {
            position: relative;
            display: flex;
            flex-direction: column;
            gap: var(--ltg-gap-lg);
            padding: 1.35rem;
            border: 1px solid var(--mat-sys-outline-variant);
            border-radius: var(--ltg-radius-lg);
            background: var(--mat-sys-surface-container-low);
            overflow: hidden;
        }

        mat-progress-bar {
            position: absolute;
            inset: 0 0 auto;
        }

        .toggle-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: var(--ltg-gap);
        }

        .current {
            display: grid;
            grid-template-columns: repeat(4, minmax(0, 1fr));
            gap: 0.7rem;
            margin: 0;
        }

        .current div {
            min-width: 0;
            padding: 0.75rem;
            border-radius: var(--ltg-radius-sm);
            background: var(--mat-sys-surface-container);
        }

        .current dt {
            color: var(--mat-sys-on-surface-variant);
            font-size: 0.74rem;
        }

        .current dd {
            margin: 0.25rem 0 0;
            overflow-wrap: anywhere;
            font-weight: 600;
        }

        .fields {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: var(--ltg-gap);
        }

        .fields mat-form-field:first-child {
            grid-column: 1 / -1;
        }

        .runtime-error {
            margin: 0;
            padding: 0.7rem 0.85rem;
            background: var(--ltg-alarm-surface);
            color: var(--ltg-alarm);
            font-size: 0.84rem;
        }

        .exclusive,
        .test-note {
            margin: 0;
            font-size: 0.82rem;
            line-height: 1.45;
        }

        .exclusive {
            padding: 0.7rem 0.85rem;
            border-left: 3px solid var(--ltg-caution);
            background: var(--ltg-caution-surface);
            color: var(--ltg-caution);
        }

        footer {
            display: flex;
            align-items: center;
            gap: 0.7rem;
            flex-wrap: wrap;
        }

        .disable {
            color: var(--ltg-alarm);
        }

        @media (max-width: 700px) {
            header,
            .toggle-row {
                align-items: flex-start;
                flex-direction: column;
            }

            .current,
            .fields {
                grid-template-columns: 1fr;
            }

            .fields mat-form-field:first-child {
                grid-column: auto;
            }
        }
    `
})
export class TelegramApprovalPage {
    private readonly api = inject(GatewayApi);
    private readonly state = inject(GatewayState);
    private readonly notify = inject(Notify);

    protected readonly status = this.state.telegramApproval;
    protected readonly loading = signal(true);
    protected readonly busyAction = signal<'save' | 'test' | 'disable' | null>(null);
    protected readonly enabled = signal(false);
    protected readonly botToken = signal('');
    protected readonly chatId = signal('');
    protected readonly allowedUserId = signal('');
    protected readonly busy = computed(() => this.busyAction() !== null);

    protected readonly canSave = computed(() => {
        if (!this.enabled()) {
            return true;
        }
        if (this.status()?.configured) {
            return true;
        }
        return Boolean(
            this.botToken().trim() &&
                this.chatId().trim() &&
                this.allowedUserId().trim()
        );
    });

    protected readonly statusLabel = computed(() => {
        const status = this.status();
        if (status === null) {
            return 'Status wird geladen';
        }
        if (!status.enabled) {
            return status.configured ? 'deaktiviert' : 'nicht konfiguriert';
        }
        if (!status.configured) {
            return 'unvollständig';
        }
        if (status.lastError) {
            return 'Verbindungsfehler';
        }
        return status.polling ? 'aktiv' : 'startet';
    });

    constructor() {
        void this.load();
    }

    protected async save(): Promise<void> {
        if (this.busy() || !this.canSave()) {
            return;
        }
        this.busyAction.set('save');
        try {
            const update: ApiTelegramApprovalUpdateRequest = {
                enabled: this.enabled(),
                botToken: this.botToken().trim() || undefined,
                chatId: this.chatId().trim() || undefined,
                allowedUserId: this.allowedUserId().trim() || undefined
            };
            const status = await this.api.updateTelegramApproval(update);
            this.applyStatus(status);
            this.clearInputs();
            this.notify.ok(
                status.enabled
                    ? 'Telegram-Freigabe gespeichert und aktiviert.'
                    : 'Telegram-Freigabe gespeichert und deaktiviert.'
            );
        } catch (error) {
            this.notify.error(this.safeError(error, 'Einstellungen konnten nicht gespeichert werden.'));
        } finally {
            this.busyAction.set(null);
        }
    }

    protected async disable(): Promise<void> {
        if (this.busy()) {
            return;
        }
        this.busyAction.set('disable');
        try {
            const status = await this.api.updateTelegramApproval({ enabled: false });
            this.applyStatus(status);
            this.clearInputs();
            this.notify.ok('Telegram-Freigabe deaktiviert. Die gespeicherten Angaben bleiben erhalten.');
        } catch (error) {
            this.notify.error(this.safeError(error, 'Telegram-Freigabe konnte nicht deaktiviert werden.'));
        } finally {
            this.busyAction.set(null);
        }
    }

    protected async test(): Promise<void> {
        if (this.busy() || !this.status()?.botTokenSet) {
            return;
        }
        this.busyAction.set('test');
        try {
            const result = await this.api.testTelegramApproval();
            if (result.reachable) {
                this.notify.ok('Telegram-Bot ist erreichbar.');
            } else {
                this.notify.error(
                    'Telegram-Bot ist nicht erreichbar oder hat die Anfrage abgelehnt. Details stehen im lokalen Gateway-Protokoll.'
                );
            }
        } catch (error) {
            this.notify.error(this.safeError(error, 'Verbindungstest fehlgeschlagen.'));
        } finally {
            this.busyAction.set(null);
        }
    }

    private async load(): Promise<void> {
        try {
            const status = await this.state.refreshTelegramApproval();
            this.enabled.set(status.enabled);
        } catch (error) {
            this.notify.error(this.safeError(error, 'Telegram-Status konnte nicht geladen werden.'));
        } finally {
            this.loading.set(false);
        }
    }

    private applyStatus(status: NonNullable<ReturnType<typeof this.status>>): void {
        this.state.setTelegramApproval(status);
        this.enabled.set(status.enabled);
    }

    private clearInputs(): void {
        this.botToken.set('');
        this.chatId.set('');
        this.allowedUserId.set('');
    }

    /**
     * Settings failures must not turn server/library details into portal text.
     * Only distinguish problems a person can act on locally.
     */
    private safeError(error: unknown, fallback: string): string {
        if (error instanceof HttpErrorResponse) {
            if (error.status === 0) {
                return 'Keine Verbindung zum lokalen Gateway.';
            }
            if (error.status === 400) {
                return 'Eingaben unvollständig oder ungültig. Bot-Token, Chat-ID und Benutzer-ID prüfen.';
            }
        }
        return fallback;
    }
}
