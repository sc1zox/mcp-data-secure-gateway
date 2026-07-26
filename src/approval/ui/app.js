// Local approval interface.
//
// Everything rendered here is private data — document titles, OCR excerpts,
// correspondents. All of it goes into the DOM via textContent, never innerHTML,
// so a document whose title contains markup is displayed as text instead of
// becoming part of this page. The same reasoning as invariant 11 on the server
// side: resource content is data, not instructions.

const TOKEN = (() => {
    const fromQuery = new URLSearchParams(window.location.search).get('token');
    if (fromQuery) {
        // Keep it out of the address bar, the history entry and any screenshot.
        window.history.replaceState({}, '', window.location.pathname);
        return fromQuery;
    }
    return '';
})();

const POLL_INTERVAL_MS = 2000;
const state = { actions: [], selections: [], history: [], busy: new Set() };

const el = {
    connection: document.getElementById('connection'),
    clock: document.getElementById('clock'),
    approvals: document.getElementById('approvals'),
    approvalsEmpty: document.getElementById('approvals-empty'),
    selections: document.getElementById('selections'),
    selectionsEmpty: document.getElementById('selections-empty'),
    history: document.getElementById('history'),
    historyEmpty: document.getElementById('history-empty'),
    audit: document.getElementById('audit'),
    countApprovals: document.getElementById('count-approvals'),
    countSelections: document.getElementById('count-selections'),
    toast: document.getElementById('toast')
};

// ---------------------------------------------------------------- DOM helpers

function node(tag, options = {}, children = []) {
    const element = document.createElement(tag);
    if (options.className) {
        element.className = options.className;
    }
    if (options.text !== undefined) {
        element.textContent = String(options.text);
    }
    for (const [key, value] of Object.entries(options.dataset ?? {})) {
        element.dataset[key] = value;
    }
    for (const [key, value] of Object.entries(options.attrs ?? {})) {
        element.setAttribute(key, value);
    }
    for (const child of children) {
        if (child) {
            element.append(child);
        }
    }
    return element;
}

function field(label, value) {
    return [node('dt', { text: label }), node('dd', { text: value ?? '–' })];
}

function formatBytes(bytes) {
    if (typeof bytes !== 'number' || Number.isNaN(bytes)) {
        return '–';
    }
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KiB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function formatTime(iso) {
    if (!iso) {
        return '–';
    }
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('de-DE');
}

function remaining(iso) {
    const ms = new Date(iso).getTime() - Date.now();
    if (Number.isNaN(ms)) {
        return '–';
    }
    if (ms <= 0) {
        return 'abgelaufen';
    }
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return minutes > 0 ? `${minutes} min ${seconds} s` : `${seconds} s`;
}

function toast(message, kind) {
    el.toast.textContent = message;
    el.toast.className = `toast ${kind === 'error' ? 'is-error' : kind === 'ok' ? 'is-ok' : ''}`;
    el.toast.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => {
        el.toast.hidden = true;
    }, kind === 'error' ? 8000 : 4000);
}

// ------------------------------------------------------------------- transport

