import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import type { ApiActionView } from '@gateway/contract';
import { GatewayApi, describeApiError } from '../core/gateway-api';
import { GatewayState } from '../core/gateway-state';
import { Notify } from '../core/notify';
import { Clock } from '../core/clock';
import { countdown } from '../core/format';
import { CountdownLabel } from '../shared/countdown';
import { EmptyState } from '../shared/empty-state';
import { Icon } from '../shared/icon';
import { ApprovalDetail, type ApprovalDecision } from './approval-detail';
import { ApproveDialog, type ApproveDialogData } from './approve-dialog';

/**
 * Pending approvals as a list beside a detail view.
 *
 * The previous interface stacked every pending action as a fully expanded card,
 * which meant that with more than one waiting, deciding about the first required
 * scrolling past the second — and that the two were easy to confuse, since both
 * were on screen in the same shape at the same time. Here exactly one action is
 * ever under review, the list stays scannable, and the selected action's id lives
 * in the URL so a reload comes back to the same one.
 */
@Component({
    selector: 'ltg-approvals-page',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [ApprovalDetail, CountdownLabel, EmptyState, Icon],
    template: `
        @if (actions().length === 0) {
            <ltg-empty
                icon="check"
                headline="Keine Aktion wartet auf eine Freigabe."
                detail="Anfragen von Hermes erscheinen hier, sobald das Gateway eine Aktion vorbereitet hat."
            />
        } @else {
            <div class="split">
                <aside class="list" aria-label="Wartende Freigaben">
                    @for (item of actions(); track item.actionId) {
                        <button
                            type="button"
                            class="row"
                            [class.selected]="item.actionId === selectedId()"
                            [attr.aria-current]="item.actionId === selectedId() ? 'true' : null"
                            (click)="select(item.actionId)"
                        >
                            <span class="dot" [class]="item.judgement.sensitivity"></span>
                            <span class="row-main">
                                <span class="row-title">{{ item.resource.safeLabel }}</span>
                                <span class="row-target">
                                    @if (item.target.dynamicRecipient) {
                                        <span class="flag">
                                            <ltg-icon name="alert" [size]="12" />
                                            freier Empfänger
                                        </span>
                                    }
                                    {{ item.target.label }}
                                </span>
                                <ltg-countdown [expiresAt]="item.expiresAt" />
                            </span>
                            <ltg-icon name="chevron" [size]="16" />
                        </button>
                    }
                </aside>

                <div class="pane">
                    @if (selected(); as action) {
                        <ltg-approval-detail
                            [action]="action"
                            [busy]="busy()"
                            (decide)="decide(action, $event)"
                        />
                    } @else {
                        <ltg-empty
                            icon="chevron"
                            headline="Keine Aktion ausgewählt."
                            detail="Wähle links eine wartende Freigabe aus."
                        />
                    }
                </div>
            </div>
        }
    `,
    styles: `
        .split {
            display: grid;
            grid-template-columns: var(--ltg-list-width) minmax(0, 1fr);
            gap: var(--ltg-gap-lg);
            align-items: start;
        }

        .list {
            display: flex;
            flex-direction: column;
            gap: 0.5rem;
            position: sticky;
            top: 7.5rem;
            max-height: calc(100vh - 9rem);
            overflow-y: auto;
        }

        .row {
            display: flex;
            align-items: center;
            gap: 0.7rem;
            width: 100%;
            padding: 0.8rem 0.9rem;
            border: 1px solid var(--mat-sys-outline-variant);
            border-radius: var(--ltg-radius);
            background: var(--mat-sys-surface-container-low);
            color: inherit;
            font: inherit;
            text-align: left;
            cursor: pointer;
            transition:
                border-color 0.15s ease,
                background-color 0.15s ease;
        }

        .row:hover {
            background: var(--mat-sys-surface-container);
            border-color: var(--mat-sys-outline);
        }

        .row.selected {
            border-color: var(--mat-sys-primary);
            background: var(--mat-sys-surface-container-high);
        }

        .dot {
            width: 0.55rem;
            height: 0.55rem;
            border-radius: 999px;
            flex: none;
            align-self: flex-start;
            margin-top: 0.4rem;
        }

        .dot.low {
            background: var(--ltg-settled);
        }

        .dot.medium {
            background: var(--ltg-caution);
        }

        .dot.high {
            background: var(--ltg-alarm);
        }

        .row-main {
            display: flex;
            flex-direction: column;
            gap: 0.25rem;
            min-width: 0;
            flex: 1;
        }

        .row-title {
            font-weight: 600;
            font-size: 0.9rem;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .row-target {
            font-size: 0.79rem;
            color: var(--mat-sys-on-surface-variant);
            display: flex;
            align-items: center;
            gap: 0.4rem;
            flex-wrap: wrap;
        }

        .flag {
            display: inline-flex;
            align-items: center;
            gap: 0.25rem;
            padding: 0.05rem 0.4rem;
            border-radius: 999px;
            background: var(--ltg-alarm-surface);
            color: var(--ltg-alarm);
            font-size: 0.7rem;
            font-weight: 700;
        }

        @media (max-width: 1024px) {
            .split {
                grid-template-columns: 1fr;
            }

            .list {
                position: static;
                max-height: none;
                flex-direction: row;
                overflow-x: auto;
                padding-bottom: 0.25rem;
            }

            .row {
                min-width: 16rem;
            }
        }
    `
})
export class ApprovalsPage {
    /** Bound from `?action=` by `withComponentInputBinding`. */
    readonly action = input<string | undefined>(undefined);

