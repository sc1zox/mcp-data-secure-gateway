# CLAUDE.md

Verbindlich ist `AGENTS.md` — zuerst lesen. Diese Datei fügt den dortigen Regeln nichts hinzu, nur
Claude-Code-spezifische Betriebshinweise:

- `data/`, `.env` und `config/gateway.config.json`: tabu, weder lesen noch schreiben.
- `npm run build` braucht Node ≥ 22.22.3 (Angular 22); `npm start` läuft bereits ab ≥ 20.11.
- Workflow-Validator: `npm run check:docs`.
