/**
 * Direction preservation for `awaitActionDecision`: Hermes learns about a
 * decision by waiting on an open call, never by the gateway calling out. This
 * class only tracks who is waiting on which action and wakes them; it has no
 * opinion on what a decision means.
 */
export class DecisionWaiters {
    private readonly waiters = new Map<string, Set<() => void>>();

    /** Resolves on the next transition of this action, or after `timeoutMs`. */
    wait(actionId: string, timeoutMs: number): Promise<void> {
        return new Promise<void>((resolveWait) => {
            let waiters = this.waiters.get(actionId);
            if (!waiters) {
                waiters = new Set();
                this.waiters.set(actionId, waiters);
            }
            const wake = (): void => {
                clearTimeout(timer);
                waiters!.delete(wake);
                if (waiters!.size === 0) {
                    this.waiters.delete(actionId);
                }
                resolveWait();
            };
            // Deliberately not unref'd: this timer is the only thing holding an
            // in-flight tool call open, and a call that is still owed an answer
            // is a reason for the process to stay up.
            const timer = setTimeout(wake, timeoutMs);
            waiters.add(wake);
        });
    }

    wake(actionId: string): void {
        const waiters = this.waiters.get(actionId);
        if (!waiters) {
            return;
        }
        for (const wake of [...waiters]) {
            wake();
        }
    }
}
