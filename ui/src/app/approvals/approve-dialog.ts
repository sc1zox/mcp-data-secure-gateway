import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import type { ApiActionView } from '@gateway/contract';
import { formatBytes } from '../core/format';
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
 * For a dynamic recipient the confirm button additionally waits on an explicit
 * acknowledgement. That is not ceremony: for those targets the address was chosen
 * by the remote agent rather than by local configuration, so it is the single
 * field on screen that an attacker had any influence over.
 */
export interface ApproveDialogData {
    action: ApiActionView;
}

@Component({
    selector: 'ltg-approve-dialog',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [FormsModule, MatButtonModule, MatCheckboxModule, MatDialogModule, Icon],
    template: `
        <h2 mat-dialog-title>Übertragung freigeben?</h2>

        <mat-dialog-content>
            @if (action.target.dynamicRecipient) {
                <div class="alarm">
                    <ltg-icon name="alert" [size]="18" />
                    <div>
                        <p class="alarm-head">Empfänger wurde vom Agenten vorgeschlagen</p>
                        <p class="alarm-body">
                            Diese Adresse steht nicht in deiner lokalen Konfiguration. Prüfe sie
                            zeichenweise auf Tippfehler und ähnlich aussehende Domains.
                        </p>
                    </div>
                </div>
                <p class="address">{{ action.target.recipientDisplay }}</p>
            }

            <dl class="facts">
                <dt>Ressource</dt>
                <dd>{{ action.resource.title }}</dd>

                <dt>Ziel</dt>
                <dd>
                    {{ action.target.label }}
                    @if (!action.target.dynamicRecipient) {
                        <span class="ltg-mono"> → {{ action.target.recipientDisplay }}</span>
                    }
                </dd>

                <dt>Betreff</dt>
                <dd>{{ action.egress.subject || '– kein Betreff –' }}</dd>

                <dt>Anhänge</dt>
                <dd>
                    {{ action.egress.attachments.length }} ·
                    {{ totalBytes() }}
                    @for (attachment of action.egress.attachments; track attachment.sha256) {
                        <span class="file">{{ attachment.filename }}</span>
                    }
                </dd>
            </dl>

            <p class="scope">
                Die Freigabe gilt ausschließlich für genau diese Kombination aus Ressource, Ziel
                und Inhalt. Ändert sich davon etwas, verfällt sie.
            </p>

            @if (action.target.dynamicRecipient) {
                <mat-checkbox [(ngModel)]="acknowledged">
                    Ich habe die Empfängeradresse geprüft.
                </mat-checkbox>
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

    protected readonly totalBytes = computed(() => formatBytes(this.action.egress.totalBytes));

    protected readonly canConfirm = computed(
        () => !this.action.target.dynamicRecipient || this.acknowledged()
    );
}
