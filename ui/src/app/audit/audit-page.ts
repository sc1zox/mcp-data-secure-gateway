import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import type { ApiAuditEvent } from '@gateway/contract';
import { GatewayApi, describeApiError } from '../core/gateway-api';
import { Notify } from '../core/notify';
import { formatTime } from '../core/format';
import { EmptyState } from '../shared/empty-state';
import { Icon } from '../shared/icon';

/**
 * The local decision trail.
 *
 * Fetched on demand rather than polled: unlike the pending list, nothing here
 * changes what the user can still decide, and the file is append-only, so a
 * refresh button is both sufficient and honest about when the data was read.
 *
 * Event details are rendered as formatted JSON on purpose. This is the record the
 * user reconstructs an incident from, and a prettified summary would be a second
 * interpretation of something that already has an authoritative form on disk.
 */
@Component({
    selector: 'ltg-audit-page',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [MatButtonModule, MatTooltipModule, EmptyState, Icon],
    template: `
        <div class="bar">
            <p class="ltg-muted">
                Lokales Entscheidungsprotokoll. Es bleibt auf diesem Rechner und wird nie an
                Hermes übertragen.
            </p>
            <button matButton type="button" [disabled]="loading()" (click)="reload()">
                <ltg-icon name="refresh" [size]="16" />
                {{ loading() ? 'lädt …' : 'Neu laden' }}
            </button>
        </div>

        @if (events().length === 0) {
            <ltg-empty
                icon="document"
                headline="Noch keine Einträge."
                [detail]="loaded() ? 'Das Protokoll ist leer.' : 'Wird geladen …'"
            />
        } @else {
            <ul class="trail">
                @for (event of events(); track event.eventId) {
                    <li>
                        <span class="when" [matTooltip]="event.eventId" matTooltipPosition="right">
                            {{ time(event.ts) }}
                        </span>
                        <span class="type" [class.blocked]="isBlocking(event)">{{ event.type }}</span>
                        <span class="ref ltg-mono">{{ subject(event) }}</span>
                        @if (detail(event); as json) {
                            <pre class="detail">{{ json }}</pre>
                        }
                    </li>
                }
            </ul>
        }
    `,
    styles: `
        .bar {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: var(--ltg-gap);
            flex-wrap: wrap;
            margin-bottom: var(--ltg-gap);
        }

        .bar p {
            margin: 0;
            font-size: 0.85rem;
        }

        .trail {
            list-style: none;
            margin: 0;
            padding: 0;
            display: flex;
            flex-direction: column;
            gap: 0.4rem;
        }

        .trail li {
            display: grid;
            grid-template-columns: 11rem 14rem 1fr;
            gap: 0.3rem 0.9rem;
            padding: 0.65rem 0.9rem;
            border: 1px solid var(--mat-sys-outline-variant);
            border-radius: var(--ltg-radius);
            background: var(--mat-sys-surface-container-low);
            font-size: 0.82rem;
        }

        .when {
            color: var(--mat-sys-on-surface-variant);
            font-variant-numeric: tabular-nums;
            cursor: help;
        }

        .type {
            font-family: var(--ltg-mono);
            font-weight: 600;
            overflow-wrap: anywhere;
        }

        .type.blocked {
            color: var(--ltg-alarm);
        }

        .ref {
            color: var(--mat-sys-on-surface-variant);
        }

        .detail {
            grid-column: 1 / -1;
            margin: 0.35rem 0 0;
            padding: 0.6rem 0.75rem;
            border-radius: var(--ltg-radius-sm);
            background: var(--mat-sys-surface);
            border: 1px solid var(--mat-sys-outline-variant);
            font-family: var(--ltg-mono);
            font-size: 0.75rem;
            line-height: 1.45;
            white-space: pre-wrap;
            overflow-wrap: anywhere;
            max-height: 16rem;
            overflow-y: auto;
        }

        @media (max-width: 900px) {
            .trail li {
                grid-template-columns: 1fr;
            }
        }
    `
})
export class AuditPage {
    private readonly api = inject(GatewayApi);
    private readonly notify = inject(Notify);

    protected readonly events = signal<ApiAuditEvent[]>([]);
    protected readonly loading = signal(false);
    protected readonly loaded = signal(false);

    /** Events that record something the gateway refused to do. */
    private readonly blocking = computed(
        () =>
            new Set<string>([
                'invariant_blocked',
                'hermes_request_rejected',
                'action_binding_mismatch',
                'reference_rejected',
                'judge_output_rejected',
                'egress_failed'
            ])
    );

    constructor() {
        void this.reload();
    }

    protected async reload(): Promise<void> {
        if (this.loading()) {
            return;
        }
        this.loading.set(true);
        try {
            const response = await this.api.audit();
            this.events.set(response.events);
            this.loaded.set(true);
        } catch (error) {
            this.notify.error(`Protokoll nicht lesbar: ${describeApiError(error)}`);
        } finally {
            this.loading.set(false);
        }
    }

    protected time(iso: string): string {
        return formatTime(iso);
    }

    protected isBlocking(event: ApiAuditEvent): boolean {
        return this.blocking().has(event.type);
    }

    protected subject(event: ApiAuditEvent): string {
        return event.actionId ?? event.resourceRef ?? event.selectionId ?? event.sourceId ?? '';
    }

    protected detail(event: ApiAuditEvent): string {
        return event.detail ? JSON.stringify(event.detail, null, 2) : '';
    }
}
