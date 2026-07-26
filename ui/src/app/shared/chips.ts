import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { ApiActionStatus, ApiSensitivity } from '@gateway/contract';

/**
 * How sensitive the local model judged the content to be.
 *
 * Rendered as the model's opinion, not as a verdict: the wording says who said
 * it. The colour still escalates, because a "high" reading is the single best
 * reason to slow down and read the rest of the screen.
 */
@Component({
    selector: 'ltg-sensitivity',
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `<span class="chip" [class]="tone()">{{ label() }}</span>`,
    styles: `
        .chip {
            display: inline-flex;
            align-items: center;
            gap: 0.4em;
            padding: 0.2rem 0.65rem;
            border-radius: 999px;
            border: 1px solid currentColor;
            font-size: 0.72rem;
            font-weight: 600;
            letter-spacing: 0.01em;
            white-space: nowrap;
        }

        .chip::before {
            content: '';
            width: 0.4em;
            height: 0.4em;
            border-radius: 999px;
            background: currentColor;
        }

        .low {
            color: var(--ltg-settled);
            background: var(--ltg-settled-surface);
        }

        .medium {
            color: var(--ltg-caution);
            background: var(--ltg-caution-surface);
        }

        .high {
            color: var(--ltg-alarm);
            background: var(--ltg-alarm-surface);
        }
    `
})
export class SensitivityChip {
    readonly level = input.required<ApiSensitivity>();

    protected readonly tone = computed(() => this.level());
    protected readonly label = computed(
        () =>
            ({
                low: 'Sensibilität niedrig',
                medium: 'Sensibilität mittel',
                high: 'Sensibilität hoch'
            })[this.level()]
    );
}

const STATUS_LABELS: Readonly<Record<ApiActionStatus, string>> = {
    awaiting_local_approval: 'wartet auf Freigabe',
    selection_required: 'Auswahl nötig',
    executing: 'wird ausgeführt',
    completed: 'abgeschlossen',
    rejected: 'abgelehnt',
    failed: 'fehlgeschlagen',
    expired: 'abgelaufen'
};

const STATUS_TONES: Readonly<Record<ApiActionStatus, 'ok' | 'warn' | 'danger' | 'neutral'>> = {
    awaiting_local_approval: 'warn',
    selection_required: 'warn',
    executing: 'neutral',
    completed: 'ok',
    rejected: 'danger',
    failed: 'danger',
    expired: 'neutral'
};

@Component({
    selector: 'ltg-status',
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `<span class="chip" [class]="tone()">{{ label() }}</span>`,
    styles: `
        .chip {
            display: inline-flex;
            align-items: center;
            padding: 0.15rem 0.6rem;
            border-radius: 999px;
            border: 1px solid currentColor;
            font-size: 0.72rem;
            font-weight: 600;
            white-space: nowrap;
        }

        .ok {
            color: var(--ltg-settled);
            background: var(--ltg-settled-surface);
        }

        .warn {
            color: var(--ltg-caution);
            background: var(--ltg-caution-surface);
        }

        .danger {
            color: var(--ltg-alarm);
            background: var(--ltg-alarm-surface);
        }

        .neutral {
            color: var(--mat-sys-on-surface-variant);
            background: var(--mat-sys-surface-container);
        }
    `
})
export class StatusChip {
    readonly status = input.required<ApiActionStatus>();

    protected readonly label = computed(() => STATUS_LABELS[this.status()]);
    protected readonly tone = computed(() => STATUS_TONES[this.status()]);
}
