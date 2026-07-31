# Daten und Zustand

> **Kein maßgebliches Dokument.** Verbindlich sind `README.md`, der Quellcode und `test/`. Diese Seite wird von einem Sprachmodell gepflegt und kann veraltet oder schlicht falsch sein.

Stand: 14728fe9495cd19758e8f71e6f2704dc8fc7044e (2026-07-28)

## Die Dateien unter `dataDir`

Der persistente Zustand unter `dataDir` (Standard `data`) kommt ohne Datenbank aus. Die
JSONL-Stores unter `src/store/` sind append-only; die optionale Telegram-Konfiguration ist eine
kleine, über Dateirechte geschützte Einstellungsdatei:

| Datei | Inhalt | Modul |
| --- | --- | --- |
| `references.jsonl` | opake Referenz → echte Ressource | `src/store/referenceStore.ts` |
| `actions.jsonl` | vorbereitete und entschiedene Aktionen | `src/store/actionStore.ts` |
| `selections.jsonl` | offene und entschiedene lokale Auswahlen | `src/store/selectionStore.ts` |
| `audit.jsonl` | Entscheidungsprotokoll, rotiert nach `audit.retentionDays` und `audit.maxEntries` | `src/store/auditLog.ts` |
| `recipients.jsonl` | Digests bereits freigegebener dynamischer Empfänger | `src/store/recipientStore.ts` |
| telegram-approval.json | Telegram-Freigabekonfiguration im Klartext, Modus 0600 | `src/approval/settingsStore.ts` |

Dieses Verzeichnis darf den Rechner nicht verlassen und ist entsprechend nicht Teil dieses
Checkouts — siehe `.gitignore`. Details zum Inhalt jeder Datei stehen in `README.md`, Abschnitt
„Datenhaltung".

Die Telegram-API gibt das gespeicherte Bot-Token nie zurück. Das Portal erhält nur einen
secretfreien Status mit maskierter Chat- und Benutzer-ID; ein leeres Tokenfeld behält beim
Speichern das vorhandene Secret bei. Der Schutz der Datei sind ihre Rechte, nicht eine eigene
Verschlüsselung; eine unbekannte oder beschädigte Struktur sperrt den Start.

Offene Aktionen überleben keinen Neustart: `ActionStore.load()` markiert jede Aktion in
`awaiting_local_approval` oder `selection_required` als abgelaufen. Entschiedene bleiben unberührt.

## Bindung einer Freigabe

Der Nutzer bestätigt eine Aktions-ID. Weil eine Aktion nach der Vorbereitung nicht mehr verändert
wird, benennt die ID genau einen Stand; jede Änderung erzeugt eine neue Aktion.

`resourceStateHash()` und `computeBindingHash()` (`src/core/orchestrator.ts`) bleiben als interne
Selbstprüfung: Vor der Ausführung muss der gespeicherte Datensatz noch zu seinem Hash passen. Der
Hash deckt bei einem Versand Mitgliedschaft, Reihenfolge und Zustands-Hash jeder Referenz sowie die
geordnete Anhangsliste (Dateiname, Medientyp, Größe, SHA-256) ab und benennt das Ziel — eine
Zielkennung bei einem Versand, `cloud_agent` bei einer Zusammenfassung. Angezeigt wird er nicht.
Details in `README.md`, Abschnitt „Woran eine Freigabe gebunden ist".

## Aktionsstatus

`ActionStatus` (`src/core/types.ts`) kennt unter anderem `awaiting_local_approval`,
`selection_required`, `executing`, `completed`, `rejected`, `failed`, `expired`. `ActionStore`
(`src/store/actionStore.ts`) erlaubt nur definierte Übergänge; ein erreichter Endzustand öffnet
sich nie wieder (`ActionImmutabilityError`).

Quelle: `README.md#datenhaltung`
