import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDividerModule } from '@angular/material/divider';
import { MatTooltipModule } from '@angular/material/tooltip';
import type { ApiSummaryActionView } from '@gateway/contract';
import { formatAttributes, formatConfidence, formatTime } from '../core/format';
import { CountdownLabel } from '../shared/countdown';
import { Field, Fields } from '../shared/fields';
import { Icon } from '../shared/icon';
import { SensitivityChip } from '../shared/chips';
import type { ApprovalDecision } from './approval-detail';

/** German labels for the closed placeholder set, in the order they are shown. */
const REDACTION_LABELS: Readonly<Record<string, string>> = {
    REDACTED_NAME: 'Personennamen',
    REDACTED_ORG: 'Firmen und Einrichtungen',
    REDACTED_ADDRESS: 'Anschriften und Orte',
    REDACTED_CONTACT: 'Kontaktdaten',
    REDACTED_DATE: 'Datumsangaben',
    REDACTED_AMOUNT: 'Geldbeträge',
    REDACTED_ID: 'Kennzeichen und Nummern',
    REDACTED_HEALTH: 'Gesundheitsangaben',
    REDACTED_CREDENTIAL: 'Zugangsdaten',
    REDACTED_OTHER: 'sonstige Angaben'
};

/**
 * A redacted summary waiting to be released to the cloud agent.
 *
 * The design question here is different from the one a transfer poses. With a
 * mail, the risky field is the recipient and the payload is a file the user
 * already knows; here the payload *is* the risk, and it is a paragraph of prose
 * that a language model wrote about a private document. So the text is not one
 * field among several — it is the page, shown in full, in the alarm colour,
 * never truncated and never scrolled away behind a fold, with everything else
 * arranged around it.
 *
 * Two things sit above it. The pattern scan's findings, because "look closely at
 * line three" is far more useful than "please proofread"; and the list of
 * categories the model claims to have removed, because knowing what it was
 * trying to remove is what lets a reader notice that something is still there.
 * Neither is a guarantee, and the wording says so: the model may be wrong, and
 * the person reading is the check, not the second opinion.
 */
