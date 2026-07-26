import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/**
 * Icons as inline SVG paths.
 *
 * `mat-icon` normally reaches for the Material Symbols web font, and registering
 * SVG icons through `MatIconRegistry` fetches them over HTTP. This page is served
 * under `default-src 'none'` with `font-src 'none'` and is expected to work with
 * no network at all, so both are out. A closed set of paths compiled into the
 * bundle costs a few hundred bytes and removes the failure mode where the
 * interface renders as a column of empty boxes.
 */
export type IconName =
    | 'shield'
    | 'alert'
    | 'check'
    | 'close'
    | 'clock'
    | 'mail'
    | 'document'
    | 'search'
    | 'logout'
    | 'chevron'
    | 'link'
    | 'refresh';

const PATHS: Readonly<Record<IconName, string>> = {
    shield: 'M12 2.5l7.5 3.2v5.1c0 5-3.2 8.9-7.5 10.7-4.3-1.8-7.5-5.7-7.5-10.7V5.7L12 2.5z',
    alert: 'M12 3.2l9 15.6H3l9-15.6zM12 9v5M12 17.2v.1',
    check: 'M4.5 12.5l5 5 10-11',
    close: 'M6 6l12 12M18 6L6 18',
    clock: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5.2l3.4 2',
    mail: 'M3.5 6.5h17v11h-17v-11zM3.5 7l8.5 6 8.5-6',
    document: 'M6 3.5h7l5 5v12H6v-17zM13 3.5V9h5',
    search: 'M11 18a7 7 0 100-14 7 7 0 000 14zM16.2 16.2L21 21',
    logout: 'M15 8.5V5.5h-10v13h10v-3M10.5 12h10.5M18 8.5l3.5 3.5-3.5 3.5',
    chevron: 'M9 5l7 7-7 7',
    link: 'M10.5 13.5a4 4 0 005.7 0l3-3a4 4 0 10-5.7-5.7l-1.4 1.4M13.5 10.5a4 4 0 00-5.7 0l-3 3a4 4 0 105.7 5.7l1.4-1.4',
    refresh: 'M20 12a8 8 0 11-2.4-5.7M20 4v4.5h-4.5'
};

@Component({
    selector: 'ltg-icon',
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        <svg
            [attr.width]="size()"
            [attr.height]="size()"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
            focusable="false"
        >
            <path [attr.d]="path()" />
        </svg>
    `,
    styles: `
        :host {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            flex: none;
        }
    `
})
export class Icon {
    readonly name = input.required<IconName>();
    readonly size = input(18);

    protected readonly path = computed(() => PATHS[this.name()]);
}
