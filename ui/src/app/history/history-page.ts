import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatTooltipModule } from '@angular/material/tooltip';
import type { ApiActionStatusReason, ApiHistoryEntry } from '@gateway/contract';
import { GatewayState } from '../core/gateway-state';
import { Clock } from '../core/clock';
import { UNKNOWN, formatBytes, formatRelative, formatTime } from '../core/format';
import { EmptyState } from '../shared/empty-state';
import { StatusChip } from '../shared/chips';
import { Icon } from '../shared/icon';

/**
 * The gateway's coarse status reasons, in the words a person would use.
 *
 * These come from a deliberately narrow set — it is the same vocabulary Hermes is
 * allowed to learn, so it describes the workflow without describing the content.
 * Spelling them out here is what turns `user_discarded` into something readable
 * without widening what the gateway actually says.
 */
const REASONS: Readonly<Record<ApiActionStatusReason, string>> = {
    awaiting_user: 'wartet auf dich',
    user_rejected: 'von dir abgelehnt',
    user_discarded: 'von dir verworfen',
    resource_changed: 'Ressource hatte sich geändert',
    resource_expired: 'Referenz abgelaufen',
    action_expired: 'Aktion abgelaufen',
    selection_pending: 'Auswahl offen',
    target_unavailable: 'Ziel nicht erreichbar',
    source_unavailable: 'Quelle nicht erreichbar',
    local_model_unavailable: 'lokales Modell nicht erreichbar',
    delivery_failed: 'Zustellung fehlgeschlagen',
    delivered: 'zugestellt',
    summary_released: 'Zusammenfassung freigegeben'
};

@Component({
    selector: 'ltg-history-page',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [MatTooltipModule, EmptyState, StatusChip, Icon],
    template: `
        @if (history().length === 0) {
            <ltg-empty
                icon="clock"
                headline="Noch keine Aktionen."
                detail="Sobald Hermes eine Übertragung vorbereitet hat, steht sie hier — unabhängig davon, wie du entschieden hast."
            />
        } @else {
            <p class="intro ltg-muted">
                Die letzten {{ history().length }} vorbereiteten Aktionen. Der Nachrichtentext
                steht bewusst nicht in dieser Liste; er ist in der Freigabeansicht und im
                Protokoll zu sehen.
            </p>

            <div class="scroll">
                <table>
                    <thead>
                        <tr>
                            <th>Status</th>
                            <th>Ressource</th>
                            <th>Ziel</th>
                            <th>Zweck</th>
                            <th>Umfang</th>
                            <th>Vorbereitet</th>
                        </tr>
                    </thead>
                    <tbody>
                        @for (entry of history(); track entry.actionId) {
                            <tr>
                                <td>
                                    <ltg-status [status]="entry.status" />
                                    @if (reason(entry); as text) {
                                        <span class="reason ltg-muted">{{ text }}</span>
                                    }
                                </td>
                                <td class="ltg-mono">{{ entry.resourceRef }}</td>
                                <td>
                                    @if (entry.plan.kind === 'summarize_resource') {
                                        <span
                                            class="flag"
                                            matTooltip="Redigierte Zusammenfassung zur Abholung durch den Agenten. Das Dokument selbst blieb hier."
                                        >
                                            <ltg-icon name="alert" [size]="11" />
                                            Agent
                                        </span>
                                        <span class="ltg-muted recipient">Zusammenfassung</span>
                                    } @else {
                                        {{ entry.plan.targetId }}
                                        @if (entry.plan.dynamicRecipient) {
                                            <span
                                                class="flag"
                                                matTooltip="Empfänger wurde vom Agenten vorgeschlagen."
                                            >
                                                <ltg-icon name="alert" [size]="11" />
                                                frei
                                            </span>
                                        }
                                        <span class="ltg-mono ltg-muted recipient">
                                            {{ entry.plan.recipientDisplay }}
                                        </span>
                                    }
                                </td>
                                <td class="purpose">{{ entry.purpose }}</td>
                                <td class="nowrap">{{ payload(entry) }}</td>
                                <td
                                    class="nowrap"
                                    [matTooltip]="absolute(entry.createdAt)"
                                    matTooltipPosition="left"
                                >
                                    {{ relative(entry.createdAt) }}
                                </td>
                            </tr>
                        }
                    </tbody>
                </table>
            </div>
        }
    `,
    styles: `
        .intro {
            margin: 0 0 var(--ltg-gap);
            font-size: 0.85rem;
        }

        .scroll {
            border: 1px solid var(--mat-sys-outline-variant);
            border-radius: var(--ltg-radius-lg);
            background: var(--mat-sys-surface-container-low);
            overflow: auto;
            max-height: calc(100vh - 16rem);
        }

        table {
            width: 100%;
            border-collapse: collapse;
            font-size: 0.84rem;
        }

        th,
        td {
            text-align: left;
            padding: 0.7rem 0.9rem;
            border-bottom: 1px solid var(--mat-sys-outline-variant);
            vertical-align: top;
        }

        th {
            position: sticky;
            top: 0;
            z-index: 1;
            background: var(--mat-sys-surface-container-high);
            color: var(--mat-sys-on-surface-variant);
            font-size: 0.72rem;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.06em;
        }

        tbody tr:last-child td {
            border-bottom: none;
        }

        tbody tr:hover {
            background: var(--mat-sys-surface-container);
        }

        .reason {
            display: block;
            margin-top: 0.3rem;
            font-size: 0.75rem;
        }

        .recipient {
            display: block;
            margin-top: 0.2rem;
        }

        .flag {
            display: inline-flex;
            align-items: center;
            gap: 0.2rem;
            padding: 0.05rem 0.35rem;
            border-radius: 999px;
            background: var(--ltg-alarm-surface);
            color: var(--ltg-alarm);
            font-size: 0.68rem;
            font-weight: 700;
            cursor: help;
        }

        .purpose {
            max-width: 22rem;
        }

        .nowrap {
            white-space: nowrap;
        }
    `
})
export class HistoryPage {
    private readonly state = inject(GatewayState);
    private readonly clock = inject(Clock);

    protected readonly history = this.state.history;

    protected reason(entry: ApiHistoryEntry): string {
        return entry.statusReason ? REASONS[entry.statusReason] : '';
    }

    /** What the action would have carried: files, or characters of redacted text. */
    protected payload(entry: ApiHistoryEntry): string {
        if (entry.plan.kind === 'summarize_resource') {
            return `${entry.plan.summaryChars} Zeichen Text`;
        }
        const files = entry.plan.attachments;
        if (files.length === 0) {
            return 'keine';
        }
        const total = files.reduce((sum, file) => sum + file.byteSize, 0);
        return `${files.length} · ${formatBytes(total)}`;
    }

    protected relative(iso: string): string {
        return formatRelative(iso, this.clock.now());
    }

    protected absolute(iso: string): string {
        return formatTime(iso) || UNKNOWN;
    }
}
