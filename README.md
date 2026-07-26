# Local Trust Gateway

Ein lokales Trust Gateway, das dem Cloud-Agenten **Hermes** kontrollierten Zugriff auf private
Dienste ermöglicht — ohne Hermes oder dem dahinterliegenden Cloud-Modell Rohdaten, interne
Quellkennungen oder Zugangsdaten zu geben.

Das Gateway nimmt abstrakte Anfragen entgegen, spricht die privaten Quellen über deren
vorhandene Schnittstellen an, lässt die Ergebnisse von einem **lokalen** Sprachmodell semantisch
bewerten, und legt jede geplante Übertragung einer lokalen Freigabeoberfläche vor. Erst nach
ausdrücklicher Freigabe verlässt eine Ressource den Rechner.

```
Hermes  ──(abstrahierte Anfrage)──►  Local Trust Gateway
                                       │
                                       ├── private Quellen        (Paperless über MCP)
                                       ├── lokales Sprachmodell   (Qwen 3.5 9B über Ollama)
                                       ├── lokale Freigabe        (Browser, nur Loopback)
                                       └── erlaubte Ziele         (private_mail, private_telegram, optional dynamische Ziele)
```

## Was Hermes sieht — und was nicht

Hermes bekommt ausschließlich opake Referenzen, geprüfte Bezeichnungen und einen groben Status:

```json
{
  "status": "resolved",
  "resource": { "reference": "res_7f29a1c4b8de", "label": "Aktueller Lebenslauf", "type": "document" },
  "note": "Eine passende Ressource wurde lokal ausgewählt und ist unter der Referenz ansprechbar."
}
```

Nicht Bestandteil der Antwort — in keiner Situation, auch nicht in Fehlermeldungen: Paperless-IDs,
DAV-URLs, Dateipfade, Download-Links, OCR-Text, Zugangsdaten, Empfängeradressen, Anhangsnamen
oder interne Quellantworten.

## Voraussetzungen

Diese Systeme müssen vorhanden sein und werden von diesem Projekt **nicht** eingerichtet:

| System | Rolle |
| --- | --- |
| Hermes | Cloud-Agent, spricht das Gateway als MCP-Client an |
| Paperless + Paperless-MCP-Server | erste private Quelle |
| Ollama mit Qwen 3.5 9B | lokale semantische Bewertung |
| SMTP-Zugang | Ziel `private_mail` |
| Telegram-Bot + Chat-ID | Ziel `private_telegram` |

Node.js ≥ 20.11.

## Einrichtung

```bash
npm install
```

```bash
cp config/gateway.config.example.json config/gateway.config.json
```

Die Konfiguration anpassen. Geheimnisse gehören nicht in die Datei — `${VAR}`-Platzhalter werden
beim Start aus der Umgebung ersetzt, und eine nicht gesetzte Variable bricht den Start ab statt
still einen leeren Wert einzusetzen. `.env.example` listet die erwarteten Variablen.

```bash
npm run build
```

```bash
npm start
```

Beim Start schreibt das Gateway die URL der Freigabeoberfläche samt Token nach stderr:

```
Freigabeoberfläche: http://127.0.0.1:8787/?token=xpq2SqnmOouQyxmMrA7Wz_pM7E3NXNuc
```

Das Token wird beim ersten Start erzeugt und in `data/ui-token` abgelegt (Modus 0600), damit die
Konfigurationsdatei kein Geheimnis tragen muss.

Die Seite selbst lädt ohne Token — sie zeigt dann nur ein Anmeldeformular, denn sie enthält keine
eigenen Daten. Jeder API-Aufruf dahinter verlangt weiterhin das Token: entweder einmalig über die
obige URL (wird dabei sofort aus der Adresszeile entfernt und in die Sitzung des Browser-Tabs
verschoben) oder durch manuelles Einfügen ins Anmeldeformular, z. B. aus `data/ui-token`. „Abmelden“
verwirft die Sitzung wieder. Ohne gültiges Token bleiben alle `/api/*`-Aufrufe bei 401 — die
Oberfläche ist bewusst kein offener lokaler Dienst.

