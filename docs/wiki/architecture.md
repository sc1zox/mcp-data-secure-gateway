# Architektur

> **Kein maßgebliches Dokument.** Verbindlich sind `README.md`, der Quellcode und `test/`. Diese Seite wird von einem Sprachmodell gepflegt und kann veraltet oder schlicht falsch sein.

Stand: 14728fe9495cd19758e8f71e6f2704dc8fc7044e (2026-07-28)

## Der Weg einer Anfrage

Hermes spricht ausschließlich die sieben in `src/mcp/hermesServer.ts` registrierten Werkzeuge an
(`find_resource`, `list_targets`, `prepare_action`, `summarize_resource`, `get_summary`,
`get_action_status`, `await_action_decision`). Jeder Aufruf geht von dort in
`src/core/orchestrator.ts`, das den gesamten Zustand, alle Gates und die Bindungs-Hashes besitzt.

Der Orchestrator holt Kandidaten über `src/sources/registry.ts` (die private Quelle, z. B.
Paperless über MCP), lässt sie über `src/judge/` lokal bewerten und baut jede Antwort an Hermes
über `src/core/egress.ts` — das ist die einzige Stelle, an der Daten für Hermes geformt werden.
Eine vorbereitete Aktion wartet danach auf eine Entscheidung in der lokalen Freigabeoberfläche
(`src/approval/`), bevor `src/targets/registry.ts` sie tatsächlich zustellt. Optional sendet
`src/approval/telegramApproval.ts` eine inhaltsfreie Benachrichtigung über dieselbe lokale Ansicht
an einen fest konfigurierten privaten Telegram-Chat. Ein dort zugelassener Klick führt wie der
Browserweg in dieselben Orchestrator-Methoden und dieselbe Bindungsprüfung; der Kanal versendet
keine Originaldateien und gibt nichts frei, dessen Text er nicht gezeigt hat.

Referenzen, Aktionen, Auswahlen und Audit laufen append-only über `src/store/`. Die optionale
Telegram-Konfiguration ist davon getrennt und wird atomar durch
`src/approval/settingsStore.ts` als authentifiziert verschlüsseltes AES-256-GCM-Envelope ersetzt.
Der getrennte Master-Key stammt aus der Gateway-Umgebung. Beides kommt ohne Datenbank aus.

## Wer welche Entscheidung trifft

- **Ob eine Ressource passt**: `src/judge/` (lokales Modell), aber nur als Vorschlag — nie
  bindend.
- **Ob etwas als Aktion gilt und welchen Status sie hat**: `src/core/orchestrator.ts`.
- **Was Hermes zu sehen bekommt**: ausschließlich `src/core/egress.ts`.
- **Ob eine Aktion ausgeführt wird**: die Freigabe des Nutzers im Browser oder über den optionalen,
  fest gebundenen Telegram-Kanal in `src/approval/`; beide Wege nutzen dieselbe Bindungsprüfung.

## Warum die Oberfläche ein eigenes npm-Projekt ist

`ui/` hat ein eigenes `node_modules` und ein eigenes `package-lock.json`. Grund: das Gateway
kompiliert mit TypeScript 5.9, Angular 22 bringt TypeScript 6.0 mit; getrennte Abhängigkeitsbäume
verhindern, dass npm eine der beiden Versionen hochhoistet und der jeweils andere Build die
falsche erwischt. Details und die vier Design-Entscheidungen der Oberfläche stehen in `README.md`
im Abschnitt „Aufbau der Oberfläche".

Für Details zum Wire-Format zwischen Server und Oberfläche siehe `src/approval/contract.ts` —
importfrei, damit beide Projekte dieselbe Datei kompilieren.

Quelle: `src/core/orchestrator.ts`
