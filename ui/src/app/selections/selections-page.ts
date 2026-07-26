import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { Router } from '@angular/router';
import type {
    ApiParkedActionOutcome,
    ApiSelectionCandidate,
    ApiSelectionView
} from '@gateway/contract';
import { GatewayApi, describeApiError } from '../core/gateway-api';
import { GatewayState } from '../core/gateway-state';
import { Notify } from '../core/notify';
import { formatAttributes, formatTime } from '../core/format';
import { CountdownLabel } from '../shared/countdown';
import { EmptyState } from '../shared/empty-state';
import { Field, Fields } from '../shared/fields';
import { Icon } from '../shared/icon';

/**
 * Searches the local model would not resolve to a single resource.
 *
 * This is the point where the gateway hands a decision back rather than guess,
 * and the candidates are presented side by side so the difference between them is
 * what stands out — the excerpt is usually the only thing that distinguishes two
 * documents with near-identical titles.
 */
@Component({
    selector: 'ltg-selections-page',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [MatButtonModule, CountdownLabel, EmptyState, Field, Fields, Icon],
    template: `
        @if (selections().length === 0) {
            <ltg-empty
                icon="search"
                headline="Keine offene Auswahl."
                detail="Wenn das lokale Modell eine Suche nicht eindeutig auflösen kann, landet die Entscheidung hier."
            />
        } @else {
            @for (selection of selections(); track selection.selectionId) {
                <article class="card">
                    <header>
                        <div>
                            <h2>Lokale Auswahl erforderlich</h2>
                            <p class="ltg-mono ltg-muted">Auswahl {{ selection.selectionId }}</p>
                        </div>
                        <ltg-countdown [expiresAt]="selection.expiresAt" />
                    </header>

                    <div class="body">
                        @if (selection.originActionId) {
                            <p class="parked">
                                <ltg-icon name="alert" [size]="16" />
                                <span>
                                    Die Freigabe {{ selection.originActionId }} pausiert, solange
                                    diese Auswahl offen ist — sie ist weder abgelehnt noch verworfen.
                                    Bestätigst du das bereits gewählte Dokument, wartet sie
                                    unverändert weiter auf deine Entscheidung. Wählst du ein anderes,
                                    wird sie verworfen und Hermes muss sie neu vorbereiten.
                                    „Auswahl abbrechen“ lässt sie ebenfalls unverändert.
                                </span>
                            </p>
                        }

                        <ltg-fields>
                            <ltg-field label="Suchanfrage">{{ selection.query }}</ltg-field>
                            <ltg-field label="Zweck">{{ selection.purpose }}</ltg-field>
                            <ltg-field label="Warum offen">{{ selection.reasoning }}</ltg-field>
                        </ltg-fields>

                        <h3 class="section-head">
                            <ltg-icon name="document" [size]="16" />
                            Kandidaten ({{ selection.candidates.length }})
                        </h3>

                        <ul class="candidates">
                            @for (candidate of selection.candidates; track candidate.candidateId) {
                                <li [class.current]="candidate.isCurrent">
                                    <div class="cand-head">
                                        <strong>
                                            {{ candidate.title }}
                                            @if (candidate.isCurrent) {
                                                <span class="badge">bereits gewählt</span>
                                            }
                                        </strong>
                                        <button
                                            matButton="filled"
                                            type="button"
                                            [disabled]="busy()"
                                            (click)="choose(selection, candidate)"
                                        >
                                            @if (candidate.isCurrent) {
                                                Diese bestätigen
                                            } @else {
                                                Diese wählen
                                            }
                                        </button>
                                    </div>
                                    <ltg-fields>
                                        <ltg-field label="Quelle">
                                            {{ candidate.sourceLabel }}
                                            <span class="ltg-mono ltg-muted">
                                                (Kennung {{ candidate.nativeId }})
                                            </span>
                                            @if (candidate.webUrl; as href) {
                                                <a
                                                    class="open-source"
                                                    [href]="href"
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                >
                                                    Dokument öffnen
                                                    <ltg-icon name="chevron" [size]="14" />
                                                </a>
                                            }
                                        </ltg-field>
                                        @if (candidate.modifiedAt) {
                                            <ltg-field label="Geändert">
                                                {{ time(candidate.modifiedAt) }}
                                            </ltg-field>
                                        }
                                        @if (candidate.mimeType) {
                                            <ltg-field label="Format">{{ candidate.mimeType }}</ltg-field>
                                        }
                                        @if (attributes(candidate); as attrs) {
                                            <ltg-field label="Merkmale">{{ attrs }}</ltg-field>
                                        }
                                    </ltg-fields>
                                    @if (candidate.excerpt) {
                                        <p class="excerpt">{{ candidate.excerpt }}</p>
                                    }
                                </li>
                            }
                        </ul>
                    </div>

                    <footer>
                        <button
                            matButton="outlined"
                            type="button"
                            class="cancel"
                            [disabled]="busy()"
                            (click)="cancel(selection)"
                        >
                            Auswahl abbrechen
                        </button>
                    </footer>
                </article>
            }
        }
    `,
    styles: `
        .card {
            border: 1px solid var(--mat-sys-outline-variant);
            border-radius: var(--ltg-radius-lg);
            background: var(--mat-sys-surface-container-low);
            overflow: hidden;
            margin-bottom: var(--ltg-gap-lg);
        }

        header {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            gap: var(--ltg-gap);
            flex-wrap: wrap;
            padding: 1.1rem 1.35rem;
            border-bottom: 1px solid var(--mat-sys-outline-variant);
            background: var(--mat-sys-surface-container);
        }

        h2 {
            margin: 0;
            font-size: 1.02rem;
            font-weight: 650;
        }

        header p {
            margin: 0.25rem 0 0;
        }

        .body {
            padding: 1.35rem;
        }

        .section-head {
            display: flex;
            align-items: center;
            gap: 0.45rem;
            margin: 1.5rem 0 0.75rem;
            font-size: 0.74rem;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.08em;
        }

        .candidates {
            list-style: none;
            margin: 0;
            padding: 0;
            display: flex;
            flex-direction: column;
            gap: 0.75rem;
        }

        .candidates li {
            padding: 0.95rem 1.1rem;
            border: 1px solid var(--mat-sys-outline-variant);
            border-radius: var(--ltg-radius);
            background: var(--mat-sys-surface-container);
        }

        /*
         * The candidate an action already points at is marked, because
         * confirming it and replacing it have opposite consequences for that
         * action — and two documents in a Paperless archive routinely differ by
         * nothing a list row shows.
         */
        .candidates li.current {
            border-color: var(--mat-sys-primary);
        }

        .badge {
            display: inline-block;
            margin-left: 0.45rem;
            padding: 0.05rem 0.45rem;
            border-radius: 999px;
            background: var(--mat-sys-surface-container-highest);
            color: var(--mat-sys-primary);
            font-size: 0.68rem;
            font-weight: 700;
        }

        .parked {
            display: flex;
            align-items: flex-start;
            gap: 0.55rem;
            margin: 0 0 var(--ltg-gap);
            padding: 0.75rem 0.9rem;
            border: 1px solid var(--ltg-caution);
            border-radius: var(--ltg-radius-sm);
            background: var(--ltg-caution-surface);
            color: var(--ltg-caution);
            font-size: 0.85rem;
            line-height: 1.5;
        }

        .open-source {
            display: inline-flex;
            align-items: center;
            gap: 0.15rem;
            margin-left: 0.5rem;
            color: var(--mat-sys-primary);
            font-size: 0.82rem;
            text-decoration: none;
        }

        .open-source:hover {
            text-decoration: underline;
        }

        .cand-head {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: var(--ltg-gap);
            flex-wrap: wrap;
            margin-bottom: 0.6rem;
        }

        .cand-head strong {
            font-size: 0.95rem;
            overflow-wrap: anywhere;
        }

        .excerpt {
            margin: 0.7rem 0 0;
            padding: 0.65rem 0.8rem;
            border-radius: var(--ltg-radius-sm);
            border: 1px solid var(--mat-sys-outline-variant);
            background: var(--mat-sys-surface);
            color: var(--mat-sys-on-surface-variant);
            font-size: 0.82rem;
            line-height: 1.5;
            white-space: pre-wrap;
            overflow-wrap: anywhere;
            max-height: 8rem;
            overflow-y: auto;
        }

        footer {
            padding: 1rem 1.35rem;
            border-top: 1px solid var(--mat-sys-outline-variant);
            background: var(--mat-sys-surface-container);
        }

        .cancel {
            --mat-button-outlined-label-text-color: var(--ltg-alarm);
            --mat-button-outlined-outline-color: var(--ltg-alarm);
        }
    `
})
export class SelectionsPage {
    private readonly state = inject(GatewayState);
    private readonly api = inject(GatewayApi);
    private readonly notify = inject(Notify);
    private readonly router = inject(Router);

