import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDividerModule } from '@angular/material/divider';
import { MatTooltipModule } from '@angular/material/tooltip';
import type { ApiActionView } from '@gateway/contract';
import { formatAttributes, formatBytes, formatConfidence, formatTime } from '../core/format';
import { CountdownLabel } from '../shared/countdown';
import { Field, Fields } from '../shared/fields';
import { Icon } from '../shared/icon';
import { SensitivityChip } from '../shared/chips';

/** What the user can decide about one prepared action. */
export type ApprovalDecision = 'approve' | 'reject' | 'reselect' | 'discard';

/**
 * One prepared action, in full.
 *
 * The ordering of this view is the design. It runs facts first and opinion last:
 *
 *   1. what will leave this machine, and to whom,
 *   2. where it came from,
 *   3. what the local model thinks about that.
 *
 * The previous interface interleaved the three, so a confident-sounding paragraph
 * from a language model sat at the same visual weight as the recipient address it
 * was talking about. The model's verdict is advice about data the user can see
 * for themselves; it is styled as the quietest block on the page for that reason,
 * and labelled with the model that produced it.
 */
@Component({
    selector: 'ltg-approval-detail',
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
                @if (action().needsRefetch) {
                    <p class="strip caution">
                        <ltg-icon name="alert" [size]="16" />
                        <span>
                            Die Originaldaten liegen nicht mehr im Zwischenspeicher, etwa nach
                            einem Neustart. Bei der Freigabe werden sie erneut aus der Quelle
                            gelesen und gegen die unten angezeigte Prüfsumme verglichen.
                        </span>
                    </p>
                }

                <!-- 1. The facts: what leaves, and where it goes. -->
                <section class="egress">
                    <h3 class="section-head">
                        <ltg-icon name="mail" [size]="16" />
                        Das verlässt dieses System
                    </h3>

                    @if (action().target.dynamicRecipient) {
                        <div class="strip alarm">
                            <ltg-icon name="alert" [size]="16" />
                            <span>
                                Empfänger vom Agenten vorgeschlagen, nicht lokal vorkonfiguriert.
                                Adresse zeichenweise prüfen — Tippfehler, ähnliche Domains.
                            </span>
                        </div>
                        <p class="recipient">{{ action().target.recipientDisplay }}</p>
                    }

                    @if (agentWroteAnything()) {
                        <div class="strip caution">
                            <ltg-icon name="alert" [size]="16" />
                            <span>
                                {{ agentAuthorship() }} stammt wörtlich vom Agenten und
                                {{ agentAuthorshipVerb() }} unverändert versandt — das Gateway hat
                                daran nichts formuliert und nichts geprüft. Vollständig lesen.
                            </span>
                        </div>
                    }

                    <ltg-fields>
                        <ltg-field label="Ziel">
                            {{ action().target.label }}
                            @if (!action().target.dynamicRecipient) {
                                <span class="ltg-mono">→ {{ action().target.recipientDisplay }}</span>
                            }
                        </ltg-field>
                        <ltg-field label="Betreff">
                            {{ subject() }}
                            @if (action().egress.authoredByAgent.subject) {
                                <span class="by-agent">vom Agenten</span>
                            }
                        </ltg-field>
                        <ltg-field label="Umfang">
                            {{ action().egress.attachments.length }} Anhang/Anhänge ·
                            {{ totalBytes() }}
                        </ltg-field>
                    </ltg-fields>

                    <p class="label">
                        Nachrichtentext
                        @if (action().egress.authoredByAgent.body) {
                            <span class="by-agent">vom Agenten</span>
                        }
                    </p>
                    <pre
                        class="body-text"
                        [class.agent]="action().egress.authoredByAgent.body"
                    >{{ action().egress.body }}</pre>

                    @if (action().egress.attachments.length > 0) {
                        <p class="label">Anhänge</p>
                        <ul class="files">
                            @for (file of action().egress.attachments; track file.sha256) {
                                <li>
                                    <span class="file-name">{{ file.filename }}</span>
                                    <span class="ltg-muted">{{ file.mimeType }}</span>
                                    <span class="ltg-muted">{{ bytes(file.byteSize) }}</span>
                                    <span
                                        class="ltg-mono ltg-muted hash"
                                        matTooltip="Digest genau der Bytes, die geplant sind. Vor dem Senden erneut geprüft."
                                    >
                                        sha256 {{ file.sha256 }}
                                    </span>
                                </li>
                            }
                        </ul>
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
                                    Dokument öffnen
                                    <ltg-icon name="chevron" [size]="14" />
                                </a>
                            }
                        </ltg-field>
                        <ltg-field label="Zweck">{{ action().purpose }}</ltg-field>
                        <ltg-field label="Vorbereitet">{{ createdAt() }}</ltg-field>
                        @if (action().resource.modifiedAt) {
                            <ltg-field label="Geändert">{{ modifiedAt() }}</ltg-field>
                        }
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

                <p
                    class="ltg-mono binding"
                    matTooltip="Diese Freigabe bindet an genau diesen Stand. Ändert sich etwas, lehnt das Gateway sie ab."
                >
                    Freigabebindung {{ action().bindingHash }}
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
                    {{ busy() ? 'wird ausgeführt …' : 'Freigeben und übertragen' }}
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
                    matTooltip="Öffnet eine lokale Auswahl. Die Aktion pausiert dabei nur: bestätigst du das bisherige Dokument, wartet sie unverändert weiter."
                    (click)="decide.emit('reselect')"
                >
                    Andere Ressource wählen
                </button>
                <button
                    matButton
                    type="button"
                    [disabled]="busy()"
                    matTooltip="Verwirft die Aktion. Hermes muss sie neu vorbereiten."
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

        h2 {
            margin: 0;
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
         * The egress block is the loudest thing on the page, and deliberately so:
         * it is the only section describing something irreversible.
         */
        .egress {
            padding: 1.1rem 1.2rem;
            border: 1px solid var(--mat-sys-outline);
            border-left: 4px solid var(--ltg-caution);
            border-radius: var(--ltg-radius);
            background: var(--mat-sys-surface-container);
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

        .strip.caution {
            border: 1px solid var(--ltg-caution);
            background: var(--ltg-caution-surface);
            color: var(--ltg-caution);
        }

        .strip.alarm {
            border: 1px solid var(--ltg-alarm);
            background: var(--ltg-alarm-surface);
            color: var(--ltg-alarm);
            font-weight: 600;
        }

        .recipient {
            margin: 0 0 0.9rem;
            padding: 0.7rem 0.9rem;
            border-radius: var(--ltg-radius-sm);
            background: var(--mat-sys-surface-container-highest);
            font-family: var(--ltg-mono);
            font-size: 1.02rem;
            font-weight: 600;
            letter-spacing: 0.02em;
            text-align: center;
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

        /*
         * Agent-written text is called out wherever it appears rather than only
         * in the banner: by the time the eye reaches the message block, a strip
         * three sections up has stopped being on screen.
         */
        .by-agent {
            display: inline-block;
            margin-left: 0.4rem;
            padding: 0.05rem 0.4rem;
            border-radius: 999px;
            background: var(--ltg-caution-surface);
            color: var(--ltg-caution);
            font-size: 0.68rem;
            font-weight: 700;
            text-transform: none;
            letter-spacing: 0;
            vertical-align: middle;
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

        .body-text {
            margin: 0;
            padding: 0.75rem 0.9rem;
            border-radius: var(--ltg-radius-sm);
            background: var(--mat-sys-surface);
            border: 1px solid var(--mat-sys-outline-variant);
            font-family: var(--ltg-mono);
            font-size: 0.8rem;
            line-height: 1.5;
            white-space: pre-wrap;
            overflow-wrap: anywhere;
            max-height: 18rem;
            overflow-y: auto;
        }

        .body-text.agent {
            border-color: var(--ltg-caution);
        }

        .files {
            margin: 0;
            padding: 0;
            list-style: none;
            display: flex;
            flex-direction: column;
            gap: 0.5rem;
        }

        .files li {
            display: grid;
            grid-template-columns: 1fr auto auto;
            gap: 0.2rem 0.85rem;
            padding: 0.6rem 0.75rem;
            border-radius: var(--ltg-radius-sm);
            background: var(--mat-sys-surface);
            border: 1px solid var(--mat-sys-outline-variant);
            font-size: 0.84rem;
        }

        .file-name {
            font-weight: 600;
            overflow-wrap: anywhere;
        }

        .hash {
            grid-column: 1 / -1;
            cursor: help;
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
            cursor: help;
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

            .files li {
                grid-template-columns: 1fr;
            }
        }
    `
})
export class ApprovalDetail {
    readonly action = input.required<ApiActionView>();
    readonly busy = input(false);

    readonly decide = output<ApprovalDecision>();

    protected readonly subject = computed(
        () => this.action().egress.subject || '– kein Betreff –'
    );
    protected readonly totalBytes = computed(() => formatBytes(this.action().egress.totalBytes));
    protected readonly createdAt = computed(() => formatTime(this.action().createdAt));
    protected readonly modifiedAt = computed(() => formatTime(this.action().resource.modifiedAt));
    protected readonly attributes = computed(() => formatAttributes(this.action().resource.attributes));
    protected readonly confidence = computed(() => formatConfidence(this.action().judgement.confidence));
    protected readonly uncertainties = computed(() => this.action().judgement.uncertainties);

    private readonly authored = computed(() => this.action().egress.authoredByAgent);
    protected readonly agentWroteAnything = computed(
        () => this.authored().subject || this.authored().body
    );
    protected readonly agentAuthorship = computed(() => {
        const { subject, body } = this.authored();
        if (subject && body) {
            return 'Betreff und Nachrichtentext';
        }
        return subject ? 'Der Betreff' : 'Der Nachrichtentext';
    });
    protected readonly agentAuthorshipVerb = computed(() =>
        this.authored().subject && this.authored().body ? 'werden' : 'wird'
    );

    protected bytes(value: number): string {
        return formatBytes(value);
    }
}