async function api(path, options = {}) {
    const response = await fetch(path, {
        ...options,
        headers: {
            'X-Gateway-Token': TOKEN,
            ...(options.body ? { 'Content-Type': 'application/json' } : {})
        }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(payload.error ?? `HTTP ${response.status}`);
    }
    return payload;
}

async function post(path, body) {
    return api(path, { method: 'POST', body: JSON.stringify(body) });
}

// --------------------------------------------------------------------- rendering

function sensitivityBadge(level) {
    const map = {
        low: ['badge badge-ok', 'Sensibilität: niedrig'],
        medium: ['badge badge-warn', 'Sensibilität: mittel'],
        high: ['badge badge-danger', 'Sensibilität: hoch']
    };
    const [className, text] = map[level] ?? ['badge badge-neutral', `Sensibilität: ${level}`];
    return node('span', { className, text });
}

function renderApprovalCard(action) {
    const busy = state.busy.has(action.actionId);

    const head = node('div', { className: 'card-head' }, [
        node('div', {}, [
            node('h2', { className: 'card-title', text: action.resource.safeLabel }),
            node('p', {
                className: 'muted',
                text: `Referenz ${action.resource.ref} · Aktion ${action.actionId}`
            })
        ]),
        node('div', {}, [
            sensitivityBadge(action.judgement.sensitivity),
            node('span', { className: 'muted', text: ` verfällt in ${remaining(action.expiresAt)}` })
        ])
    ]);

    const attributes = Object.entries(action.resource.attributes ?? {})
        .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
        .join(' · ');

    const details = node('dl', { className: 'field-grid' }, [
        ...field('Ressource', action.resource.title),
        ...field('Datenquelle', `${action.resource.sourceLabel} (Kennung ${action.resource.nativeIdDisplay})`),
        ...field('Ziel', `${action.target.label} → ${action.target.recipientDisplay}`),
        ...field('Zweck', action.purpose),
        ...field('Geplante Aktion', 'Ressource als Anhang an das genannte Ziel übertragen'),
        ...field('Vorbereitet', formatTime(action.createdAt)),
        ...(attributes ? field('Merkmale', attributes) : []),
        ...(action.resource.modifiedAt ? field('Geändert', formatTime(action.resource.modifiedAt)) : [])
    ]);

    // What actually leaves the machine, stated exactly.
    const egress = node('div', { className: 'egress-box' }, [
        node('div', { className: 'muted', text: 'Diese Daten verlassen das lokale System:' }),
        node('dl', { className: 'field-grid' }, [
            ...field('Betreff', action.egress.subject),
            ...field('Anhänge', `${action.egress.attachments.length} · ${formatBytes(action.egress.totalBytes)}`)
        ]),
        node('pre', { text: action.egress.body }),
        ...action.egress.attachments.map((attachment) =>
            node('div', { className: 'attachment' }, [
                node('span', { text: `${attachment.filename} (${attachment.mimeType})` }),
                node('span', { text: formatBytes(attachment.byteSize) }),
                node('span', { className: 'hash', text: `sha256 ${attachment.sha256}` })
            ])
        )
    ]);

    const judgementBlock = node('div', {}, [
        node('p', { className: 'muted', text: `Modell: ${action.judgement.model} · Konfidenz ${(action.judgement.confidence * 100).toFixed(0)} %` }),
        node('p', { text: action.judgement.reasoning })
    ]);

    const uncertainties = action.judgement.uncertainties ?? [];
    const uncertaintyBlock = uncertainties.length
        ? node('ul', { className: 'uncertainty-list' }, uncertainties.map((item) => node('li', { text: item })))
        : node('p', { className: 'muted', text: 'Das lokale Modell hat keine offenen Punkte gemeldet.' });

    const body = node('div', { className: 'card-body' }, [
        action.needsRefetch
            ? node('p', {
                  className: 'warning-strip',
                  text:
                      'Die Originaldaten liegen nicht mehr im Zwischenspeicher (z. B. nach einem Neustart). ' +
                      'Bei der Freigabe werden sie erneut aus der Quelle gelesen und mit der angezeigten Prüfsumme verglichen.'
              })
            : null,
        details,
        node('h3', { className: 'section-title', text: 'Ausgehende Daten' }),
        egress,
        node('h3', { className: 'section-title', text: 'Bewertung des lokalen Modells' }),
        judgementBlock,
        node('h3', { className: 'section-title', text: 'Offene Punkte' }),
        uncertaintyBlock,
        node('p', {
            className: 'hash',
            text: `Freigabebindung: ${action.bindingHash}`
        })
    ]);

    const approveButton = node('button', {
        className: 'btn btn-primary',
        text: busy ? 'wird ausgeführt …' : 'Freigeben und übertragen'
    });
    approveButton.disabled = busy;
    approveButton.addEventListener('click', () => decide(action, 'approve'));

    const rejectButton = node('button', { className: 'btn btn-danger', text: 'Ablehnen' });
    rejectButton.disabled = busy;
    rejectButton.addEventListener('click', () => decide(action, 'reject'));

    const reselectButton = node('button', { className: 'btn', text: 'Andere Ressource wählen' });
    reselectButton.disabled = busy;
    reselectButton.addEventListener('click', () => decide(action, 'reselect'));

    const discardButton = node('button', { className: 'btn', text: 'Verwerfen' });
    discardButton.disabled = busy;
    discardButton.addEventListener('click', () => decide(action, 'discard'));

    const actions = node('div', { className: 'actions' }, [
        approveButton,
        rejectButton,
        reselectButton,
        discardButton
    ]);

    return node('article', { className: 'card' }, [head, body, actions]);
}

async function decide(action, kind) {
    if (kind === 'approve') {
        const confirmed = window.confirm(
            `Übertragung freigeben?\n\n` +
                `Ressource: ${action.resource.title}\n` +
                `Ziel: ${action.target.label} → ${action.target.recipientDisplay}\n` +
                `Anhänge: ${action.egress.attachments.length} (${formatBytes(action.egress.totalBytes)})\n\n` +
                `Die Freigabe gilt nur für genau diese Kombination.`
        );
        if (!confirmed) {
            return;
        }
    }
    state.busy.add(action.actionId);
    render();
    try {
        if (kind === 'approve') {
            // The binding hash that was displayed goes back with the approval, so
            // the server can refuse if anything changed in the meantime.
            await post('/api/approve', {
                action_id: action.actionId,
                binding_hash: action.bindingHash
            });
            toast('Freigegeben. Die Übertragung läuft.', 'ok');
        } else if (kind === 'reject') {
            await post('/api/reject', { action_id: action.actionId });
            toast('Aktion abgelehnt.', 'ok');
        } else if (kind === 'discard') {
            await post('/api/discard', { action_id: action.actionId });
            toast('Aktion verworfen. Hermes muss sie neu vorbereiten.', 'ok');
        } else if (kind === 'reselect') {
            const result = await post('/api/reselect', { action_id: action.actionId });
            toast(`Auswahl geöffnet (${result.selection_id}). Bitte im Reiter „Auswahl“ entscheiden.`, 'ok');
            activateTab('selections');
        }
    } catch (error) {
        toast(error.message, 'error');
    } finally {
        state.busy.delete(action.actionId);
        await refresh();
    }
}

function renderSelectionCard(selection) {
    const candidates = selection.candidates.map((candidate) => {
        const chooseButton = node('button', { className: 'btn btn-primary', text: 'Diese wählen' });
        chooseButton.addEventListener('click', async () => {
            chooseButton.disabled = true;
            try {
                await post('/api/select', {
                    selection_id: selection.selectionId,
                    candidate_id: candidate.candidateId
                });
                toast('Ressource ausgewählt. Hermes kann die Aktion nun vorbereiten.', 'ok');
            } catch (error) {
                toast(error.message, 'error');
            } finally {
                await refresh();
            }
        });

        const attributes = Object.entries(candidate.attributes ?? {})
            .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
            .join(' · ');

        return node('div', { className: 'candidate' }, [
            node('div', { className: 'candidate-head' }, [
                node('strong', { text: candidate.title }),
                chooseButton
            ]),
            node('dl', { className: 'field-grid' }, [
                ...field('Quelle', `${candidate.sourceLabel} (Kennung ${candidate.nativeId})`),
                ...(candidate.createdAt ? field('Erstellt', formatTime(candidate.createdAt)) : []),
                ...(candidate.modifiedAt ? field('Geändert', formatTime(candidate.modifiedAt)) : []),
                ...(candidate.mimeType ? field('Format', candidate.mimeType) : []),
                ...(attributes ? field('Merkmale', attributes) : [])
            ]),
            candidate.excerpt ? node('p', { className: 'excerpt', text: candidate.excerpt }) : null
        ]);
    });

    const cancelButton = node('button', { className: 'btn btn-danger', text: 'Auswahl abbrechen' });
    cancelButton.addEventListener('click', async () => {
        cancelButton.disabled = true;
        try {
            await post('/api/cancel-selection', { selection_id: selection.selectionId });
            toast('Auswahl abgebrochen.', 'ok');
        } catch (error) {
            toast(error.message, 'error');
        } finally {
            await refresh();
        }
    });

    return node('article', { className: 'card' }, [
        node('div', { className: 'card-head' }, [
            node('div', {}, [
                node('h2', { className: 'card-title', text: 'Lokale Auswahl erforderlich' }),
                node('p', { className: 'muted', text: `Auswahl ${selection.selectionId}` })
            ]),
            node('span', { className: 'muted', text: `verfällt in ${remaining(selection.expiresAt)}` })
        ]),
        node('div', { className: 'card-body' }, [
            node('dl', { className: 'field-grid' }, [
                ...field('Suchanfrage', selection.query),
                ...field('Zweck', selection.purpose),
                ...field('Begründung', selection.reasoning)
            ]),
            node('h3', { className: 'section-title', text: `Kandidaten (${candidates.length})` }),
            ...candidates
        ]),
        node('div', { className: 'actions' }, [cancelButton])
    ]);
}

const STATUS_LABELS = {
    awaiting_local_approval: ['badge badge-warn', 'wartet auf Freigabe'],
    selection_required: ['badge badge-warn', 'Auswahl nötig'],
    executing: ['badge badge-neutral', 'wird ausgeführt'],
    completed: ['badge badge-ok', 'abgeschlossen'],
    rejected: ['badge badge-danger', 'abgelehnt'],
    failed: ['badge badge-danger', 'fehlgeschlagen'],
    expired: ['badge badge-neutral', 'abgelaufen']
};

function renderHistory(records) {
    const rows = records.map((record) => {
        const [className, label] = STATUS_LABELS[record.status] ?? ['badge badge-neutral', record.status];
        return node('tr', {}, [
            node('td', { className: 'mono', text: record.actionId }),
            node('td', { text: formatTime(record.createdAt) }),
            node('td', { text: record.plan?.targetId ?? '–' }),
            node('td', { text: record.purpose }),
            node('td', {}, [node('span', { className, text: label })]),
            node('td', { text: record.statusReason ?? '–' })
        ]);
    });

    return node('div', { className: 'table-wrap' }, [
        node('table', { className: 'log' }, [
            node('thead', {}, [
                node('tr', {}, [
                    node('th', { text: 'Aktion' }),
                    node('th', { text: 'Vorbereitet' }),
                    node('th', { text: 'Ziel' }),
                    node('th', { text: 'Zweck' }),
                    node('th', { text: 'Status' }),
                    node('th', { text: 'Grund' })
                ])
            ]),
            node('tbody', {}, rows)
        ])
    ]);
}

function renderAudit(events) {
    const rows = events.map((event) =>
        node('tr', {}, [
            node('td', { text: formatTime(event.ts) }),
            node('td', { className: 'mono', text: event.type }),
            node('td', { className: 'mono', text: event.actionId ?? event.resourceRef ?? event.selectionId ?? '–' }),
            node('td', { className: 'mono', text: event.detail ? JSON.stringify(event.detail) : '–' })
        ])
    );
    return node('div', { className: 'table-wrap' }, [
        node('table', { className: 'log' }, [
            node('thead', {}, [
                node('tr', {}, [
                    node('th', { text: 'Zeit' }),
                    node('th', { text: 'Ereignis' }),
                    node('th', { text: 'Bezug' }),
                    node('th', { text: 'Details' })
                ])
            ]),
            node('tbody', {}, rows)
        ])
    ]);
}

function render() {
    el.approvals.replaceChildren(...state.actions.map(renderApprovalCard));
    el.approvalsEmpty.hidden = state.actions.length > 0;
    el.countApprovals.textContent = String(state.actions.length);

    el.selections.replaceChildren(...state.selections.map(renderSelectionCard));
    el.selectionsEmpty.hidden = state.selections.length > 0;
    el.countSelections.textContent = String(state.selections.length);

    if (state.history.length > 0) {
        el.history.replaceChildren(renderHistory(state.history));
        el.historyEmpty.hidden = true;
    } else {
        el.history.replaceChildren();
        el.historyEmpty.hidden = false;
    }
}

async function refresh() {
    try {
        const payload = await api('/api/state');
        state.actions = payload.actions ?? [];
        state.selections = payload.selections ?? [];
        state.history = payload.history ?? [];
        el.connection.className = 'badge badge-ok';
        el.connection.textContent = 'verbunden';
        el.clock.textContent = formatTime(payload.serverTime);
        render();
    } catch (error) {
        el.connection.className = 'badge badge-danger';
        el.connection.textContent = 'keine Verbindung';
        if (!TOKEN) {
            toast('Kein Zugriffstoken. Die Oberfläche muss über die vom Gateway ausgegebene URL geöffnet werden.', 'error');
            return;
        }
        toast(`Statusabfrage fehlgeschlagen: ${error.message}`, 'error');
    }
}

async function refreshAudit() {
    try {
        const payload = await api('/api/audit?limit=200');
        el.audit.replaceChildren(renderAudit(payload.events ?? []));
    } catch (error) {
        toast(`Protokoll nicht lesbar: ${error.message}`, 'error');
    }
}

// ------------------------------------------------------------------------ tabs

function activateTab(name) {
    for (const tab of document.querySelectorAll('.tab')) {
        tab.classList.toggle('is-active', tab.dataset.tab === name);
    }
    for (const panel of document.querySelectorAll('.panel')) {
        panel.classList.toggle('is-active', panel.id === `panel-${name}`);
    }
    if (name === 'audit') {
        void refreshAudit();
    }
}

for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => activateTab(tab.dataset.tab));
}

void refresh();
setInterval(refresh, POLL_INTERVAL_MS);
