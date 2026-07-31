import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import type { ApiActionView } from '@gateway/contract';
import { formatBytes, shortFormat } from '../core/format';
import { Icon } from '../shared/icon';

/**
 * The last screen before private data leaves the machine.
 *
 * It replaces a `window.confirm` whose text the browser rendered as an unstyled
 * blob — which meant the one field that most deserves emphasis, an agent-proposed
 * recipient address, looked exactly like everything else. Here it is the largest
 * thing in the dialog, in a monospace face so that a swapped character in a
 * lookalike domain is visible rather than merely present.
 *
 * Both kinds of action can require an explicit acknowledgement before the
 * confirm button unlocks, and in both cases it guards the same thing: the one
 * piece of the payload that neither the user nor the local configuration wrote.
 * For a dynamic recipient that is the address the remote agent proposed. For a
 * summary it is the entire text, written by a model from a document the user is
 * not currently looking at — so the dialog repeats it in full rather than
 * summarising the summary, and asks the user to confirm having read it.
 */
export interface ApproveDialogData {
    action: ApiActionView;
}

@Component({
    selector: 'ltg-approve-dialog',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [FormsModule, MatButtonModule, MatCheckboxModule, MatDialogModule, Icon],
    template: `
        <h2 mat-dialog-title>
            {{ summary ? 'Text an den Agenten freigeben?' : 'Übertragung freigeben?' }}
        </h2>

        <mat-dialog-content>
            @if (summary; as plan) {
                <div class="alarm">
                    <ltg-icon name="alert" [size]="18" />
                    <div>
                        <p class="alarm-head">Diese Zeichen gehen an den Cloud-Agenten</p>
                        <p class="alarm-body">
                            Danach ist der Text dort und lässt sich nicht zurückholen. Das
                            Originaldokument bleibt hier.
                        </p>
                    </div>
                </div>
                <pre class="summary-text">{{ plan.text }}</pre>

                @if (plan.residuals.length > 0) {
                    <p class="residual">
                        Offen aus der lokalen Mustersuche:
                        @for (finding of plan.residuals; track finding.sample) {
                            <span class="residual-item">{{ finding.kind }}</span>
                        }
                    </p>
                }

                <dl class="facts">
                    <dt>Ressource</dt>
                    <dd>{{ action.resource.title }}</dd>

                    <dt>Umfang</dt>
                    <dd>{{ plan.chars }} Zeichen · verfasst von {{ plan.model }}</dd>
                </dl>

                <p class="scope">
                    Die Freigabe gilt für genau diesen Text. Ändert sich daran etwas, verfällt sie.
                </p>

                <mat-checkbox [(ngModel)]="acknowledged">
                    Ich habe den Text gelesen und er enthält keine Angaben, die den Rechner nicht
                    verlassen dürfen.
                </mat-checkbox>
            } @else if (action.kind === 'send_resource') {
                @if (action.target.dynamicRecipient) {
                    <div class="alarm">
                        <ltg-icon name="alert" [size]="18" />
                        <div>
                            <p class="alarm-head">Empfänger wurde vom Agenten vorgeschlagen</p>
                            <p class="alarm-body">
                                Diese Adresse steht nicht in deiner lokalen Konfiguration. Prüfe
                                sie zeichenweise auf Tippfehler und ähnlich aussehende Domains.
                            </p>
                        </div>
                    </div>
                    <p class="address">{{ action.target.recipientDisplay }}</p>
                }

                <dl class="facts">
                    <dt>Ressourcen</dt>
                    <dd>
                        @for (resource of action.resources; track resource.ref; let index = $index) {
                            <span class="file">
                                {{ index + 1 }}. {{ resource.title }}
                                <span class="ltg-muted">({{ resource.ref }})</span>
                            </span>
                        }
                    </dd>

                    <dt>Ziel</dt>
                    <dd>
                        {{ action.target.label }}
                        @if (!action.target.dynamicRecipient) {
                            <span class="ltg-mono"> → {{ action.target.recipientDisplay }}</span>
                        }
                    </dd>

                    <dt>Betreff</dt>
                    <dd>
                        {{ action.egress.subject || '– kein Betreff –' }}
                        @if (action.egress.authoredByAgent.subject) {
                            <span class="by-agent">vom Agenten</span>
                        }
                    </dd>

                    @if (action.egress.authoredByAgent.body) {
                        <dt>Nachrichtentext</dt>
                        <dd>
                            <span class="by-agent">vom Agenten</span>
                            <span class="agent-hint">
                                geht wörtlich hinaus, ohne Zusatz des Gateways
                            </span>
                        </dd>
                    }

                    <dt>Anhänge</dt>
                    <dd>
                        {{ action.egress.attachments.length }} ·
                        {{ totalBytes() }}
                        @for (attachment of action.egress.attachments; track $index) {
                            <span class="file">{{ attachment.filename }}</span>
                        }
                    </dd>

                    @if (optimization(); as policy) {
                        <dt>Verkleinerung</dt>
                        <dd>
                            erlaubt bis <strong>{{ policy.maxProfile }}</strong>, nur
                            {{ formatList() }}
                            <span class="agent-hint">
                                greift nur, falls die Menge sonst nicht unter das Limit des Ziels
                                passt
                            </span>
                        </dd>
                    }
                </dl>

                <p class="scope">
                    Die Freigabe gilt ausschließlich für genau diese geordnete Ressourcen- und
                    Anhangsmenge, dieses Ziel und diesen Inhalt. Ändert sich davon etwas, verfällt
                    sie.
                    @if (optimization()) {
                        Die oben genannte Größe ist die der Originale; nach einer Verkleinerung
                        gehen kleinere Dateien gleichen Namens und Formats hinaus.
                    }
                </p>

                @if (action.target.dynamicRecipient) {
                    <mat-checkbox [(ngModel)]="acknowledged">
                        Ich habe die Empfängeradresse geprüft.
                    </mat-checkbox>
                }
            }
        </mat-dialog-content>

        <mat-dialog-actions align="end">
            <button matButton type="button" [mat-dialog-close]="false">Abbrechen</button>
            <button
                matButton="filled"
                type="button"
                class="confirm"
                [disabled]="!canConfirm()"
                [mat-dialog-close]="true"
            >
                Freigeben und übertragen
            </button>
        </mat-dialog-actions>
    `,
    styles: `
        mat-dialog-content {
            display: flex;
            flex-direction: column;
            gap: var(--ltg-gap);
        }

        .alarm {
            display: flex;
            gap: 0.6rem;
            padding: 0.8rem 0.95rem;
            border-radius: var(--ltg-radius-sm);
            border: 1px solid var(--ltg-alarm);
            background: var(--ltg-alarm-surface);
            color: var(--ltg-alarm);
        }

        .alarm-head {
            margin: 0;
            font-weight: 700;
            font-size: 0.88rem;
        }

        .alarm-body {
            margin: 0.25rem 0 0;
            font-size: 0.82rem;
        }

        .address {
            margin: 0;
            padding: 0.75rem 0.9rem;
            border-radius: var(--ltg-radius-sm);
            background: var(--mat-sys-surface-container-highest);
            font-family: var(--ltg-mono);
            font-size: 1.05rem;
            font-weight: 600;
            letter-spacing: 0.02em;
            overflow-wrap: anywhere;
            text-align: center;
        }

        /*
         * The text is repeated here in full rather than referred back to. The
         * detail view is behind a modal at this point, and "you already read it"
         * is exactly the assumption this dialog exists to stop relying on.
         */
        .summary-text {
            margin: 0;
            padding: 0.9rem 1rem;
            border-radius: var(--ltg-radius-sm);
            border: 1px solid var(--ltg-alarm);
            background: var(--ltg-alarm-surface);
            color: var(--mat-sys-on-surface);
            font-family: var(--ltg-mono);
            font-size: 0.82rem;
            line-height: 1.6;
            white-space: pre-wrap;
            overflow-wrap: anywhere;
            max-height: 22rem;
            overflow-y: auto;
        }

        .residual {
            margin: 0;
            font-size: 0.82rem;
            color: var(--ltg-alarm);
            font-weight: 600;
        }

        .residual-item {
            margin-left: 0.35rem;
            padding: 0.05rem 0.4rem;
            border-radius: 999px;
            background: var(--ltg-alarm-surface);
        }

        .facts {
            display: grid;
            grid-template-columns: minmax(6rem, max-content) 1fr;
            gap: 0.45rem 1rem;
            margin: 0;
        }

        .facts dt {
            color: var(--mat-sys-on-surface-variant);
            font-size: 0.8rem;
        }

        .facts dd {
            margin: 0;
            overflow-wrap: anywhere;
        }

        .by-agent {
            display: inline-block;
            padding: 0.05rem 0.4rem;
            border-radius: 999px;
            background: var(--ltg-caution-surface);
            color: var(--ltg-caution);
            font-size: 0.68rem;
            font-weight: 700;
        }

        .agent-hint {
            margin-left: 0.4rem;
            font-size: 0.8rem;
            color: var(--mat-sys-on-surface-variant);
        }

        .file {
            display: block;
            font-family: var(--ltg-mono);
            font-size: 0.78rem;
            color: var(--mat-sys-on-surface-variant);
        }

        .scope {
            margin: 0;
            font-size: 0.82rem;
            color: var(--mat-sys-on-surface-variant);
        }

        .confirm {
            --mat-button-filled-container-color: var(--ltg-settled);
            --mat-button-filled-label-text-color: #04140c;
        }
    `
})
export class ApproveDialog {
    private readonly data = inject<ApproveDialogData>(MAT_DIALOG_DATA);

