# Ownership

Rückwärtsindex: jede der 14 Sicherheitsinvarianten aus `README.md` (Abschnitt „Sicherheitsinvarianten
und ihre Umsetzung") auf die Datei(en) und Symbol(e), die sie im aktuellen Arbeitsbaum durchsetzen.
Diese Datei erklärt nichts neu — sie zeigt nur, wo im Code eine Invariante steht. Geprüft von
`.ai-workflow/check-docs.mjs` (Regel: jede Zahl 1–14 kommt genau einmal als Invariantenzeile vor).

| Inv. | Datei · Symbol |
| --- | --- |
| 1 | `src/sources/registry.ts` · `SourceRegistry`; `src/mcp/hermesServer.ts` · 7× `registerTool` (Zeilen 77, 122, 140, 252, 304, 325, 342) |
| 2 | `src/sources/mcpSourceClient.ts` · `McpSourceClient` (Zeile 19) |
| 3 | `src/core/egress.ts` · `publicResourceRef` (414), `publicTarget` (422), `publicActionState` (438), `publicSummary` (502) |
| 4 | `src/util/ids.ts` · `newResourceRef` (16); `src/store/referenceStore.ts` · `ReferenceStore` (17) |
| 5 | `src/core/egress.ts` · `EgressGuard` (200), `SUSPICIOUS_PATTERNS` (280), `withoutSummary` (Ausnahme für den freigegebenen Zusammenfassungstext); `src/index.ts` · `registerSecrets` (215) |
| 6 | `src/targets/target.ts` · `EgressTarget.deliver` (20); `src/core/actionPreparation.ts` · Empfänger-Gate (145–151) |
| 7 | `src/core/orchestrator.ts` · `approveAction` (387), `getSummary` (245); `src/core/actionExecutor.ts` · `execute` (76) |
| 8 | `src/judge/judge.ts` · `Judge` (113) |
| 9 | `src/core/selectionFlow.ts` · `SelectionFlow.createSelection` (39), `SelectionFlow.resumeSelection` (150) |
| 10 | `src/judge/ollamaClient.ts` · `LocalModelUnavailableError` (12) |
| 11 | `src/judge/prompts.ts` · `fence` (fester Marker, Marker wird vorher aus dem Inhalt entfernt), `INJECTION_RULES` |
| 12 | `src/store/actionStore.ts` · `ActionImmutabilityError` (6), `ALLOWED_TRANSITIONS`, `discardOpen` (verwirft offene Aktionen beim Start); `src/core/binding.ts` · `computeBindingHash` (47), `resourceStateHash` (20), `isConsistentStoredResourceSet` (79) als interne Selbstprüfung |
| 13 | `src/core/egress.ts` · `EGRESS_NOTES` (80), `EgressNoteCode` (38) |
| 14 | `src/store/auditLog.ts` · `AuditLog` (73), `prune` (Aufbewahrungsfenster) |

## Ohne dedizierten Test

Invarianten 1, 2, 8, 13 haben keine eigene Suite in `test/invariants.test.ts` — sie sind nur
strukturell durchgesetzt (siehe `.ai-workflow/verification.md`). Das ist ein dokumentierter Befund,
keine Lücke, die diese Datei schließt.

## Stand seit der Zerlegung

`src/core/orchestrator.ts` ist entlang von Sicherheitsverantwortung in dedizierte Module zerlegt:
`src/core/limits.ts`, `src/core/binding.ts`, `src/core/agentInput.ts`,
`src/core/attachmentSafety.ts`, `src/core/planBuilder.ts`, `src/core/refusals.ts`,
`src/core/decisionWaiters.ts`, `src/core/resourceGate.ts`, `src/core/actionExecutor.ts`,
`src/core/selectionFlow.ts`, `src/core/localViews.ts`, `src/core/preparationLimits.ts`. Der Koordinator bleibt schlank, mit
unveränderter öffentlicher Signatur und den Re-Exports, die
`test/store.test.ts` und `test/multi-attachments.test.ts` lauffähig halten. Zeilenangaben oben
spiegeln den aktuellen Arbeitsbaum; bei weiteren Verschiebungen ist diese Datei zusammen mit dem
Verschiebe-Schritt zu korrigieren.