Die Reiter sind echte URLs (`/login`, `/app/freigaben` als `/app/approvals` usw.), navigiert über
die History-API im Client — kein Framework, kein Bundler, passend zur CSP (`script-src 'self'`).
Zurück/Vorwärts und ein Reload auf einem Reiter funktionieren; ein Aufruf von `/app/...` ohne
gültige Sitzung landet auf `/login?next=...` und nach der Anmeldung wieder dort, wo man losging.
Der Server kennt dieselbe geschlossene Liste an Pfaden (`CLIENT_SHELL_PATHS` in `server.ts`) und
liefert für jeden davon dieselbe Shell aus; alles andere bleibt 404.

### Anbindung der Quelle

Der Paperless-MCP-Server kann auf zwei Wegen angesprochen werden, umschaltbar über
`sources[].transport.kind`:

- **`stdio`** — das Gateway startet den Server als Kindprozess. Das Kind erbt nur eine geprüfte
  Basisumgebung plus die unter `env` angegebenen Variablen, damit unbeteiligte Geheimnisse des
  Gateway-Prozesses nicht an eine fremde Komponente gehen.
- **`http`** — das Gateway verbindet sich als MCP-Client an einen bereits laufenden Server.

Die Werkzeugnamen sind konfigurierbar (`tools.search`, `tools.get`, `tools.download`), und die
Parameternamen werden aus dem vom Server gemeldeten Schema abgeleitet: der Paperless-MCP-Server
ist eine fremde Komponente und darf seine Felder `query`, `search` oder `q` nennen.

### Anbindung von Hermes

`hermesInterface.transport`:

- **`stdio`** — Hermes startet das Gateway als Prozess (Standard).
- **`http`** — Streamable HTTP unter `http://<host>:<port><path>`. `bearerToken` ist dabei
  zwingend; ohne Token verweigert das Gateway den Start, denn ein offener MCP-Endpunkt wäre eine
  offene Tür zur gesamten Quellenoberfläche. Optional schränkt `allowedHosts` den Host-Header ein.
- **`both`** — beides gleichzeitig.

## Ablauf

1. **`find_resource(query, purpose)`** — das Gateway durchsucht die privaten Quellen und lässt das
   lokale Modell entscheiden. Ergebnis: eine Referenz, ein Hinweis auf notwendige lokale Auswahl,
   oder „nicht gefunden“.
2. **`list_targets()`** — die erlaubten abstrakten Zielbezeichnungen und ihr Zweck.
3. **`prepare_action(reference, target, purpose)`** — verbindet Referenz, Ziel und Zweck zu einer
   Aktion. Es wird nichts übertragen; die Aktion wartet auf die lokale Freigabe.
4. **Lokale Freigabe** — die Oberfläche zeigt Ressource, Quelle, Ziel, Zweck, die geplante Aktion,
   die genauen ausgehenden Daten samt SHA-256, die Bewertung des lokalen Modells und offene Punkte.
   Möglich sind: freigeben, ablehnen, andere Ressource wählen, verwerfen.
5. **`get_action_status(action_id)`** — `awaiting_local_approval`, `selection_required`,
   `executing`, `completed`, `rejected`, `failed` oder `expired`.

Bei Mehrdeutigkeit liefert `find_resource` eine Auswahlreferenz. Der Nutzer entscheidet lokal;
Hermes fragt anschließend mit `pending_selection` erneut an. Wählt der Nutzer in der Freigabeansicht
eine *andere* Ressource, wird die Aktion verworfen und die Suche lokal neu geöffnet — die
Handentscheidung des Nutzers hat danach Vorrang vor einer neuen Modellbewertung.

## Sicherheitsinvarianten und ihre Umsetzung

