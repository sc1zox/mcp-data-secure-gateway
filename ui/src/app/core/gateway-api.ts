import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpContext, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type {
    ApiAuditResponse,
    ApiCancelSelectionRequest,
    ApiCancelSelectionResponse,
    ApiErrorResponse,
    ApiOkResponse,
    ApiReselectResponse,
    ApiSelectRequest,
    ApiSelectResponse,
    ApiStateResponse,
    ApiTelegramApprovalStatus,
    ApiTelegramApprovalTestResponse,
    ApiTelegramApprovalUpdateRequest
} from '@gateway/contract';
import { EXPECTS_UNAUTHORIZED } from './auth';

/**
 * Every call to the local approval API, typed against the same declarations the
 * server pins its responses to. Nothing else in the app talks to the network.
 */
@Injectable({ providedIn: 'root' })
export class GatewayApi {
    private readonly http = inject(HttpClient);

    state(): Promise<ApiStateResponse> {
        return firstValueFrom(this.http.get<ApiStateResponse>('/api/state'));
    }

    /**
     * Asks whether a candidate token is real. A live endpoint is the only proof
     * there is, and the response then seeds the dashboard so it arrives populated
     * instead of empty for one poll interval.
     *
     * The token travels as an explicit header rather than through the session,
     * which is what keeps this request independent of application state: a token
     * being tested is not a session yet. Establishing the session first would
     * start the poller, and its own unauthenticated request would race this one —
     * the poll's 401 would then log the user out of a login they were still in the
     * middle of attempting.
     */
    probe(token: string): Promise<ApiStateResponse> {
        return firstValueFrom(
            this.http.get<ApiStateResponse>('/api/state', {
                headers: { 'X-Gateway-Token': token },
                context: new HttpContext().set(EXPECTS_UNAUTHORIZED, true)
            })
        );
    }

    audit(limit = 200): Promise<ApiAuditResponse> {
        return firstValueFrom(
            this.http.get<ApiAuditResponse>('/api/audit', { params: { limit } })
        );
    }

    telegramApproval(): Promise<ApiTelegramApprovalStatus> {
        return firstValueFrom(
            this.http.get<ApiTelegramApprovalStatus>('/api/telegram-approval')
        );
    }

    updateTelegramApproval(
        update: ApiTelegramApprovalUpdateRequest
    ): Promise<ApiTelegramApprovalStatus> {
        return firstValueFrom(
            this.http.post<ApiTelegramApprovalStatus>('/api/telegram-approval', update)
        );
    }

    testTelegramApproval(): Promise<ApiTelegramApprovalTestResponse> {
        return firstValueFrom(
            this.http.post<ApiTelegramApprovalTestResponse>(
                '/api/telegram-approval/test',
                {}
            )
        );
    }

    approve(actionId: string, bindingHash: string): Promise<ApiOkResponse> {
        // The binding hash that was on screen goes back with the approval so the
        // server can refuse if anything about the action changed in between.
        return firstValueFrom(
            this.http.post<ApiOkResponse>('/api/approve', {
                action_id: actionId,
                binding_hash: bindingHash
            })
        );
    }

    reject(actionId: string): Promise<ApiOkResponse> {
        return this.action('/api/reject', actionId);
    }

    discard(actionId: string): Promise<ApiOkResponse> {
        return this.action('/api/discard', actionId);
    }

    reselect(actionId: string): Promise<ApiReselectResponse> {
        return firstValueFrom(
            this.http.post<ApiReselectResponse>('/api/reselect', { action_id: actionId })
        );
    }

    select(selectionId: string, candidateId: string): Promise<ApiSelectResponse> {
        return firstValueFrom(
            this.http.post<ApiSelectResponse>('/api/select', {
                selection_id: selectionId,
                candidate_id: candidateId
            } satisfies ApiSelectRequest)
        );
    }

    cancelSelection(selectionId: string): Promise<ApiCancelSelectionResponse> {
        return firstValueFrom(
            this.http.post<ApiCancelSelectionResponse>('/api/cancel-selection', {
                selection_id: selectionId
            } satisfies ApiCancelSelectionRequest)
        );
    }

    private action(path: string, actionId: string): Promise<ApiOkResponse> {
        return firstValueFrom(this.http.post<ApiOkResponse>(path, { action_id: actionId }));
    }
}

/**
 * Turns a failed request into something worth putting in front of a person.
 *
 * The gateway answers errors with `{ error, hint }`, and that text is written for
 * this screen — a conflict says the action changed under the user, not "409". The
 * status-code fallbacks below only matter when the failure happened before the
 * gateway could answer at all.
 */
export function describeApiError(error: unknown): string {
    if (!(error instanceof HttpErrorResponse)) {
        return error instanceof Error ? error.message : 'Unbekannter Fehler.';
    }
    const body = error.error as ApiErrorResponse | null;
    if (body && typeof body.error === 'string') {
        return body.hint ? `${body.error} ${body.hint}` : body.error;
    }
    if (error.status === 0) {
        return 'Keine Verbindung zum Gateway. Läuft der Prozess noch?';
    }
    return `Das Gateway antwortete mit HTTP ${error.status}.`;
}

/** True when the gateway refused because the action no longer matches what was shown. */
export function isConflict(error: unknown): boolean {
    return error instanceof HttpErrorResponse && error.status === 409;
}
