import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

/**
 * The application root does nothing on purpose: routing decides what is on
 * screen, and the auth guard decides whether the current URL is reachable at all.
 * Anything this component did instead would be a second opinion on that.
 */
@Component({
    selector: 'ltg-root',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [RouterOutlet],
    template: '<router-outlet />',
    styles: `
        :host {
            display: block;
            min-height: 100vh;
        }
    `
})
export class App {}