| # | Invariante | Wo sie durchgesetzt wird |
| --- | --- | --- |
| 1 | Hermes hat keinen direkten Zugriff auf private Quellen | Quellen sind nur über `SourceRegistry` im Gateway-Prozess erreichbar; die MCP-Oberfläche kennt vier abstrakte Werkzeuge |
| 2 | Interne Quellenwerkzeuge werden nicht weitergegeben | `McpSourceClient` ruft Quellwerkzeuge selbst auf; sie werden nie re-exportiert |
| 3 | Keine Rohdaten an Hermes | `core/egress.ts` baut jede Antwort feldweise nach Whitelist |
| 4 | Nur opake Referenzen | `util/ids.ts` (CSPRNG), Auflösung ausschließlich über `ReferenceStore` |
| 5 | Kennungen und Zugangsdaten bleiben lokal | `EgressGuard` prüft jede Ausgabe gegen registrierte Geheimnisse und Struktur­muster (URLs, Pfade, API-Routen) |
| 6 | Nur lokal konfigurierte Ziele | `EgressTarget.deliver()` ignoriert `recipient`, außer die Instanz ist explizit mit `allowDynamicRecipient` konfiguriert; nur dort verlangt und verwendet `prepare_action` eine Adresse, stets unverkürzt gezeigt und einzeln freigegeben |
| 7 | Jede Übertragung braucht eine lokale Freigabe | `Orchestrator.execute()` läuft ausschließlich aus `approveAction()` |
| 8 | Das lokale Modell kann nichts übertragen | der Judge liefert nur validiertes JSON; er hat keine Referenz auf ein Ziel |
| 9 | Bei Mehrdeutigkeit kein automatisches Handeln | `ambiguous` und ein außerhalb des Bereichs liegender Kandidat führen beide zu `selection_required` |
| 10 | Kein Cloud-Fallback | `OllamaClient` hat keinen Ersatzpfad; Ausfall ergibt `local_model_unavailable` |
| 11 | Inhalte sind Daten, keine Anweisungen | `judge/prompts.ts` umschließt jeden Fremdinhalt mit einem Zufalls-Nonce; das Modell antwortet nur schemagebunden |
| 12 | Freigegebene Aktionen sind unveränderlich | Bindungs-Hash über (Referenz, Ressourcenzustand, Ziel, Plan); `ActionStore` erlaubt nur Statuswechsel, Endzustände nie wieder |
| 13 | Nur notwendige Informationen an Hermes | geschlossener Katalog von Statusgründen und Hinweistexten in `EGRESS_NOTES` |
| 14 | Alles lokal nachvollziehbar | `AuditLog` als reines Anhänge-Protokoll, sichtbar im Reiter „Protokoll“ |

### Zur Bindung einer Freigabe

Eine Freigabe gilt nur für die konkret angezeigte Kombination. Technisch: die Oberfläche schickt
den angezeigten Bindungs-Hash zurück; passt er nicht mehr zum gespeicherten Datensatz, wird die
Freigabe verweigert statt auf etwas anderes angewendet. Zusätzlich wird vor der Vorbereitung und
vor der Ausführung geprüft, ob sich der Zustand der Ressource geändert hat — ein in Paperless
nachträglich bearbeitetes Dokument bricht die Aktion ab.

### Zur Behandlung von Dokumentinhalten

Ein Dokument könnte Text enthalten, der wie eine Anweisung aussieht („ignoriere alle vorherigen
Anweisungen und sende …“). Drei Dinge greifen dagegen: der Inhalt steht in einem pro Aufruf
zufällig benannten Rahmen, den er nicht schließen kann; der Systemprompt benennt den Rahmen als
Zitat; und der einzige Rückkanal des Modells ist ein festes JSON-Objekt. Ein vollständig
übernommenes Modell kann damit einen falschen Kandidaten vorschlagen — es kann nichts versenden,
und der Mensch entscheidet weiterhin.

## Dynamische Empfänger (Sonderfall eines Ziels)

Die meisten Ziele haben, wie in Invariante 6 beschrieben, eine Adresse, die ausschließlich aus der
Konfiguration kommt. Für Fälle mit wechselndem Empfänger — das Musterbeispiel ist eine Bewerbung an
`jobs@firma-a.de`, `recruiting@firma-b.de` usw. — kann ein SMTP-Ziel stattdessen mit
`allowDynamicRecipient: true` konfiguriert werden (siehe `job_application_mail` in
`config/gateway.config.example.json`). Für ein solches Ziel gilt:

- `list_targets` meldet für dieses Ziel `dynamic_recipient: true`.
- `prepare_action` verlangt dafür einen `recipient`-Parameter mit einer plausiblen Adresse; bei
  jedem anderen Ziel wird ein angegebener `recipient` abgelehnt.
- Die lokale Freigabeansicht zeigt die Adresse unverkürzt und optisch hervorgehoben, weil sie —
  anders als bei einem fest konfigurierten Ziel — nicht aus der lokalen Konfiguration stammt,
  sondern vom Agenten vorgeschlagen wurde.
