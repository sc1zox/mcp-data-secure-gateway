import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { Icon, type IconName } from './icon';

/**
 * "Nothing here" as a deliberate statement rather than a blank area.
 *
 * On this screen an empty list is information — no request is waiting for a
 * decision — and it should read as a reassuring answer, not as something that
 * failed to load.
 */
@Component({
    selector: 'ltg-empty',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [Icon],
    template: `
        <div class="box">
            <ltg-icon [name]="icon()" [size]="26" />
            <p class="headline">{{ headline() }}</p>
            @if (detail()) {
                <p class="detail">{{ detail() }}</p>
            }
        </div>
    `,
    styles: `
        .box {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 0.5rem;
            padding: 3rem 1.5rem;
            border: 1px dashed var(--mat-sys-outline-variant);
            border-radius: var(--ltg-radius-lg);
            background: var(--mat-sys-surface-container-low);
            color: var(--mat-sys-on-surface-variant);
            text-align: center;
        }

        .headline {
            margin: 0;
            font-weight: 600;
            color: var(--mat-sys-on-surface);
        }

        .detail {
            margin: 0;
            font-size: 0.85rem;
            max-width: 34rem;
        }
    `
})
export class EmptyState {
    readonly icon = input<IconName>('check');
    readonly headline = input.required<string>();
    readonly detail = input<string>('');
}
