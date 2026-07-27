# Wiki: Local Trust Gateway

> **Kein maßgebliches Dokument.** Verbindlich sind `README.md`, der Quellcode und `test/`. Diese Seite wird von einem Sprachmodell gepflegt und kann veraltet oder schlicht falsch sein.

## Rangfolge

Code schlägt README schlägt Wiki. Eine Wiki-Seite, die dem Code widerspricht, ist ein Fehler im
Wiki — nicht ein Hinweis, den Code anzupassen.

## Pflege

Dieses Wiki wird von einem Agenten gepflegt, als Teil einer Änderung, die eine Seite falsch macht —
nicht als eigener Auftrag. Jede Seite außer dieser trägt eine Zeile `Stand: <Commit-SHA>
(<Datum>)`: sie markiert, gegen welchen Stand des Codes die Seite geschrieben wurde, ohne eine
automatische Aktualitätsprüfung vorzutäuschen, die es nicht gibt. Eine Seite, die falsch geworden
ist, wird gelöscht statt falsch stehen gelassen.

## Index

- [architecture.md](architecture.md) — der Weg einer Anfrage von `find_resource` bis zur
  Zustellung, wer welche Entscheidung trifft
- [trust-boundary.md](trust-boundary.md) — was den Rechner verlässt und was nicht
- [data-and-state.md](data-and-state.md) — die Ablagen unter `dataDir`, der Bindungs-Hash, der
  Aktionsstatus
- [testing.md](testing.md) — Aufbau der Testsuite, wie ein Test für eine neue Invariante entsteht
- [glossary.md](glossary.md) — deutsche Fachbegriffe des Projekts

`npm run check:docs` (`.ai-workflow/check-docs.mjs`) prüft unter anderem, dass jede Seite hier
eine `Quelle:`-Zeile trägt und dass jeder darin genannte Pfad existiert.
