# Daten und Zustand

> **Kein maßgebliches Dokument.** Verbindlich sind `README.md`, der Quellcode und `test/`. Diese Seite wird von einem Sprachmodell gepflegt und kann veraltet oder schlicht falsch sein.

Stand: 14728fe9495cd19758e8f71e6f2704dc8fc7044e (2026-07-28)

## Die fünf Dateien unter `dataDir`

Alles unter `dataDir` (Standard `data`) ist append-only und kommt ohne Datenbank aus
(`src/store/`):

| Datei | Inhalt | Modul |
| --- | --- | --- |
| `references.jsonl` | opake Referenz → echte Ressource | `src/store/referenceStore.ts` |
| `actions.jsonl` | vorbereitete und entschiedene Aktionen | `src/store/actionStore.ts` |
| `selections.jsonl` | offene und entschiedene lokale Auswahlen | `src/store/selectionStore.ts` |
| `audit.jsonl` | Entscheidungsprotokoll, nie verdichtet, nie gelöscht | `src/store/auditLog.ts` |
| `ui-token` | Token der Freigabeoberfläche | — |

Dieses Verzeichnis darf den Rechner nicht verlassen und ist entsprechend nicht Teil dieses
Checkouts — siehe `.gitignore`. Details zum Inhalt jeder Datei stehen in `README.md`, Abschnitt
„Datenhaltung".

## Bindungs-Hash

`resourceStateHash()` und die drei Überladungen von `computeBindingHash()`
(`src/core/orchestrator.ts`) bilden zusammen die Bindung einer Freigabe. Bei einem Versand deckt
der Hash Mitgliedschaft, Reihenfolge und Zustands-Hash jeder Referenz sowie die geordnete
Anhangsliste (Dateiname, Medientyp, Größe, SHA-256) ab, und er benennt das Ziel — eine
Zielkennung bei einem Versand, `cloud_agent` bei einer Zusammenfassung. Passt der von der
Oberfläche zurückgeschickte Hash nicht mehr zum gespeicherten Datensatz, verweigert der
Orchestrator die Freigabe statt sie auf etwas anderes anzuwenden. Details in `README.md`, Abschnitt
„Zur Bindung einer Freigabe".

## Aktionsstatus

`ActionStatus` (`src/core/types.ts`) kennt unter anderem `awaiting_local_approval`,
`selection_required`, `executing`, `completed`, `rejected`, `failed`, `expired`. `ActionStore`
(`src/store/actionStore.ts`) erlaubt nur definierte Übergänge; ein erreichter Endzustand öffnet
sich nie wieder (`ActionImmutabilityError`).

Quelle: `README.md#datenhaltung`
