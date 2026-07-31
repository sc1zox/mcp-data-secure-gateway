# Verifikationsmatrix

Jedes Kommando, das in `AGENTS.md` oder `CLAUDE.md` in einem ```` ```bash ````-Block steht, muss hier
mit einem Status geführt sein — das erzwingt `.ai-workflow/check-docs.mjs` (Regel 5). Kein Kommando
in dieser Datei ist erfunden; jedes ist entweder ein Skript aus `package.json`/`ui/package.json` oder
ein wörtlicher `node`-Aufruf gegen eine existierende Datei.

| Kommando | Deckt ab | Laufzeit | Status |
| --- | --- | --- | --- |
| `npm test` | 298 Tests / 66 Suites: Invarianten 3,4,5,6,7,9,10,11,12,14; Zusammenfassungspfad; Mehrfachanhänge; Stores samt Audit-Aufbewahrung; Judge-Validierung; MCP-Werkzeugoberfläche; Bindungs-Golden-Vektoren; Schutz gegen Freigabeflut | ~3,5 s | **verifiziert 2026-07-31** (`pass 296 · fail 0 · skipped 2`) |
| `npm run typecheck` | `tsc -p tsconfig.json --noEmit` **und** `npm --prefix ui run typecheck`; erzwingt insbesondere, dass `src/approval/contract.ts` von beiden Projekten gleich gelesen wird | ~2 s | **verifiziert 2026-07-31** (exit 0) |
| `npm run check:docs` | Pfadverweise in `AGENTS.md`/`CLAUDE.md`/`.ai-workflow/*.md`/`docs/wiki/*.md`; Vollständigkeit der Source Map; Invarianten 1–14 in `.ai-workflow/ownership.md`; `Quelle:`-Zeile je Wiki-Seite; dokumentierte Kommandos | < 1 s | **verifiziert 2026-07-31** (exit 0) |
| `node --import tsx --test test/binding.golden.test.ts` | nur die vier Bindungs-Golden-Vektoren (Spezialisierung von `npm test`) | < 1 s | **verifiziert 2026-07-31** (`pass 4 · fail 0`) |
| `npm run build` | UI-Build (Angular 22) + `tsc` nach `dist/`; **der einzige Lauf, der Angular-Templates übersetzt** — `npm run typecheck` ruft in `ui/` nur `tsc --noEmit` und sieht Templates nicht | ~6 s | **verifiziert 2026-07-31** (exit 0, Bundle 748,54 kB). Die Budgetwarnung (725 kB) besteht seit vorher: derselbe Lauf vor dieser Änderung ergab 748,22 kB |
| `npm run setup` | Installiert beide Abhängigkeitsbäume (`npm install` + `npm --prefix ui install`) | unbekannt | **nicht verifiziert** (Installation war nicht Teil dieser Sitzung; beide `node_modules` sind bereits vorhanden) |
| `npm start` / `npm run dev` | Laufzeitbetrieb des Gateways | — | **nicht ausführbar ohne** Ollama, Paperless-MCP, SMTP/Telegram-Zugang (`README.md`, Abschnitt „Voraussetzungen“) |

## Warum keine weiteren Zeilen

`AGENTS.md` nennt ausdrücklich, dass es keine weitere automatisierte Prüfung in diesem Repository
gibt — keine CI, kein Lint- und kein Formatierungsbefehl. Diese Datei erfindet keinen.
