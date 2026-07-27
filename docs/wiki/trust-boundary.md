# Vertrauensgrenze

> **Kein maßgebliches Dokument.** Verbindlich sind `README.md`, der Quellcode und `test/`. Diese Seite wird von einem Sprachmodell gepflegt und kann veraltet oder schlicht falsch sein.

Stand: 14728fe9495cd19758e8f71e6f2704dc8fc7044e (2026-07-28)

Diese Seite beschreibt, was den Rechner in Richtung Hermes verlässt und was nicht. Für die
vollständige, nummerierte Liste der 14 Sicherheitsinvarianten und ihre Durchsetzung im Code ist
`README.md` (Abschnitt „Sicherheitsinvarianten und ihre Umsetzung") die maßgebliche Quelle — diese
Seite kopiert sie nicht, sondern beschreibt nur den Mechanismus.

## Was nach außen geht

Jede Antwort an Hermes entsteht in `src/core/egress.ts` feldweise nach Whitelist: opake Referenzen,
geprüfte Bezeichnungen, ein grober Status, und Hinweistexte ausschließlich aus dem geschlossenen
`EGRESS_NOTES`-Katalog. Nicht Bestandteil einer Antwort: interne Quellkennungen, Dateipfade,
Download-Links, OCR-Text, Zugangsdaten, Empfängeradressen oder Anhangsnamen.

## Die zwei modellverfassten Ausnahmen

Zwei Texte im System stammen nicht aus der Whitelist, sondern vom lokalen Modell, und beide
durchlaufen dieselbe Egress-Prüfung wie alles andere, bevor sie irgendwo sichtbar werden:

- **`safeLabel`** — eine geprüfte Kurzbezeichnung einer Ressource.
- **Die redigierte Zusammenfassung** — Ergebnis von `summarize_resource`. Sie enthält nur
  Platzhalter aus der geschlossenen Liste in `REDACTION_PLACEHOLDERS`
  (`src/core/types.ts`) statt Namen, Adressen, Kontaktdaten, Aktenzeichen, Beträgen, Daten,
  Gesundheitsangaben oder Zugangsdaten. Erst nach ausdrücklicher lokaler Freigabe holt `get_summary`
  sie ab.

Beide Ausnahmen sind kein Loch in der Grenze, sondern ein zweiter, ebenso geprüfter Weg über
dieselbe Grenze — siehe `README.md`, Abschnitt „Redigierte Zusammenfassungen".

## Was die Grenze durchsetzt

`EgressGuard` (`src/core/egress.ts`) prüft jede Ausgabe gegen registrierte Geheimnisse und gegen
Strukturmuster wie URLs, Pfade und API-Routen, und verwirft eine Antwort statt sie zu kürzen. Ein
Versand selbst braucht zusätzlich eine lokale Freigabe mit passendem Bindungs-Hash — siehe
[data-and-state.md](data-and-state.md).

Quelle: `README.md#sicherheitsinvarianten-und-ihre-umsetzung`
