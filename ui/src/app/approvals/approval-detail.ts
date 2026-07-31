import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDividerModule } from '@angular/material/divider';
import { MatTooltipModule } from '@angular/material/tooltip';
import type { ApiJudgement, ApiSendActionView } from '@gateway/contract';
import { formatAttributes, formatBytes, formatConfidence, formatTime, shortFormat } from '../core/format';
import { CountdownLabel } from '../shared/countdown';
import { Field, Fields } from '../shared/fields';
import { Icon } from '../shared/icon';
import { SensitivityChip } from '../shared/chips';

/** What the user can decide about one prepared action. */
export type ApprovalDecision = 'approve' | 'reject' | 'reselect' | 'discard';

/**
 * One prepared transfer, in full.
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
                    <h2>{{ heading() }}</h2>
                    <p class="ltg-mono ltg-muted">
                        {{ referenceLine() }} · Aktion {{ action().actionId }}
                    </p>
                </div>
                <div class="head-side">
                    <ltg-sensitivity [level]="overallSensitivity()" />
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
                            @for (file of action().egress.attachments; track $index) {
                                <li>
                                    <span class="file-name">{{ file.filename }}</span>
                                    <span class="ltg-muted">{{ file.mimeType }}</span>
                                    <span class="ltg-muted">{{ bytes(file.byteSize) }}</span>
                                    <span
                                        class="ltg-mono ltg-muted hash"
                                        [matTooltip]="hashTooltip()"
                                    >
                                        sha256 {{ file.sha256 }}
                                    </span>
                                </li>
                            }
                        </ul>
                        @if (optimization(); as policy) {
                            <p class="optimization">
                                <ltg-icon name="compress" [size]="16" />
                                <span>
                                    Passen diese Anhänge nicht unter das Limit des Ziels, darf das
                                    Gateway sie vor dem Versand verkleinern — <strong>höchstens
                                    {{ policy.maxProfile }}</strong>, nur
                                    {{ formatList() }}. Größe und sha256 oben gelten
                                    dann für die Originale, nicht für die versendete Datei. Der
                                    Inhalt bleibt derselbe, Dateiname und Format auch.
                                </span>
                            </p>
                        }
                    }
                </section>

                <!-- 2. Where it came from. -->
                <section>
                    <h3 class="section-head">
                        <ltg-icon name="document" [size]="16" />
                        Herkunft
                    </h3>
                    @for (resource of action().resources; track resource.ref; let index = $index) {
                        <div class="resource-card">
                            <p class="resource-number">
                                Anhang {{ index + 1 }} von {{ action().resources.length }}
                            </p>
                            <ltg-fields>
                                <ltg-field label="Ressource">{{ resource.title }}</ltg-field>
                                <ltg-field label="Referenz">
                                    <span class="ltg-mono">{{ resource.ref }}</span>
                                </ltg-field>
                                <ltg-field label="Datenquelle">
                                    {{ resource.sourceLabel }}
                                    <span class="ltg-mono ltg-muted">
                                        (Kennung {{ resource.nativeIdDisplay }})
                                    </span>
                                    @if (resource.webUrl; as href) {
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
                                @if (resource.modifiedAt) {
                                    <ltg-field label="Geändert">{{ resourceModifiedAt(resource) }}</ltg-field>
                                }
                                @if (resourceAttributes(resource); as value) {
                                    <ltg-field label="Merkmale">{{ value }}</ltg-field>
                                }
                            </ltg-fields>

                            @if (resourceExcerpt(resource); as text) {
                                <p class="label">Inhaltsauszug aus der Quelle</p>
                                <pre class="excerpt">{{ text }}</pre>
                            }
                        </div>
                    }
                    <ltg-fields>
                        <ltg-field label="Zweck">{{ action().purpose }}</ltg-field>
                        <ltg-field label="Vorbereitet">{{ createdAt() }}</ltg-field>
                    </ltg-fields>
                </section>

                <mat-divider />

                <!-- 3. The opinion, marked as one. -->
                <section class="judgement">
                    <h3 class="section-head quiet">Einschätzung des lokalen Modells</h3>
                    @for (resource of action().resources; track resource.ref; let index = $index) {
                        <div class="resource-judgement">
                            <p class="resource-number">
                                Anhang {{ index + 1 }}: {{ resource.safeLabel }}
                            </p>
                            <p class="model ltg-muted">
                                {{ resource.judgement.model }} · Konfidenz
                                {{ judgementConfidence(resource.judgement) }}
                            </p>
                            <p
                                class="basis"
                                [class.weak]="!contentVerified(resource.judgement)"
                            >
                                <ltg-icon
                                    [name]="contentVerified(resource.judgement) ? 'check' : 'alert'"
                                    [size]="14"
                                />
                                <span>{{ basisText(resource.judgement) }}</span>
                            </p>

                            <p class="reasoning">{{ resource.judgement.reasoning }}</p>

                            @if (resource.judgement.uncertainties.length > 0) {
                                <p class="label">Offene Punkte</p>
                                <ul class="open-points">
                                    @for (point of resource.judgement.uncertainties; track point) {
                                        <li>{{ point }}</li>
                                    }
                                </ul>
                            } @else {
                                <p class="ltg-muted small">
                                    Das Modell hat keine offenen Punkte gemeldet.
                                </p>
                            }
                        </div>
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
                @if (action().resources.length === 1) {
                    <button
                        matButton
                        type="button"
                        [disabled]="busy()"
                        matTooltip="Öffnet eine lokale Auswahl. Die Aktion pausiert dabei nur: bestätigst du das bisherige Dokument, wartet sie unverändert weiter."
                        (click)="decide.emit('reselect')"
                    >
                        Andere Ressource wählen
                    </button>
                }
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

        .resource-card + .resource-card,
        .resource-judgement + .resource-judgement {
            margin-top: 1rem;
            padding-top: 1rem;
            border-top: 1px solid var(--mat-sys-outline-variant);
        }

        .resource-number {
            margin: 0 0 0.55rem;
            font-size: 0.75rem;
            font-weight: 700;
            color: var(--mat-sys-on-surface-variant);
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

        .optimization {
            display: flex;
            gap: 0.5rem;
            align-items: flex-start;
            margin: 0.75rem 0 0;
            padding: 0.6rem 0.75rem;
            border-radius: 6px;
            background: rgba(120, 120, 120, 0.09);
            font-size: 0.85rem;
            line-height: 1.45;
        }

        .optimization ltg-icon {
            flex: none;
            opacity: 0.7;
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

        .basis {
            display: flex;
            align-items: flex-start;
            gap: 0.45rem;
            margin: 0 0 0.7rem;
            padding: 0.55rem 0.75rem;
            border-radius: var(--ltg-radius-sm);
            border: 1px solid var(--mat-sys-outline-variant);
            background: var(--mat-sys-surface);
            font-size: 0.82rem;
            line-height: 1.45;
        }

        /* Anything short of "read the document and confirmed it" is marked. */
        .basis.weak {
            border-color: var(--ltg-caution);
            background: var(--ltg-caution-surface);
            color: var(--ltg-caution);
        }

        .excerpt {
            margin: 0;
            padding: 0.75rem 0.9rem;
            border-radius: var(--ltg-radius-sm);
            background: var(--mat-sys-surface);
            border: 1px solid var(--mat-sys-outline-variant);
            font-size: 0.82rem;
            line-height: 1.5;
            white-space: pre-wrap;
            overflow-wrap: anywhere;
            max-height: 14rem;
            overflow-y: auto;
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
    readonly action = input.required<ApiSendActionView>();
    readonly busy = input(false);

    readonly decide = output<ApprovalDecision>();

    protected readonly subject = computed(
        () => this.action().egress.subject || '– kein Betreff –'
    );
    protected readonly heading = computed(() => {
        const resources = this.action().resources;
        return resources.length === 1
            ? resources[0]!.safeLabel
            : `${resources.length} Anhänge zur Freigabe`;
    });
    protected readonly referenceLine = computed(() => {
        const references = this.action().resources.map((resource) => resource.ref);
        return `${references.length === 1 ? 'Referenz' : 'Referenzen'} ${references.join(', ')}`;
    });
    protected readonly overallSensitivity = computed(() => {
        const levels = this.action().resources.map((resource) => resource.judgement.sensitivity);
        return levels.includes('high') ? 'high' : levels.includes('medium') ? 'medium' : 'low';
    });
    protected readonly totalBytes = computed(() => formatBytes(this.action().egress.totalBytes));
    protected readonly createdAt = computed(() => formatTime(this.action().createdAt));

    /**
     * The transformation policy frozen into this action, if it has one. Absent
     * for every target that sends originals untouched, which is the default.
     */
    protected readonly optimization = computed(() => this.action().egress.optimization);

    /** `PDF und JPEG`, from the policy's media types. */
    protected readonly formatList = computed(() => {
        const formats = (this.optimization()?.formats ?? []).map(shortFormat);
        return formats.length <= 1 ? (formats[0] ?? '') : `${formats.slice(0, -1).join(', ')} und ${formats.at(-1)}`;
    });

    /**
     * The digest means two different things depending on whether the action may
     * be optimized, and saying the wrong one is worse than saying nothing.
     */
    protected readonly hashTooltip = computed(() =>
        this.optimization()
            ? 'Digest des Originals. Wird vor der Verarbeitung geprüft; die versendete Datei kann ' +
              'nach einer Verkleinerung einen anderen Digest haben. Das Audit hält beide fest.'
            : 'Digest genau der Bytes, die geplant sind. Vor dem Senden erneut geprüft.'
    );

    /**
     * True only for the one case that deserves no caveat: the model read the
     * document's text and said it is the document the title and purpose
     * describe. Everything else — an excerpt, an unconfirmed reading, metadata
     * alone, or a record from before the gateway tracked this — is marked.
     */
    protected contentVerified(judgement: ApiJudgement): boolean {
        const basis = judgement.basis;
        return basis?.kind === 'fulltext' && basis.contentChecked;
    }

    protected basisText(judgement: ApiJudgement): string {
        const basis = judgement.basis;
        if (!basis) {
            return 'Aus einer älteren Version: es ist nicht festgehalten, ob das Modell den Dokumentinhalt gesehen hat.';
        }
        if (basis.kind === 'none') {
            return 'Ohne Dokumentinhalt beurteilt — nur Titel und Merkmale. Was in der Datei steht, die versandt würde, hat das Modell nicht gesehen.';
        }
        const seen =
            basis.kind === 'fulltext'
                ? `Dokumenttext gelesen (${basis.textChars} Zeichen).`
                : `Nur ein Auszug gelesen (${basis.textChars} Zeichen), nicht das ganze Dokument.`;
        return basis.contentChecked
            ? `${seen} Das Modell bestätigt, dass der Inhalt zu Titel und Zweck passt.`
            : `${seen} Das Modell hat nicht bestätigt, dass der Inhalt zu Titel und Zweck passt.`;
    }

    protected judgementConfidence(judgement: ApiJudgement): string {
        return formatConfidence(judgement.confidence);
    }

    protected resourceModifiedAt(resource: ApiSendActionView['resources'][number]): string {
        return formatTime(resource.modifiedAt);
    }

    protected resourceAttributes(resource: ApiSendActionView['resources'][number]): string {
        return formatAttributes(resource.attributes);
    }

    protected resourceExcerpt(
        resource: ApiSendActionView['resources'][number]
    ): string | null {
        return resource.excerpt?.trim() || null;
    }

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
