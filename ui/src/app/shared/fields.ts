import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * A label/value pair inside a `ltg-fields` list.
 *
 * Content projection rather than a string input, so a value can be a formatted
 * string, a monospace hash or a nested component without this component needing
 * to know which. Values always arrive as text bound by Angular, never as markup —
 * every string on this screen may originate from a document the gateway did not
 * author, and interpolation is what keeps a title containing angle brackets a
 * title rather than part of the page.
 */
@Component({
    selector: 'ltg-field',
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        <dt>{{ label() }}</dt>
        <dd><ng-content /></dd>
    `,
    styles: `
        :host {
            display: contents;
        }

        dt {
            color: var(--mat-sys-on-surface-variant);
            font-size: 0.8rem;
            padding-top: 0.1rem;
        }

        dd {
            margin: 0;
            overflow-wrap: anywhere;
        }
    `
})
export class Field {
    readonly label = input.required<string>();
}

@Component({
    selector: 'ltg-fields',
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `<dl><ng-content /></dl>`,
    styles: `
        dl {
            display: grid;
            grid-template-columns: minmax(8rem, max-content) 1fr;
            gap: 0.5rem 1.25rem;
            margin: 0;
        }

        @media (max-width: 700px) {
            dl {
                grid-template-columns: 1fr;
                gap: 0.15rem 0;
            }
        }
    `
})
export class Fields {}