    private readonly state = inject(GatewayState);
    private readonly api = inject(GatewayApi);
    private readonly notify = inject(Notify);
    private readonly dialog = inject(MatDialog);
    private readonly router = inject(Router);
    private readonly clock = inject(Clock);

    protected readonly actions = this.state.actions;
    protected readonly busy = signal(false);

    /**
     * Which action the URL asks for, falling back to the first pending one.
     *
     * Derived rather than stored, so an action that is approved elsewhere — or
     * that simply expires while the tab sits open — cannot leave a detail view of
     * something that no longer exists on screen.
     */
    protected readonly selectedId = computed(() => {
        const requested = this.action();
        const list = this.actions();
        if (requested && list.some((candidate) => candidate.actionId === requested)) {
            return requested;
        }
        return list[0]?.actionId;
    });

    protected readonly selected = computed(() =>
        this.actions().find((candidate) => candidate.actionId === this.selectedId())
    );

    constructor() {
        // Keep the URL honest when the fallback picked something other than what
        // was asked for, so a reload does not bounce between two actions.
        effect(() => {
            const resolved = this.selectedId();
            if (resolved && resolved !== this.action()) {
                void this.router.navigate([], {
                    queryParams: { action: resolved },
                    replaceUrl: true
                });
            }
        });
    }

    protected select(actionId: string): void {
        void this.router.navigate([], { queryParams: { action: actionId } });
    }

    protected async decide(action: ApiActionView, decision: ApprovalDecision): Promise<void> {
        if (this.busy()) {
            return;
        }
        if (decision === 'approve' && !(await this.confirmApproval(action))) {
            return;
        }

        this.busy.set(true);
        try {
            switch (decision) {
                case 'approve':
                    await this.api.approve(action.actionId, action.bindingHash);
                    this.notify.ok('Freigegeben. Die Übertragung läuft.');
                    break;
                case 'reject':
                    await this.api.reject(action.actionId);
                    this.notify.ok('Aktion abgelehnt.');
                    break;
                case 'discard':
                    await this.api.discard(action.actionId);
                    this.notify.ok('Aktion verworfen. Hermes muss sie neu vorbereiten.');
                    break;
                case 'reselect': {
                    await this.api.reselect(action.actionId);
                    this.notify.ok(
                        'Auswahl geöffnet. Die Freigabe pausiert so lange und ist nicht abgelehnt.'
                    );
                    await this.router.navigate(['/app/selections']);
                    break;
                }
            }
        } catch (error) {
            this.notify.error(describeApiError(error));
        } finally {
            this.busy.set(false);
            await this.state.refresh();
        }
    }

    private async confirmApproval(action: ApiActionView): Promise<boolean> {
        // Refuse before opening the dialog rather than after: an expired action is
        // rejected by the server anyway, and a confirmation dialog for something
        // that cannot succeed only teaches the user to click through them.
        if (countdown(action.expiresAt, this.clock.now()).expired) {
            this.notify.error(
                'Diese Aktion ist abgelaufen und kann nicht mehr freigegeben werden. Hermes muss sie neu vorbereiten.'
            );
            return false;
        }
        const ref = this.dialog.open<ApproveDialog, ApproveDialogData, boolean>(ApproveDialog, {
            data: { action },
            width: 'min(38rem, 94vw)',
            autoFocus: 'dialog'
        });
        return (await firstValueFrom(ref.afterClosed())) === true;
    }
}
