import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { Clock } from '../core/clock';
import { countdown } from '../core/format';
import { Icon } from './icon';

/**
 * Time left before an action or selection lapses.
 *
 * Worth its own component because the number is operationally meaningful: an
 * approval clicked after expiry is refused by the server, and the user deserves
 * to see that coming rather than discover it in an error message.
 */
@Component({
    selector: 'ltg-countdown',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [Icon],
    template: `
        <span class="wrap" [class.urgent]="state().urgent" [class.expired]="state().expired">
            <ltg-icon name="clock" [size]="14" />
            <span>{{ state().expired ? 'abgelaufen' : 'noch ' + state().text }}</span>
        </span>
    `,
    styles: `
        .wrap {
            display: inline-flex;
            align-items: center;
            gap: 0.35rem;
            font-size: 0.78rem;
            font-variant-numeric: tabular-nums;
            color: var(--mat-sys-on-surface-variant);
            white-space: nowrap;
        }

        .urgent {
            color: var(--ltg-caution);
            font-weight: 600;
        }

        .expired {
            color: var(--ltg-alarm);
            font-weight: 600;
        }
    `
})
export class CountdownLabel {
    readonly expiresAt = input.required<string>();

    private readonly clock = inject(Clock);

    protected readonly state = computed(() => countdown(this.expiresAt(), this.clock.now()));
}