@Component({
    selector: 'ltg-summary-detail',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
        MatButtonModule,
        MatDividerModule,
        MatTooltipModule,
        CountdownLabel,
        Field,
        Fields,
        Icon,
        SensitivityChip
    ],
    template: `
        <article class="detail">
            <header class="head">
                <div class="head-main">
                    <span class="kind">
                        <ltg-icon name="document" [size]="12" />
                        Zusammenfassung an den Agenten
                    </span>
                    <h2>{{ action().resource.safeLabel }}</h2>
                    <p class="ltg-mono ltg-muted">
                        Referenz {{ action().resource.ref }} · Aktion {{ action().actionId }}
                    </p>
                </div>
                <div class="head-side">
                    <ltg-sensitivity [level]="action().judgement.sensitivity" />
                    <ltg-countdown [expiresAt]="action().expiresAt" />
                </div>
            </header>

            <div class="body">
                <!-- 1. The text itself. Everything else on this page is context for it. -->
                <section class="egress">
                    <h3 class="section-head">
                        <ltg-icon name="alert" [size]="16" />
                        Genau dieser Text verlässt dieses System
                    </h3>

                    <p class="lede">
                        Das Originaldokument bleibt hier. Übertragen wird ausschließlich der
                        folgende, lokal geschriebene Text — Wort für Wort, ohne Anhang. Lies ihn
                        vollständig: das lokale Modell soll vertrauliche Angaben entfernt haben,
                        aber ob das gelungen ist, entscheidest du.
                    </p>

                    @if (residuals().length > 0) {
                        <div class="strip alarm">
                            <ltg-icon name="alert" [size]="16" />
                            <div>
                                <p class="strip-head">
                                    Die lokale Mustersuche hat im Text noch etwas gefunden, das wie
                                    eine schützenswerte Angabe aussieht:
                                </p>
                                <ul class="findings">
                                    @for (finding of residuals(); track finding.sample) {
                                        <li>
                                            {{ finding.kind }}:
                                            <span class="ltg-mono">{{ finding.sample }}</span>
                                        </li>
                                    }
                                </ul>
                                <p class="strip-foot">
                                    Das kann ein Fehlalarm sein. Prüfe die Stellen im Text, bevor du
                                    freigibst.
                                </p>
                            </div>
                        </div>
                    }

                    <pre class="summary-text">{{ action().summary.text }}</pre>

                    <ltg-fields>
                        <ltg-field label="Umfang">
                            {{ action().summary.chars }} Zeichen, reiner Text, keine Anhänge
                        </ltg-field>
                        <ltg-field label="Verfasst von">
                            {{ action().summary.model }} · lokal, ohne Netzzugriff
                        </ltg-field>
                        @if (action().summary.focus; as focus) {
                            <ltg-field label="Angefragt zu">{{ focus }}</ltg-field>
                        }
                    </ltg-fields>

                    <p class="label">Geschwärzt laut Modell</p>
                    @if (redactions().length > 0) {
                        <ul class="redactions">
                            @for (entry of redactions(); track entry.code) {
                                <li>
                                    <span class="ltg-mono">[{{ entry.code }}]</span>
                                    {{ entry.label }}
                                </li>
                            }
                        </ul>
                    } @else {
                        <p class="ltg-muted small">
                            Der Text enthält keine Platzhalter. Entweder gab es nichts zu schwärzen —
                            oder das Modell hat nichts geschwärzt. Beides ist möglich, also lies
                            besonders genau.
                        </p>
                    }
                </section>

                <!-- 2. Where it came from. -->
                <section>
                    <h3 class="section-head">
                        <ltg-icon name="document" [size]="16" />
                        Herkunft
                    </h3>
                    <ltg-fields>
                        <ltg-field label="Ressource">{{ action().resource.title }}</ltg-field>
                        <ltg-field label="Datenquelle">
                            {{ action().resource.sourceLabel }}
                            <span class="ltg-mono ltg-muted">
                                (Kennung {{ action().resource.nativeIdDisplay }})
                            </span>
                            @if (action().resource.webUrl; as href) {
                                <a
                                    class="open-source"
                                    [href]="href"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                >
                                    Original öffnen
                                    <ltg-icon name="chevron" [size]="14" />
                                </a>
                            }
                        </ltg-field>
                        <ltg-field label="Zweck">{{ action().purpose }}</ltg-field>
                        <ltg-field label="Vorbereitet">{{ createdAt() }}</ltg-field>
                        @if (attributes()) {
                            <ltg-field label="Merkmale">{{ attributes() }}</ltg-field>
                        }
                    </ltg-fields>
                </section>

                <mat-divider />

                <!-- 3. The opinion, marked as one. -->
                <section class="judgement">
                    <h3 class="section-head quiet">Einschätzung des lokalen Modells</h3>
                    <p class="model ltg-muted">
                        {{ action().judgement.model }} · Konfidenz {{ confidence() }}
                    </p>
                    <p class="reasoning">{{ action().judgement.reasoning }}</p>

                    @if (uncertainties().length > 0) {
                        <p class="label">Offene Punkte</p>
                        <ul class="open-points">
                            @for (point of uncertainties(); track point) {
                                <li>{{ point }}</li>
                            }
                        </ul>
                    } @else {
                        <p class="ltg-muted small">Das Modell hat keine offenen Punkte gemeldet.</p>
                    }
                </section>

                <p class="binding">
                    Freigabe gilt für Aktion {{ action().actionId }} — genau für den Text oben.
                    Herausgegeben wird ausschließlich, was hier steht.
                </p>
            </div>

            <footer class="actions">
                <button
                    matButton="filled"
                    type="button"
                    class="approve"
                    [disabled]="busy()"
                    (click)="decide.emit('approve')"
                >
                    <ltg-icon name="check" [size]="16" />
                    {{ busy() ? 'wird freigegeben …' : 'Text freigeben' }}
                </button>
                <button
                    matButton="outlined"
                    type="button"
                    class="reject"
                    [disabled]="busy()"
                    (click)="decide.emit('reject')"
                >
                    Ablehnen
                </button>
                <span class="spacer"></span>
                <button
                    matButton
                    type="button"
                    [disabled]="busy()"
                    matTooltip="Verwirft die Zusammenfassung. Der Agent müsste eine neue anfragen."
                    (click)="decide.emit('discard')"
                >
                    Verwerfen
                </button>
            </footer>
        </article>
    `,
    styles: `
        .detail {
            display: flex;
            flex-direction: column;
            border: 1px solid var(--mat-sys-outline-variant);
            border-radius: var(--ltg-radius-lg);
            background: var(--mat-sys-surface-container-low);
            overflow: hidden;
        }

        .head {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            gap: var(--ltg-gap);
            flex-wrap: wrap;
            padding: 1.1rem 1.35rem;
            border-bottom: 1px solid var(--mat-sys-outline-variant);
            background: var(--mat-sys-surface-container);
        }

        .kind {
            display: inline-flex;
            align-items: center;
            gap: 0.3rem;
            padding: 0.1rem 0.5rem;
            border-radius: 999px;
            background: var(--ltg-alarm-surface);
            color: var(--ltg-alarm);
            font-size: 0.68rem;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.05em;
        }

        h2 {
            margin: 0.35rem 0 0;
            font-size: 1.05rem;
            font-weight: 650;
            overflow-wrap: anywhere;
        }

        .head-main p {
            margin: 0.25rem 0 0;
        }

        .head-side {
            display: flex;
            align-items: center;
            gap: 0.75rem;
            flex-wrap: wrap;
        }

        .body {
            display: flex;
            flex-direction: column;
            gap: var(--ltg-gap-lg);
            padding: 1.35rem;
        }

        .section-head {
            display: flex;
            align-items: center;
            gap: 0.45rem;
            margin: 0 0 0.75rem;
            font-size: 0.74rem;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.08em;
            color: var(--mat-sys-on-surface);
        }

        .section-head.quiet {
            color: var(--mat-sys-on-surface-variant);
        }

        /*
         * Red rather than amber, and a full border rather than an accent stripe.
         * A transfer sends a document the user picked; this sends prose about a
         * document that only a machine has read, and the block should not be
         * mistakable for a summary shown for information.
         */
        .egress {
            padding: 1.1rem 1.2rem;
            border: 1px solid var(--ltg-alarm);
            border-radius: var(--ltg-radius);
            background: var(--mat-sys-surface-container);
        }

        .lede {
            margin: 0 0 0.9rem;
            font-size: 0.86rem;
            line-height: 1.5;
            color: var(--mat-sys-on-surface-variant);
        }

        .strip {
            display: flex;
            align-items: flex-start;
            gap: 0.55rem;
            margin: 0 0 0.9rem;
            padding: 0.7rem 0.9rem;
            border-radius: var(--ltg-radius-sm);
            font-size: 0.85rem;
            line-height: 1.45;
        }

        .strip.alarm {
            border: 1px solid var(--ltg-alarm);
            background: var(--ltg-alarm-surface);
            color: var(--ltg-alarm);
            font-weight: 600;
        }

        .strip-head,
        .strip-foot {
            margin: 0;
        }

        .findings {
            margin: 0.35rem 0;
            padding-left: 1.1rem;
            font-weight: 500;
        }

        .strip-foot {
            font-weight: 500;
        }

        /*
         * The payload. Preformatted, so the line breaks the user sees are the
         * line breaks that go out, and deliberately without a max-height: a text
         * that scrolls is a text that gets skimmed.
         */
        .summary-text {
            margin: 0 0 1rem;
            padding: 1rem 1.1rem;
            border-radius: var(--ltg-radius-sm);
            border: 1px solid var(--ltg-alarm);
            background: var(--ltg-alarm-surface);
            color: var(--mat-sys-on-surface);
            font-family: var(--ltg-mono);
            font-size: 0.85rem;
            line-height: 1.65;
            white-space: pre-wrap;
            overflow-wrap: anywhere;
        }

        .label {
            margin: 1rem 0 0.35rem;
            font-size: 0.72rem;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.07em;
            color: var(--mat-sys-on-surface-variant);
        }

        .redactions {
            margin: 0;
            padding: 0;
            list-style: none;
            display: flex;
            flex-wrap: wrap;
            gap: 0.4rem;
        }

        .redactions li {
            padding: 0.25rem 0.6rem;
            border-radius: 999px;
            border: 1px solid var(--mat-sys-outline-variant);
            background: var(--mat-sys-surface);
            font-size: 0.78rem;
        }

        .redactions .ltg-mono {
            font-size: 0.72rem;
            color: var(--mat-sys-on-surface-variant);
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

        .judgement {
            padding: 1rem 1.15rem;
            border-radius: var(--ltg-radius);
            background: var(--mat-sys-surface-container);
        }

        .model {
            margin: 0 0 0.5rem;
            font-size: 0.78rem;
        }

        .reasoning {
            margin: 0;
            font-size: 0.9rem;
            line-height: 1.55;
        }

        .open-points {
            margin: 0;
            padding-left: 1.15rem;
            font-size: 0.87rem;
        }

        .open-points li {
            margin-bottom: 0.3rem;
        }

        .small {
            font-size: 0.85rem;
            margin: 0;
        }

        .binding {
            margin: 0;
            font-size: 0.72rem;
            color: var(--mat-sys-on-surface-variant);
        }

        .actions {
            display: flex;
            align-items: center;
            gap: 0.6rem;
            flex-wrap: wrap;
            padding: 1rem 1.35rem;
            border-top: 1px solid var(--mat-sys-outline-variant);
            background: var(--mat-sys-surface-container);
            position: sticky;
            bottom: 0;
        }

        .spacer {
            flex: 1;
        }

        .approve {
            --mat-button-filled-container-color: var(--ltg-settled);
            --mat-button-filled-label-text-color: #04140c;
        }

        .reject {
            --mat-button-outlined-label-text-color: var(--ltg-alarm);
            --mat-button-outlined-outline-color: var(--ltg-alarm);
        }

        @media (max-width: 700px) {
            .actions .spacer {
                display: none;
            }
        }
    `
})
export class SummaryDetail {
    readonly action = input.required<ApiSummaryActionView>();
    readonly busy = input(false);

    readonly decide = output<ApprovalDecision>();

    protected readonly createdAt = computed(() => formatTime(this.action().createdAt));
    protected readonly attributes = computed(() => formatAttributes(this.action().resource.attributes));
    protected readonly confidence = computed(() => formatConfidence(this.action().judgement.confidence));
    protected readonly uncertainties = computed(() => this.action().judgement.uncertainties);
    protected readonly residuals = computed(() => this.action().summary.residuals);

    protected readonly redactions = computed(() =>
        this.action().summary.redactions.map((code) => ({
            code,
            label: REDACTION_LABELS[code] ?? 'unbekannte Kategorie'
        }))
    );
}