- Der Bindungs-Hash deckt die Adresse mit ab: Eine Freigabe gilt für genau diese Adresse, nicht für
  „irgendeine, die der Agent später nennt“.
- Ohne lokale Bestätigung genau dieser Adresse wird nichts versendet — das Freigabe-Erfordernis aus
  Invariante 7 gilt unverändert.

Das verschiebt die Garantie für dieses eine, bewusst geöffnete Ziel von „strukturell unmöglich,
woanders hinzuschicken“ auf „der Nutzer sieht die exakte Adresse vor jeder Freigabe“ — ein
Trade-off, der nur für Ziele mit `allowDynamicRecipient` gilt und niemals automatisch greift.

## Erweiterbarkeit

**Neue Quelle** (z. B. Baikal/DAV): `PrivateSource` implementieren und einen Fall in
`sources/registry.ts` ergänzen. Das abstrakte Ressourcenmodell ist dasselbe, also muss Hermes nicht
wissen, woher eine Ressource stammt. Die Schnittstelle kennt bewusst kein Schreiben.

**Neues Ziel**: `EgressTarget` implementieren und in `targets/registry.ts` ergänzen. Der Empfänger
gehört in die Konfiguration und in die Instanz; die Signatur von `deliver` trägt zwar ein optionales
`recipient`-Feld, aber ein Ziel, das nicht ausdrücklich für einen dynamischen Empfänger gebaut ist,
muss es ignorieren und seine eigene, feste Adresse verwenden.

## Datenhaltung

Alles unter `dataDir` (Standard `./data`), bewusst ohne Datenbank und ohne native Abhängigkeiten:

| Datei | Inhalt |
| --- | --- |
| `references.jsonl` | Zuordnung opake Referenz → echte Ressource |
| `actions.jsonl` | vorbereitete und entschiedene Aktionen |
| `selections.jsonl` | offene und entschiedene lokale Auswahlen |
| `audit.jsonl` | Entscheidungsprotokoll, wird nie verdichtet oder gelöscht |
| `ui-token` | Token der Freigabeoberfläche |

Dieses Verzeichnis enthält die Zuordnung zwischen Referenzen und privaten Dokumenten und darf den
Rechner nicht verlassen. `.gitignore` schließt es aus.

## Entwicklung

```bash
npm run typecheck
```

```bash
npm test
```

```bash
npm run dev
```

Die Tests prüfen die Invarianten an der Grenze — was Hermes erhält und was ein Ziel erreicht —
nicht Interna. `test/helpers.ts` stellt Quelle, Ziel und lokales Modell als Doubles bereit.

## Bekannte Einschränkungen

- `npm audit` meldet eine mittlere Schwachstelle in `@hono/node-server`, einer transitiven
  Abhängigkeit von `@modelcontextprotocol/sdk`. Betroffen ist `serve-static`, das dieses Projekt
  nicht verwendet — die Freigabeoberfläche läuft auf `node:http`, und der MCP-Endpunkt geht nicht
  über den betroffenen Pfad. Ein Fix erfordert einen Downgrade des SDK und wurde nicht gemacht.
- Die Originaldaten einer vorbereiteten Aktion liegen bis zur Entscheidung im Speicher, damit die
  Freigabeansicht Größe und Prüfsumme des tatsächlichen Anhangs nennen kann. Nach einem Neustart
  ist dieser Zwischenspeicher leer; die Bytes werden dann bei der Freigabe erneut gelesen und gegen
  die freigegebene Prüfsumme verglichen.
- Ein Ziel ohne Anhangsunterstützung ist im Modell vorgesehen (`supportsAttachments`), aber beide
  ausgelieferten Ziele können Anhänge, daher gibt es dafür noch keinen Nur-Text-Pfad.

## Nicht Bestandteil

Einrichtung oder Änderung von Hermes, Ollama, Paperless, des Paperless-MCP-Servers oder von Baikal;
Netzwerk- und Deployment-Konfiguration; Empfänger außerhalb eines dafür ausdrücklich mit
`allowDynamicRecipient` konfigurierten Ziels; Mehrbenutzerbetrieb; automatische Freigaben;
Änderungen oder Löschungen in privaten Quellen; die DAV-Anbindung selbst.