    protected readonly selections = this.state.selections;
    protected readonly busy = signal(false);

    protected time(iso: string | undefined): string {
        return formatTime(iso);
    }

    protected attributes(candidate: ApiSelectionCandidate): string {
        return formatAttributes(candidate.attributes);
    }

    protected async choose(
        selection: ApiSelectionView,
        candidate: ApiSelectionCandidate
    ): Promise<void> {
        await this.run(async () => {
            const result = await this.api.select(selection.selectionId, candidate.candidateId);
            this.notify.ok(this.describeOutcome(result.action));
            if (result.action.kind === 'restored') {
                await this.router.navigate(['/app/approvals'], {
                    queryParams: { action: result.action.actionId }
                });
            }
        });
    }

    protected async cancel(selection: ApiSelectionView): Promise<void> {
        await this.run(async () => {
            const result = await this.api.cancelSelection(selection.selectionId);
            this.notify.ok(
                result.action.kind === 'restored'
                    ? 'Auswahl abgebrochen. Die pausierte Freigabe wartet unverändert weiter.'
                    : 'Auswahl abgebrochen.'
            );
        });
    }

    /**
     * The message has to say what happened to the parked action, because that is
     * the part the user cannot see: the selection disappearing looks the same
     * whether their approval survived it or not.
     */
    private describeOutcome(outcome: ApiParkedActionOutcome): string {
        switch (outcome.kind) {
            case 'restored':
                return 'Dokument bestätigt. Die Freigabe wartet unverändert weiter auf deine Entscheidung.';
            case 'discarded':
                return 'Anderes Dokument gewählt. Die bisherige Freigabe wurde verworfen; Hermes muss sie neu vorbereiten.';
            case 'none':
                return 'Ressource ausgewählt. Hermes kann die Aktion nun vorbereiten.';
        }
    }

    private async run(operation: () => Promise<void>): Promise<void> {
        if (this.busy()) {
            return;
        }
        this.busy.set(true);
        try {
            await operation();
        } catch (error) {
            this.notify.error(describeApiError(error));
        } finally {
            this.busy.set(false);
            await this.state.refresh();
        }
    }
}