    protected readonly action = this.data.action;
    protected readonly acknowledged = signal(false);

    /** The summary plan, or `undefined` for a transfer. Drives the whole layout. */
    protected readonly summary =
        this.action.kind === 'summarize_resource' ? this.action.summary : undefined;

    protected readonly totalBytes = computed(() =>
        formatBytes(this.action.kind === 'send_resource' ? this.action.egress.totalBytes : 0)
    );

    /** The transformation policy this approval binds, if the target has one. */
    protected readonly optimization = computed(() =>
        this.action.kind === 'send_resource' ? this.action.egress.optimization : undefined
    );

    /** `PDF und JPEG`, from the policy's media types. */
    protected readonly formatList = computed(() => {
        const formats = (this.optimization()?.formats ?? []).map(shortFormat);
        return formats.length <= 1 ? (formats[0] ?? '') : `${formats.slice(0, -1).join(', ')} und ${formats.at(-1)}`;
    });

    /**
     * Both acknowledgements guard the same thing: a part of the payload that
     * came from the remote agent or from a model rather than from the user or
     * the local configuration.
     */
    protected readonly canConfirm = computed(() => {
        if (this.action.kind === 'summarize_resource') {
            return this.acknowledged();
        }
        return !this.action.target.dynamicRecipient || this.acknowledged();
    });
}
