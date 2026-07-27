# Tests

> **Kein maßgebliches Dokument.** Verbindlich sind `README.md`, der Quellcode und `test/`. Diese Seite wird von einem Sprachmodell gepflegt und kann veraltet oder schlicht falsch sein.

Stand: 14728fe9495cd19758e8f71e6f2704dc8fc7044e (2026-07-28)

## Aufbau

`node --import tsx --test` läuft über `test/**/*.test.ts` — Node.js' eingebautes `node:test` und
`node:assert/strict`, kein zusätzliches Framework. `test/invariants.test.ts` enthält einen Test pro
Sicherheitsinvariante aus `README.md`.

## An der Grenze, nicht an Interna

Der Kopfkommentar von `test/invariants.test.ts` benennt das ausdrücklich: Assertions prüfen, was
Hermes tatsächlich erhält und was ein Ziel tatsächlich erreicht — nicht Zwischenzustände oder
private Methoden. Ein Test, der stattdessen eine interne Funktion isoliert aufruft, prüft nicht das,
was diese Suite als ihren Vertrag versteht.

## Die Doubles

`test/helpers.ts` stellt `PrivateSource`, `EgressTarget` und das lokale Modell als Doubles bereit
(`makeHarness`, `makeResource`, `waitForAction`, `waitForTerminal`). Ein Test baut damit einen
vollständigen, aber lokalen Durchlauf durch den Orchestrator, ohne echte Netzwerk- oder
Modellaufrufe.

## Eine neue Invariante testen

1. Den Fall als Erwartung an der Grenze formulieren: welche konkrete Ausgabe an Hermes oder an ein
   Ziel darf nicht passieren, oder muss passieren.
2. `makeHarness` aus `test/helpers.ts` für den Aufbau verwenden, keinen eigenen Test-Aufbau parallel
   erfinden.
3. Den Test in `test/invariants.test.ts` ergänzen, falls es sich tatsächlich um eine der 14
   Sicherheitsinvarianten handelt — sonst in eine passende bestehende Testdatei.
4. `npm test` lokal ausführen, bevor die Änderung als abgeschlossen gilt.

Quelle: `test/helpers.ts`
