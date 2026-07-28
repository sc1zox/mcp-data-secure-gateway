# Source Map

Jede Datei unter `src/**/*.ts`, gemessen mit `wc -l` gegen den aktuellen Arbeitsbaum. Diese Tabelle
ist Dokumentation, keine Quelle der Wahrheit — bei Widerspruch gilt der Code. Geprüft von
`.ai-workflow/check-docs.mjs` (Regel: jede Datei kommt genau einmal vor).

Vertrauensseite:
- `hermes-facing` — nimmt Eingabe von Hermes entgegen oder ist die Werkzeugoberfläche selbst.
- `boundary` — entscheidet oder erzwingt, was zwischen lokal und Hermes wechselt.
- `local-only` — läuft ausschließlich lokal, erreicht Hermes nie direkt.

| Datei | LOC | Verantwortung | Vertrauensseite |
| --- | --- | --- | --- |
| `src/index.ts` | 224 | Start, Boot-Reihenfolge, registriert Geheimnisse beim `EgressGuard` | local-only |
| `src/config.ts` | 316 | Konfiguration laden, `${VAR}`-Ersetzung gegen die Umgebung | local-only |
| `src/core/orchestrator.ts` | 471 | Koordiniert Kollaborateure; öffentliche Signatur für Einstiegspunkt, Freigabe-Server und MCP-Oberfläche | boundary |
| `src/core/types.ts` | 399 | `Internal*`/`Public*`-Typen, `ActionStatus`, `REDACTION_PLACEHOLDERS` | boundary |
| `src/core/egress.ts` | 462 | Aufbau jeder Antwort an Hermes nach Whitelist; `EGRESS_NOTES`-Katalog; `EgressGuard` | boundary |
| `src/core/limits.ts` | 24 | Zentrale Policy-Obergrenzen (Zeichen-, Anhangs-, Wartezeitgrenzen) | local-only |
| `src/core/binding.ts` | 103 | Bindungs-Hash einer Freigabe (`resourceStateHash`, `computeBindingHash`, Inv. 12) | boundary |
| `src/core/agentInput.ts` | 133 | Normalisierung unvertrauter Hermes-Eingabe, bevor sie Zustand wird | hermes-facing |
| `src/core/attachmentSafety.ts` | 43 | Quellenseitige Anhangs-Metadatenprüfung (Dateiname, Medientyp) | boundary |
| `src/core/planBuilder.ts` | 103 | Baut, was den Rechner verlässt (Betreff, Text, Ressourcenbeschreibung) samt Urheberzuschreibung | boundary |
| `src/core/refusals.ts` | 82 | Geschlossenes Refusal-Vokabular (Inv. 13) | hermes-facing |
| `src/core/decisionWaiters.ts` | 43 | Wartet auf eine Nutzerentscheidung, ohne zurückzurufen | local-only |
| `src/core/resourceGate.ts` | 230 | Referenz-, Zweckbindungs- und Frische-Prüfung vor jedem Egress (Inv. 4 + 12) | boundary |
| `src/core/actionExecutor.ts` | 267 | Einziger Besitzer von `staged`; führt eine freigegebene Aktion aus (Inv. 7 + 12) | boundary |
| `src/core/actionPreparation.ts` | 336 | Bereitet Send- und Zusammenfassungsaktionen bis zur lokalen Freigabe vor | boundary |
| `src/core/selectionFlow.ts` | 179 | Öffnet, parkt, löst und storniert lokale Auswahlen (Inv. 9) | boundary |
| `src/core/localViews.ts` | 274 | Lokale Projektion einer Aktion/Auswahl für die Freigabeoberfläche; erreicht Hermes nie | local-only |
| `src/mcp/hermesServer.ts` | 555 | Die 7 MCP-Werkzeuge, mit denen Hermes das Gateway anspricht | hermes-facing |
| `src/judge/judge.ts` | 543 | Lokale semantische Bewertung, liefert nur schemagebundenes JSON | local-only |
| `src/judge/ollamaClient.ts` | 128 | Ollama-Client; kein Cloud-Fallback bei Ausfall (Inv. 10) | local-only |
| `src/judge/prompts.ts` | 374 | Prompt-Vorlagen für den Judge (Inv. 11: Inhalt ist Daten, keine Anweisung) | local-only |
| `src/sources/source.ts` | 91 | `PrivateSource`-Schnittstelle, die jede Quelle implementiert | local-only |
| `src/sources/registry.ts` | 82 | Registrierung der konfigurierten Quellen (Inv. 1) | local-only |
| `src/sources/mcpSourceClient.ts` | 243 | MCP-Client zu einer privaten Quelle (Inv. 2) | local-only |
| `src/sources/paperlessSource.ts` | 558 | Anbindung an Paperless über `McpSourceClient` | local-only |
| `src/targets/target.ts` | 70 | `EgressTarget`-Schnittstelle, `deliver()` als einziger Zustellweg | boundary |
| `src/targets/registry.ts` | 64 | Registrierung der konfigurierten Ziele (Inv. 6) | boundary |
| `src/targets/mailTarget.ts` | 130 | SMTP-Zustellung, Anhangsgrenzen, MIME-sichere Defaults | boundary |
| `src/targets/telegramTarget.ts` | 136 | Telegram-Zustellung | boundary |
| `src/store/jsonlStore.ts` | 135 | Generische append-only-JSONL-Basis für die Stores unten | local-only |
| `src/store/actionStore.ts` | 232 | Aktionsstatus, erlaubte Übergänge, `ActionImmutabilityError` (Inv. 12) | local-only |
| `src/store/referenceStore.ts` | 102 | Referenz-→-Ressource-Zuordnung (Inv. 4) | local-only |
| `src/store/selectionStore.ts` | 127 | Offene und entschiedene lokale Auswahlen (Inv. 9) | local-only |
| `src/store/auditLog.ts` | 113 | Entscheidungsprotokoll, append-only, nie verdichtet (Inv. 14) | local-only |
| `src/approval/server.ts` | 617 | Lokaler Freigabe-Server, ausschließlich Loopback | local-only |
| `src/approval/contract.ts` | 468 | Importfreies Wire-Format zwischen Server und Oberfläche, von beiden TS-Projekten kompiliert | boundary |
| `src/approval/settingsStore.ts` | 151 | Lokale 0600-Konfiguration des optionalen Telegram-Freigabekanals; API-Projektion ohne Bot-Token | local-only |
| `src/approval/telegramApproval.ts` | 569 | Long-Polling-Benachrichtigung und gebundene Telegram-Entscheidungen ohne Originaldateien | local-only |
| `src/util/boundedHttp.ts` | 103 | Begrenztes Lesen von JSON-HTTP-Antworten mit Abbruch, Zeit- und Größenlimit | local-only |
| `src/util/hash.ts` | 43 | Stabile Hash-Hilfsfunktion (`stableHash`), vom Bindungs-Hash genutzt | local-only |
| `src/util/ids.ts` | 38 | Erzeugung opaker Referenzen (Inv. 4) | boundary |
| `src/util/log.ts` | 60 | Strukturiertes Logging | local-only |
