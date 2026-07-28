# Daten und Zustand

> **Kein maßgebliches Dokument.** Verbindlich sind `README.md`, der Quellcode und `test/`. Diese Seite wird von einem Sprachmodell gepflegt und kann veraltet oder schlicht falsch sein.

Stand: 14728fe9495cd19758e8f71e6f2704dc8fc7044e (2026-07-28)

## Die Dateien unter `dataDir`

Der persistente Zustand unter `dataDir` (Standard `data`) kommt ohne Datenbank aus. Die
JSONL-Stores unter `src/store/` sind append-only; die optionale Telegram-Konfiguration ist eine
kleine, restriktiv geschützte und authentifiziert verschlüsselte Einstellungsdatei:

| Datei | Inhalt | Modul |
| --- | --- | --- |
| `references.jsonl` | opake Referenz → echte Ressource | `src/store/referenceStore.ts` |
| `actions.jsonl` | vorbereitete und entschiedene Aktionen | `src/store/actionStore.ts` |
| `selections.jsonl` | offene und entschiedene lokale Auswahlen | `src/store/selectionStore.ts` |
| `audit.jsonl` | Entscheidungsprotokoll, nie verdichtet, nie gelöscht | `src/store/auditLog.ts` |
| telegram-approval.json | AES-256-GCM-Ciphertext der Telegram-Freigabekonfiguration, Modus 0600 | `src/approval/settingsStore.ts` |

Dieses Verzeichnis darf den Rechner nicht verlassen und ist entsprechend nicht Teil dieses
Checkouts — siehe `.gitignore`. Details zum Inhalt jeder Datei stehen in `README.md`, Abschnitt
„Datenhaltung".

Die Telegram-API gibt das gespeicherte Bot-Token nie zurück. Das Portal erhält nur einen
secretfreien Status mit maskierter Chat- und Benutzer-ID; ein leeres Tokenfeld behält beim
Speichern das vorhandene Secret bei. Der getrennte Master-Key kommt aus der Gateway-Umgebung,
verlässt den Prozess nicht und wird beim `EgressGuard` registriert. Eine exakt valide
Legacy-Klartextdatei wird beim Start atomar migriert; jede andere Legacy-Struktur sperrt den Start.

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
