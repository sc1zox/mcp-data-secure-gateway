import { Injectable, type OnDestroy, signal } from '@angular/core';

/**
 * A shared one-second tick.
 *
 * Actions and selections expire, and the countdown next to them is not decoration:
 * approving something seconds before it lapses fails, and the user should be able
 * to see that coming. Every countdown on screen reads this one signal rather than
 * starting its own timer, so a list of twenty pending actions still costs one
 * interval and one change-detection pass per second.
 */
@Injectable({ providedIn: 'root' })
export class Clock implements OnDestroy {
    private readonly _now = signal(Date.now());
    private readonly handle = setInterval(() => this._now.set(Date.now()), 1000);

    readonly now = this._now.asReadonly();

    ngOnDestroy(): void {
        clearInterval(this.handle);
    }
}
