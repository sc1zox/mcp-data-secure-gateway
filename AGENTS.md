# AGENTS.md

Das Local Trust Gateway gibt dem Cloud-Agenten Hermes kontrollierten Zugriff auf private Dienste,
ohne ihm Rohdaten, interne Kennungen oder Zugangsdaten zu geben. Was das im Einzelnen bedeutet und
wie es umgesetzt ist, steht in `README.md` — dort zuerst lesen, nicht hier.

Diese Datei ist die eine, harness-neutrale Quelle für Verhaltensregeln in diesem Repository. Jeder
Adapter für einen konkreten Coding-Agenten (z. B. `CLAUDE.md`) verweist hierher und fügt höchstens
werkzeugspezifische Hinweise hinzu, keine eigenen Regeln.

## Die harte Grenze

Nicht verhandelbar, unabhängig vom Auftrag:

- Niemals das erweitern, was bei Hermes ankommt. Jede ausgehende Formung läuft über
  `src/core/egress.ts`; Aufbau nach Whitelist, Prosa ausschließlich aus dem geschlossenen
  `EGRESS_NOTES`-Katalog.
- Niemals einen Cloud-Fallback für das lokale Modell hinzufügen.
- Niemals irgendetwas unter `data/` lesen, schreiben, ausgeben, kopieren oder committen. Dort
  liegen die Zuordnung Referenz → Dokument und das Audit-Protokoll.
- Niemals ein Geheimnis in eine versionierte Datei schreiben. `${VAR}`-Platzhalter plus
  `.env.example` sind der einzige Mechanismus.
- Niemals eine Invariante lockern, um einen Test bestehen zu lassen. Die Invarianten sind das
  Produkt.

## Sicherheitsinvarianten

Die 14 Sicherheitsinvarianten stehen in `README.md` (Abschnitt *Sicherheitsinvarianten und ihre
Umsetzung*) und werden von `test/invariants.test.ts` durchgesetzt. Diese Datei wiederholt sie
nicht; sie darf sie auch nicht überstimmen.

## Verifikationsvertrag

Vor jeder Änderung als abgeschlossen gilt:

```bash
npm run typecheck
npm test
```

Das sind die beiden Prüfungen, die es gibt — dieselben, die `README.md` im Abschnitt
„Entwicklung" nennt. Wurde `AGENTS.md`, `CLAUDE.md`, etwas unter `.ai-workflow/` oder unter
`docs/wiki/` geändert, zusätzlich:

```bash
npm run check:docs
```

Es gibt keine weitere automatisierte Prüfung in diesem Repository — keine CI, kein Lint- und kein
Formatierungsbefehl. Keiner davon darf erfunden werden; jeder hier genannte Befehl ist wörtlich aus
`package.json` bzw. `ui/package.json` übernommen.

## Wo was liegt

| Bereich | Pfad |
| --- | --- |
| Start, Boot-Reihenfolge | `src/index.ts` |
| Konfiguration, `${VAR}`-Ersetzung | `src/config.ts` |
| Zustand, Gating, Bindungs-Hash | `src/core/` |
| Egress-Aufbau (Whitelist, Hinweistexte) | `src/core/egress.ts` |
| MCP-Oberfläche für Hermes (7 Werkzeuge) | `src/mcp/hermesServer.ts` |
| Lokale semantische Bewertung | `src/judge/` |
| Private Quellen, nur lesend | `src/sources/` |
| Ausgehende Ziele | `src/targets/` |
| Anhangsoptimierung vor dem Transport (PDF, JPEG) | `src/attachments/` |
| Persistenz, append-only | `src/store/` |
| Lokale Freigabe (Server und geteilter Contract) | `src/approval/` |
| Tests, an der Grenze | `test/` |
| Freigabeoberfläche, eigenes npm-Projekt | `ui/` |
| Maschinenlesbare Karte (Source Map, Ownership, Verifikationsmatrix) | `.ai-workflow/` |

## Konventionen (beobachtet, nicht neu festgelegt)

- Code-Kommentare: Englisch. Nutzertexte, Log-Meldungen, `EGRESS_NOTES`, Testbeschreibungen,
  `README.md` und Commit-Nachrichten: Deutsch.
- ESM mit `Node16`-Modulauflösung: relative Imports tragen die `.js`-Endung, auch aus
  `.ts`-Quellen. Der häufigste mechanische Fehler in diesem Codebase-Zuschnitt.
- Einrückung: `src/` vier Leerzeichen, `ui/` zwei Leerzeichen. Durchgehend einfache
  Anführungszeichen.
- `tsconfig.json`: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`; nur `src/**/*.ts`
  wird gebaut, `test/` läuft über `tsx`, nicht über den Build.

## Erweiterungspunkte

- **Neue Quelle**: `PrivateSource` implementieren, Fall in `src/sources/registry.ts` ergänzen.
- **Neues Ziel**: `EgressTarget` implementieren, Fall in `src/targets/registry.ts` ergänzen.
- **Alles, was zur Oberfläche geht**: `src/approval/contract.ts`. Beide TypeScript-Projekte
  kompilieren dieselbe, importfreie Datei — ein umbenanntes Feld muss den Build brechen, nicht den
  Freigabedialog still leer lassen.

## Status des Wikis

`docs/wiki/` ist abgeleitet und nicht maßgeblich. Es darf niemals als Begründung für eine Änderung
angeführt werden. Code schlägt README schlägt Wiki. Eine Wiki-Seite, die dem Code widerspricht,
ist ein Fehler im Wiki.

## Was Rücksprache braucht

Vor der Änderung folgender Dinge nachfragen, nicht selbst entscheiden: die Egress-Oberfläche
(`src/core/egress.ts`), die Berechnung des Bindungs-Hashes, den Freigabeablauf, die geschlossene
Platzhalterliste einer Zusammenfassung, oder das Hinzufügen einer neuen Abhängigkeit.
