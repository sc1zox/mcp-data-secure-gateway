# Glossar

> **Kein maßgebliches Dokument.** Verbindlich sind `README.md`, der Quellcode und `test/`. Diese Seite wird von einem Sprachmodell gepflegt und kann veraltet oder schlicht falsch sein.

Stand: 14728fe9495cd19758e8f71e6f2704dc8fc7044e (2026-07-28)

Deutsche Fachbegriffe, wie sie in Bezeichnern und Prosa des Projekts vorkommen.

- **Referenz** — eine opake, zufällig erzeugte Kennung (`src/util/ids.ts`), die auf eine echte
  Ressource verweist. Die einzige Form, in der Hermes eine Ressource ansprechen kann.
- **Aktion** — ein vorbereiteter Versand oder eine vorbereitete Zusammenfassung, mit eigenem
  Status und eigener Bindung (`src/core/types.ts`, `ActionRecord`).
- **Bindungs-Hash** — interne Prüfsumme über Ressource(n), Zustand, Ziel und Plan
  (`resourceStateHash()`, `computeBindingHash()` in `src/core/orchestrator.ts`). Sie prüft den
  gespeicherten Datensatz vor der Ausführung gegen sich selbst und wird nicht angezeigt; der Nutzer
  bestätigt eine Aktions-ID.
- **Freigabe** — die ausdrückliche, lokale Entscheidung des Nutzers, eine Aktion auszuführen. Der
  einzige Weg zur Ausführung (`approveAction()`).
- **Auswahl** — die lokale Entscheidung zwischen mehreren mehrdeutigen Kandidaten, wenn
  `find_resource` keine eindeutige Referenz liefern kann.
- **Zweckbindung** — jede Referenz ist für genau den Zweck geprägt, mit dem sie entstand; ein
  anderer Zweck braucht eine neue Referenz.
- **Judge** — das lokale Sprachmodell und seine Auswertung (`src/judge/`). Liefert nur
  schemagebundenes JSON und hat keine Referenz auf ein Ziel.
- **Egress-Guard** — die Prüfung, die jede Ausgabe an Hermes gegen registrierte Geheimnisse und
  gegen Strukturmuster wie URLs oder Pfade prüft (`EgressGuard` in `src/core/egress.ts`).
- **Ziel** — eine konfigurierte, abstrakt benannte Zustellstelle (`EgressTarget`,
  `src/targets/`), z. B. `private_mail`.
- **Quelle** — ein konfigurierter, nur lesbarer Zugriff auf einen privaten Dienst
  (`PrivateSource`, `src/sources/`), z. B. Paperless.

Quelle: `src/core/types.ts`
