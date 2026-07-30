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
                                       ├── lokale Freigabe        (Browser, optional Telegram)
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

Die einzige Ausnahme ist eine **redigierte Zusammenfassung**, und sie ist keine Lücke, sondern ein
eigener Ablauf: das lokale Modell schreibt sie, der Nutzer liest sie im Wortlaut, und erst seine
Freigabe macht sie abholbar (siehe [Redigierte Zusammenfassungen](#redigierte-zusammenfassungen)).

## Voraussetzungen

Diese Systeme müssen vorhanden sein und werden von diesem Projekt **nicht** eingerichtet:

| System | Rolle |
| --- | --- |
| Hermes | Cloud-Agent, spricht das Gateway als MCP-Client an |
| Paperless + Paperless-MCP-Server | erste private Quelle |
| Ollama ≥ 0.5 mit Qwen 3.5 9B | lokale semantische Bewertung |
| SMTP-Zugang | Ziel `private_mail` |
| Telegram-Bot + Chat-ID | Ziel `private_telegram` |
| Separater Telegram-Bot + private Chat-/Benutzer-ID (optional) | zusätzlicher Freigabekanal |

Node.js ≥ 20.11 für das Gateway selbst. Der **Build der Freigabeoberfläche** braucht zusätzlich
Node ≥ 22.22.3 (oder ≥ 24.15.0), weil Angular 22 das verlangt. Das betrifft nur `npm run build`,
nicht den Betrieb: `npm start` läuft weiterhin unter 20.11.

## Einrichtung

Die Oberfläche liegt als eigenes npm-Projekt unter `ui/` mit eigenem `node_modules`. Das ist
Absicht und kein Workspace: das Gateway kompiliert mit TypeScript 5.9, Angular 22 bringt 6.0 mit,
und getrennte Abhängigkeitsbäume verhindern, dass npm eine der beiden Versionen nach oben hoistet
und der Gateway-Build eine andere erwischt als vorgesehen.

```bash
npm run setup
```

Das installiert beide Bäume. Einzeln wäre es `npm install` plus `npm --prefix ui install`.

```bash
cp config/gateway.config.example.json config/gateway.config.json
```

Die Konfiguration anpassen. Geheimnisse gehören nicht in die Datei — `${VAR}`-Platzhalter werden
beim Start aus der Umgebung ersetzt, und eine nicht gesetzte Variable bricht den Start ab statt
still einen leeren Wert einzusetzen. `.env.example` listet die erwarteten Variablen.

```bash
npm run build
```

Das baut erst die Oberfläche nach `dist/approval/ui` und übersetzt dann das Gateway. Für die
Arbeit an der Oberfläche gibt es `npm run dev:ui` — der Angular-Dev-Server liefert die Seite mit
Hot Reload und leitet `/api` an ein laufendes Gateway auf Port 8787 weiter (`ui/proxy.conf.json`).

```bash
npm start
```

`approval.uiToken` ist ein erforderliches Secret und wird in der Beispielkonfiguration über
`${APPROVAL_UI_TOKEN}` aus der Umgebung bezogen. Beim Start schreibt das Gateway die URL der
Freigabeoberfläche samt Token nach stderr:

```
Freigabeoberfläche: http://127.0.0.1:8787/?token=xpq2SqnmOouQyxmMrA7Wz_pM7E3NXNuc
```

Die Seite selbst lädt ohne Token — sie zeigt dann nur ein Anmeldeformular, denn sie enthält keine
eigenen Daten. Jeder API-Aufruf dahinter verlangt weiterhin das Token: entweder einmalig über die
obige URL (wird dabei sofort aus der Adresszeile entfernt und in die Sitzung des Browser-Tabs
verschoben) oder durch manuelles Einfügen ins Anmeldeformular. `sessionStorage` ist nur der
Sitzungsspeicher des Browser-Tabs; das Gateway erzeugt oder liest keine persistierte Token-Datei.
„Abmelden“ verwirft die Sitzung wieder. Ohne gültiges Token bleiben alle `/api/*`-Aufrufe bei 401
— die Oberfläche ist bewusst kein offener lokaler Dienst.

### Aufbau der Oberfläche

Angular 22 mit Angular Material, gebaut nach `dist/approval/ui` und von `approval/server.ts`
ausgeliefert. Vier Entscheidungen prägen sie:

- **Ein geteilter Contract.** `src/approval/contract.ts` beschreibt das Wire-Format und ist
  importfrei, damit beide TypeScript-Projekte dieselbe Datei kompilieren können. Der Server pinnt
  seine Antworten per `satisfies` dagegen, die Oberfläche liest dieselben Deklarationen. Ein
  umbenanntes Feld bricht dadurch den Build, statt im Freigabedialog still leer zu bleiben.
- **Ein Ort für den Sitzungszustand.** Token, Guard und Routing hängen an einem einzigen Signal.
  Die frühere Oberfläche hielt denselben Zustand in vier Formen gleichzeitig, die auseinanderlaufen
  konnten — so erschien das Anmeldeformular über einem bereits angemeldeten Dashboard.
- **Fakten vor Einschätzung.** Die Detailansicht führt erst auf, was den Rechner verlässt, dann
  woher es stammt, und zuletzt was das lokale Modell davon hält. Ein vom Agenten vorgeschlagener
  Empfänger steht dabei groß und in Monospace, und die Freigabe verlangt für solche Ziele eine
  ausdrückliche Bestätigung, dass die Adresse geprüft wurde.
- **Zwei Arten von Freigabe, zwei Ansichten.** Ein Versand und eine Zusammenfassung stehen im
  selben Reiter, sehen aber bewusst nicht gleich aus: beim Versand ist das riskante Feld der
  Empfänger, bei einer Zusammenfassung ist es der Text selbst. Der steht deshalb rot hinterlegt,
  vollständig und ohne eigenen Scrollbereich — ein Text, den man scrollen muss, ist ein Text, den
  man überfliegt — und die Bestätigung verlangt hier immer ein ausdrückliches „gelesen".

Die Seite kommt ohne Netzzugriff aus: Systemschriften statt Webfonts, Icons als Inline-SVG. Sie
läuft unter `default-src 'none'`. Angular fügt Komponentenstyles zur Laufzeit als `style`-Element
ein, was `style-src 'self'` zu Recht verbietet — statt auf `'unsafe-inline'` auszuweichen, setzt
der Server pro Auslieferung eine frische Nonce in `index.html` und in den CSP-Header.

Die Reiter sind echte URLs (`/login`, `/app/approvals`, `/app/telegram-approval` usw.), navigiert
über die History-API im Client — kein Framework, kein Bundler, passend zur CSP
(`script-src 'self'`).
Zurück/Vorwärts und ein Reload auf einem Reiter funktionieren; ein Aufruf von `/app/...` ohne
gültige Sitzung landet auf `/login?next=...` und nach der Anmeldung wieder dort, wo man losging.
Der Server kennt dieselbe geschlossene Liste an Pfaden (`CLIENT_SHELL_PATHS` in `server.ts`) und
liefert für jeden davon dieselbe Shell aus; alles andere bleibt 404.

### Optionaler Telegram-Freigabekanal

Im Reiter „Telegram“ lässt sich ein zweiter Entscheidungskanal einrichten. Er ist standardmäßig
deaktiviert und unabhängig vom Versandziel `private_telegram`: Ein eigener Bot benachrichtigt nur
über wartende Freigaben und führt eine erlaubte Entscheidung über denselben Orchestrator und
denselben Bindungs-Hash aus wie das Browserportal. Er versendet keine Originaldateien und ändert
die Konfiguration der ausgehenden Ziele nicht.

Telegram ist ein externer Cloud-Dienst und bekommt deshalb nichts, was aus einem privaten Dokument
gelesen wurde. Es geht dorthin, woran eine wartende Freigabe zu erkennen ist — Dokumentname, Quelle
und Quellkennung, Medientyp und Größe, Zweck, Ziel und Empfänger, Anhangsnamen mit Prüfsummen sowie
die Modellbewertung als Sensibilität und Konfidenz — und bei einer Sendung zusätzlich Betreff und
Nachrichtentext im Wortlaut. Maßgeblich ist die Herkunft der Zeichen, nicht ihr Empfänger: Betreff
und Text sind entweder lokal aus Zweck und geprüfter Bezeichnung zusammengestellt oder vom
Cloud-Agenten geschrieben, der sie ohnehin schon hat. Aus dem Dokument gelesen sind dagegen
Textauszüge, dessen Merkmale, die Begründung des Modells und der Text einer Zusammenfassung; die
bleiben im Browserportal, ebenso Originaldateien, Portal-/MCP-Tokens und Quell-URLs. Dokumentnamen,
Zweck, Anhangsnamen, der Nachrichtentext und bei einem Ziel mit angebbarem Empfänger dessen
vollständige Adresse sind selbst schon aussagekräftig; deshalb muss der verwendete Chat privat sein.
Nur die fest gespeicherte Chat-ID zusammen mit der fest gespeicherten Telegram-Benutzer-ID darf
entscheiden.

Was hier nicht zu sehen ist, kann hier auch nicht freigegeben werden: Eine **Zusammenfassung**
bekommt in Telegram nur „Ablehnen“, weil ihre Freigabe genau der Text ist, der nicht dorthin geht —
eine Freigabe wäre die Freigabe von Zeichen, die niemand gelesen hat, und sie wird auch bei
manipulierten Callback-Daten verweigert. Freigegeben wird sie im Portal. Eine **Sendung** ist in
Telegram entscheidbar, weil ihr vollständiger Text dort steht; ihre Anhänge sind Dateien und werden
über Name, Medientyp, Größe und SHA-256 identifiziert, nicht gelesen — wer den Inhalt eines Anhangs
vor der Entscheidung sehen will, öffnet das Portal.

Die Einrichtung erfolgt ausschließlich im token-geschützten lokalen Portal:

1. Einen separaten Bot verwenden, den kein anderer Long-Polling-Client abfragt.
2. Bot-Token, private Chat-ID und die eigene numerische Benutzer-ID eintragen.
3. Speichern, die Bot-Verbindung testen und den Schalter „Aktiviert“ einschalten.

Der Token wird nie aus der API zurückgegeben oder erneut ins Formular eingesetzt; ein leeres
Tokenfeld behält den gespeicherten Wert bei. Chat- und Benutzer-ID erscheinen nach dem Speichern
nur maskiert. Die Angaben liegen ausschließlich als authentifiziert verschlüsselter
AES-256-GCM-Payload in `telegram-approval.json` unter `dataDir` mit Dateimodus 0600. Der separate,
erforderliche Master-Key `approval.telegramSettingsKey` kommt über
`${TELEGRAM_APPROVAL_SETTINGS_KEY}` aus der Gateway-Umgebung, liegt niemals in dieser Datei und
wird weder an die Portal-API noch an Hermes gegeben. Salt und Nonce werden bei jedem Speichern neu
erzeugt; `scrypt` leitet daraus und aus dem Master-Key den AES-Schlüssel ab.

Beim ersten Start nach einem Upgrade wird eine vorhandene Legacy-Klartextdatei nur geladen, wenn
sie exakt der bekannten alten Struktur entspricht; sie wird noch während des Starts atomar durch
Ciphertext ersetzt. Unvollständige, unbekannte oder beschädigte Strukturen sowie ein falscher
Master-Key brechen den Start ab, ohne alte Werte zu protokollieren. Vor dem Upgrade daher einen
stabilen Master-Key setzen und sicher verwahren. Geht er verloren, müssen die Telegram-Angaben neu
eingegeben werden.

Der Adapter verwendet `getUpdates` mit Long Polling und registriert keinen Webhook oder öffentlich
erreichbaren Endpunkt. „Deaktivieren“ stoppt das Polling, behält die lokalen Angaben aber für eine
spätere Reaktivierung. Für einen vollständigen Widerruf den Bot-Token bei Telegram widerrufen und
den gespeicherten Token im Portal ersetzen. Ausfall, unvollständige Konfiguration oder
Deaktivierung von Telegram sperren den Browserweg nicht; Freigeben und Ablehnen bleiben dort
weiterhin möglich.

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

Gleiche Werkzeugnamen bedeuten aber nicht gleiche Rückgaben, und an einer Stelle ist das
bindend: `tools.download` muss die Datei **im Werkzeugergebnis selbst** liefern. Das Gateway
akzeptiert einen `resource`-Content-Part mit `blob`, einen `image`-, `audio`- oder
`blob`-Part mit `data`, oder strukturiertes JSON mit einem Feld `content`, `data`, `blob`
oder `base64` (`binaryOf` in `src/sources/mcpSourceClient.ts`). Einer Resource-URI, die erst
über `resources/read` aufgelöst werden müsste, folgt es nicht.

Ein Server, der das anders hält, fällt spät auf: Er verbindet sich, meldet alle drei
Werkzeuge, beantwortet Suche und Metadaten korrekt — und scheitert erst bei `prepare_action`
mit `source_unavailable` und „lieferte keine Dateidaten". Vor dem Eintragen lohnt daher ein
Blick in die Beschreibung von `download_document`; `npm pack <paket>` und ein Blick in das
entpackte Archiv genügen, ohne den Server auszuführen.

Das in älteren Anleitungen genannte Paket `paperless-mcp` ist seit Ende 2024 auf npm
zurückgezogen. Die Beispielkonfiguration verweist deshalb auf `@kjanat/paperless-mcp`, das
die Datei base64-kodiert im Ergebnis liefert. Es erwartet den Token unter
`PAPERLESS_API_KEY`; die Variable des Gateways heißt weiterhin `PAPERLESS_API_TOKEN`, die
Zuordnung geschieht in `transport.env`. Der Weg über die Umgebung ist auch der einzig
richtige — ein Token als Kommandozeilenargument steht in der Prozessliste jedes Nutzers,
der `ps` aufrufen kann.

Optional `sources[].webBaseUrl`: die Adresse der Paperless-Weboberfläche. Ist sie gesetzt, führt
die Freigabeansicht neben jeder Ressource und jedem Auswahlkandidaten einen Link auf das echte
Dokument — bei mehreren fast gleich betitelten Dokumenten ist ein Blick hinein die einzige
verlässliche Unterscheidung. Der Link entsteht nur für numerische Paperless-IDs, wird erst beim
Rendern gebildet (ein nachträglich konfiguriertes `webBaseUrl` gilt also sofort auch für bereits
vorbereitete Aktionen) und ist rein lokal: die Egress-Prüfung weist jede Antwort an Hermes ab, die
überhaupt eine URL enthält.

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
3. **`prepare_action(reference, target, purpose, …)`** oder
   **`prepare_action(references, target, purpose, …)`** — verbindet genau eine Referenz (alte,
   weiterhin unterstützte Form) oder eine geordnete Liste opaker Referenzen mit Ziel und Zweck.
   Es wird nichts übertragen; die vollständige Anhangsmenge wartet gemeinsam auf die lokale
   Freigabe.
4. **Lokale Freigabe** — die Oberfläche zeigt alle Ressourcen und Quellen, Ziel, Zweck, die
   geplante Aktion, die genauen ausgehenden Daten samt SHA-256, die Bewertungen des lokalen Modells
   und offene Punkte. Möglich sind: freigeben, ablehnen, bei Einzelaktionen eine andere Ressource
   wählen, verwerfen.
5. **`get_action_status(action_id)`** — `awaiting_local_approval`, `selection_required`,
   `executing`, `completed`, `rejected`, `failed` oder `expired`.
6. **`await_action_decision(action_id, [timeout_seconds])`** — dasselbe Statusobjekt, aber erst
   wenn die Aktion endgültig ist.
7. **`summarize_resource(reference, purpose, [focus])`** — statt zu versenden: das lokale Modell
   schreibt eine geschwärzte Zusammenfassung. Auch das ergibt nur eine Aktion, die wartet.
8. **`get_summary(action_id)`** — holt den Text ab, sobald der Nutzer ihn freigegeben hat.

Bei Mehrdeutigkeit liefert `find_resource` eine Auswahlreferenz. Der Nutzer entscheidet lokal;
Hermes fragt anschließend mit `pending_selection` erneut an.

### Prüfung des Dokumentinhalts

Eine Bewertung, die nur den Titel gesehen hat, klingt genauso überzeugt wie eine, die das Dokument
gelesen hat — beide kommen als flüssiges Deutsch mit einer Konfidenz daneben zurück. Deshalb
behandelt das Gateway die Textlage als eigene, festgehaltene Tatsache:

- **Kandidaten werden vollständig geladen.** Das Suchwerkzeug des Paperless-MCP-Servers ist eine
  Listenabfrage und antwortet ungleichmäßig: mancher Treffer bringt seinen OCR-Text mit, der nächste
  keinen, und Schlagwörter kommen teils als blanke Kennungen. Das Gateway liest jeden Kandidaten
  über das `get`-Werkzeug nach und löst Schlagwort-Kennungen gegen die Schlagwortliste auf.
  Kennungen, die sich nicht auflösen lassen, entfallen — eine Zahl ist kein Merkmal.
- **Vor `prepare_action` wird für jede Referenz der Volltext gelesen** und einer eigenen Bewertung
  mitgegeben, nicht nur der kurze Suchauszug. Der Prompt nennt ausdrücklich, wie viele Zeichen
  vorliegen, und ob es sich um den Volltext, nur einen Auszug oder gar nichts handelt.
- **Das Modell meldet zurück, ob es geprüft hat** (`contentChecked`). Lag kein Text vor, verwirft das
  Gateway diese Angabe, setzt `purposeMatch` auf false und empfiehlt die manuelle Prüfung: eine
  behauptete Prüfung von etwas Unlesbarem ist keine Prüfung.
- **Die Grundlage steht in der Freigabeansicht**, oberhalb der Modellbegründung, zusammen mit dem
  Inhaltsauszug aus der Quelle. Alles unterhalb von „Dokumenttext gelesen und bestätigt“ ist als
  solches markiert.
- **Eine unvollständige Antwort kostet nicht die ganze Aktion.** Das Gateway verlangt die Antwort
  als JSON-Schema (`format`), sodass ein fehlendes Feld gar nicht erst entstehen kann. Kommt es
  trotzdem dazu, gilt die ausgelassene Angabe als *nicht bestätigt* — `purposeMatch` false,
  manuelle Prüfung empfohlen — und die offenen Punkte sagen ausdrücklich, dass das die Vorsicht des
  Gateways ist und keine Aussage des Modells. Vorher verwarf eine fehlende Angabe die gesamte
  vorbereitete Aktion samt aller bereits bewerteten Anhänge.

Ein Scan ohne Texterkennung wird deswegen nicht abgelehnt — versandt wird die Datei selbst, und der
Nutzer kann sie öffnen. Was das Gateway schuldet, ist keine Verweigerung, sondern eine
wahrheitsgemäße Auskunft darüber, was tatsächlich geprüft wurde.

### Betreff und Nachrichtentext

`subject` und `body` sind optional und werden, wenn gesetzt, **wörtlich** versandt — ohne Fußzeile,
ohne Herkunftshinweis, ohne Umformulierung. Das ist die Voraussetzung dafür, dass über dieses
Gateway eine Nachricht hinausgehen kann, die beim Empfänger wie gewöhnliche Post aussieht, etwa
eine Bewerbung. Ohne die beiden Felder stellt das Gateway wie bisher einen neutralen Text aus
Bezeichnung, Zweck und Zeitpunkt zusammen; `note` wird nur in diesem Fall als ausdrücklich
zugeschriebener Agentenhinweis angehängt.

Die Kontrolle liegt nicht darin, dass das Gateway den Text bearbeitet, sondern darin, dass der
Nutzer ihn vollständig liest, bevor etwas passiert: Betreff und Text sind in der Freigabeansicht
und im Bestätigungsdialog als *vom Agenten verfasst* markiert, und beide sind Teil der
Freigabebindung — ein nachträglich veränderter Text lässt die Freigabe verfallen. Zeilenumbrüche
im Betreff werden entfernt, damit daraus keine zweite Kopfzeile entstehen kann.

### Rückmeldung an Hermes

`await_action_decision` blockiert, bis die Aktion endgültig ist (`completed`, `rejected`, `failed`,
`expired`), höchstens aber `timeout_seconds` (Standard 60, Obergrenze 600). Läuft das Fenster
vorher ab, kommt der aktuelle Zwischenstand zurück und der Aufruf kann wiederholt werden.

Bewusst ein Warten und kein Webhook: ein Rückruf würde bedeuten, dass ausgerechnet der Rechner mit
den privaten Dokumenten von sich aus eine Verbindung in die Cloud aufbaut. So bleibt jede Richtung
erhalten, wie sie ist — das Gateway antwortet, es ruft nicht an.

### Andere Ressource wählen

Wählt der Nutzer in der Freigabeansicht „Andere Ressource wählen“, wird die Aktion **pausiert**
(`selection_required`), nicht verworfen: Nachsehen ist keine Entscheidung. Bestätigt er danach das
Dokument, auf das die Aktion ohnehin zeigte, kehrt sie unverändert zurück — gleicher Plan, gleiche
Freigabebindung, gleicher Ablauf. Wählt er ein anderes, wird sie verworfen, weil die Bindung die
Ressource mit umfasst und ein anderes Dokument eine neue Aktion braucht. Bricht er die Auswahl ab,
bleibt alles wie es war. Die Handentscheidung des Nutzers hat danach Vorrang vor einer neuen
Modellbewertung.

## Redigierte Zusammenfassungen

Ein Cloud-Agent braucht oft inhaltlichen Kontext zu einem Dokument, um überhaupt sinnvoll helfen zu
können — und darf das Dokument trotzdem nicht sehen. `summarize_resource` löst das nicht dadurch,
dass die Grenze gelockert wird, sondern dadurch, dass ein zweiter Weg über dieselbe Grenze führt:

1. **Der Agent bittet um Kontext.** Er nennt Referenz und Zweck, optional einen `focus` („worum es
   ihm geht"). Er bittet nicht um das Dokument.
2. **Das lokale Modell redigiert.** Es liest den Volltext aus der Quelle — offline, auf diesem
   Rechner — und schreibt eine kurze Zusammenfassung, in der Namen, Anschriften, Kontaktdaten,
   Aktenzeichen und Nummern, Beträge, genaue Daten, Gesundheitsangaben und Zugangsdaten durch
   Platzhalter aus einer **geschlossenen Liste** ersetzt sind: `[REDACTED_NAME]`,
   `[REDACTED_ORG]`, `[REDACTED_ADDRESS]`, `[REDACTED_CONTACT]`, `[REDACTED_DATE]`,
   `[REDACTED_AMOUNT]`, `[REDACTED_ID]`, `[REDACTED_HEALTH]`, `[REDACTED_CREDENTIAL]`,
   `[REDACTED_OTHER]`. Geschlossen, damit das Gateway hinterher prüfen kann, dass nichts anderes in
   eckigen Klammern überlebt hat — ein erfundener Platzhalter ist meist echter Inhalt.
3. **Die Antwort an den Agenten enthält keinen Text.** Sie enthält eine Aktions-ID und
   `awaiting_local_approval` — genau wie `prepare_action`. Eine Zusammenfassung ist eine
   Übertragung, nur eben von Text statt einer Datei, also gilt Invariante 7 unverändert.
4. **Der Nutzer entscheidet.** Die Freigabeansicht zeigt den Text vollständig, rot hinterlegt,
   ungekürzt und ohne eigenen Scrollbereich; darüber, was das Modell geschwärzt haben will; und
   darüber, was eine lokale Mustersuche im fertigen Text trotzdem noch gefunden hat. Der
   Bestätigungsdialog wiederholt den Text und verlangt ein ausdrückliches „gelesen".
5. **Erst dann ist er abholbar.** `get_summary` liefert den Text ausschließlich für eine Aktion im
   Status `completed`, den nur die Freigabe herstellt.

Ein Sprachmodell, auch ein lokales, macht dabei Fehler. Der Entwurf rechnet damit statt darauf zu
hoffen: die Mustersuche ist eine zweite Meinung (E-Mail-Adressen, IBAN, Telefonnummern, Beträge,
längere Ziffernfolgen, unbekannte Platzhalter) und wird dem Nutzer gezeigt, nicht als Filter
verwendet. Die Egress-Prüfung dagegen ist hart: enthält ein Entwurf eine URL, einen Pfad oder ein
registriertes Geheimnis, wird er verworfen und gar nicht erst zur Freigabe vorgelegt.

Weiter gilt:

- **Dasselbe Bindungsprinzip wie bei E-Mails.** Der Bindungs-Hash deckt den Zusammenfassungstext
  ab; die Freigabe geht mit dem angezeigten Hash zurück, und vor der Herausgabe wird die SHA-256
  des gespeicherten Textes erneut geprüft. Was der Nutzer gelesen hat, ist was der Agent bekommt —
  oder es passiert nichts.
- **Kein Weg an der Oberfläche vorbei.** `get_summary` ist der einzige Ausgang, und er öffnet nur
  über `completed`. Eine Zusammenfassungsaktion trägt strukturell kein Ziel und keinen Empfänger:
  sie kann nicht als Versand missverstanden werden, weil ihre Form dafür kein Feld hat.
- **Dieselben Vorbedingungen wie ein Versand.** Zweckbindung der Referenz, Erreichbarkeit der
  Quelle und unveränderter Ressourcenzustand werden vorher geprüft — eine Zusammenfassung eines
  inzwischen geänderten Dokuments wäre genauso falsch wie dessen Versand.
- **Das Original bleibt liegen.** Für eine Zusammenfassung wird nur der Text gelesen, nie die
  Datei; `fetchOriginal` läuft ausschließlich für einen freigegebenen Versand.
- **Begrenzt.** Der Text ist auf 1800 Zeichen gedeckelt, damit `summarize_resource` nicht zu einem
  Weg wird, ein Dokument freigabeweise auszulesen. Wie viel Volltext das Modell sieht, steht in
  `sources[].summaryChars` (Standard 20000).

Hat eine Ressource keinen auswertbaren Text — ein Scan ohne OCR, später ein Kalendereintrag —,
lehnt das Gateway ab, statt die Metadaten zusammenzufassen und das Ergebnis eine Zusammenfassung
des Dokuments zu nennen.

## Sicherheitsinvarianten und ihre Umsetzung

| # | Invariante | Wo sie durchgesetzt wird |
| --- | --- | --- |
| 1 | Hermes hat keinen direkten Zugriff auf private Quellen | Quellen sind nur über `SourceRegistry` im Gateway-Prozess erreichbar; die MCP-Oberfläche kennt sieben abstrakte Werkzeuge |
| 2 | Interne Quellenwerkzeuge werden nicht weitergegeben | `McpSourceClient` ruft Quellwerkzeuge selbst auf; sie werden nie re-exportiert |
| 3 | Keine Rohdaten an Hermes | `core/egress.ts` baut jede Antwort feldweise nach Whitelist; der einzige Freitext ist eine lokal freigegebene Zusammenfassung, die dieselbe Prüfung passiert |
| 4 | Nur opake Referenzen | `util/ids.ts` (CSPRNG), Auflösung ausschließlich über `ReferenceStore` |
| 5 | Kennungen und Zugangsdaten bleiben lokal | `EgressGuard` prüft jede Ausgabe gegen registrierte Geheimnisse und Struktur­muster (URLs, Pfade, API-Routen) |
| 6 | Nur lokal konfigurierte Ziele | `EgressTarget.deliver()` ignoriert `recipient`, außer die Instanz ist explizit mit `allowDynamicRecipient` konfiguriert; nur dort verlangt und verwendet `prepare_action` eine Adresse, stets unverkürzt gezeigt und einzeln freigegeben |
| 7 | Jede Übertragung braucht eine lokale Freigabe | `Orchestrator.execute()` läuft ausschließlich aus `approveAction()`; `get_summary` gibt nur für `completed` einen Text heraus |
| 8 | Das lokale Modell kann nichts übertragen | der Judge liefert nur validiertes JSON; er hat keine Referenz auf ein Ziel, und sein einziger Text mit Egress-Bestimmung wartet auf eine Freigabe |
| 9 | Bei Mehrdeutigkeit kein automatisches Handeln | `ambiguous` und ein außerhalb des Bereichs liegender Kandidat führen beide zu `selection_required` |
| 10 | Kein Cloud-Fallback | `OllamaClient` hat keinen Ersatzpfad; Ausfall ergibt `local_model_unavailable` |
| 11 | Inhalte sind Daten, keine Anweisungen | `judge/prompts.ts` umschließt jeden Fremdinhalt mit einem Zufalls-Nonce; das Modell antwortet nur schemagebunden |
| 12 | Freigegebene Aktionen sind unveränderlich | Bindungs-Hash über (Referenz, Ressourcenzustand, Ziel bzw. Agent, Plan); `ActionStore` erlaubt nur Statuswechsel, Endzustände nie wieder |
| 13 | Nur notwendige Informationen an Hermes | geschlossener Katalog von Statusgründen und Hinweistexten in `EGRESS_NOTES` |
| 14 | Alles lokal nachvollziehbar | `AuditLog` als reines Anhänge-Protokoll, sichtbar im Reiter „Protokoll“ |

### Zur Bindung einer Freigabe

Eine Freigabe gilt nur für die konkret angezeigte Kombination. Technisch: die Oberfläche schickt
den angezeigten Bindungs-Hash zurück; passt er nicht mehr zum gespeicherten Datensatz, wird die
Freigabe verweigert statt auf etwas anderes angewendet. Zusätzlich wird vor der Vorbereitung und
unmittelbar vor der Ausführung die **gesamte** geordnete Ressourcenmenge geprüft. Erst wenn alle
Metadatenprüfungen abgeschlossen und alle Zustände unverändert sind, werden die freigegebenen Bytes
zusammengestellt; ein in Paperless nachträglich bearbeitetes Dokument bricht die komplette Aktion
ab, ohne dass ein Teil versandt wird.

Der Hash deckt bei einem Versand Mitgliedschaft, Reihenfolge und Zustands-Hash jeder Referenz sowie
die geordnete Anhangsliste mit Dateiname, Medientyp, Größe und SHA-256 ab. Er benennt auch, wohin
die Freigabe gilt: eine Zielkennung bei einem Versand, `cloud_agent` bei einer Zusammenfassung.
Ein gespeicherter Plan kann dadurch weder umsortiert oder ergänzt noch als die jeweils andere Art
Aktion gelesen werden.

## Mehrere Anhänge

`prepare_action` akzeptiert genau eine von zwei Eingabeformen:

```json
{
  "reference": "res_7f29a1c4b8de",
  "target": "private_mail",
  "purpose": "Bewerbung auf eine Stelle"
}
```

```json
{
  "references": ["res_7f29a1c4b8de", "res_a6d350ac92f1"],
  "target": "job_application_mail",
  "purpose": "Bewerbung auf eine Stelle",
  "recipient": "jobs@example.org",
  "subject": "Bewerbung",
  "body": "Guten Tag,\n\nanbei meine Unterlagen."
}
```

`reference` und `references` zugleich, eine leere Liste, doppelte oder nicht opak geformte
Referenzen werden abgelehnt. Jede Referenz muss für exakt denselben angegebenen Zweck geprägt,
noch gültig, erreichbar und unverändert sein. `list_targets` meldet `max_attachments` und
`max_attachment_bytes`; lokal setzen `targets[].maxAttachments` (Standard 10, höchstens 50) und
`targets[].maxAttachmentBytes` diese Obergrenzen. Das Byte-Limit gilt für die Summe der
unveränderten Originalanhänge einer Nachricht, nicht pro Datei. Dateinamen, Inhalte und einzelne
Dateigrößen verlassen dabei nicht das Gateway.

Für SMTP ist der Standard `14542294` Byte (`floor((20 MiB - 1 MiB) / 1.37)`). SMTP bewertet die
vollständige MIME-Nachricht, und base64 vergrößert binäre Anhänge zusammen mit Zeilenumbrüchen um
ungefähr 37 Prozent. Die 1-MiB-Reserve lässt Platz für Text, Header und MIME-Grenzen, damit die
vollständige Nachricht innerhalb des dokumentierten Maximums von 20 MiB bleibt. Telegram behält
seinen separaten Standard von 50 MiB.

PDFs werden nicht automatisch komprimiert oder gebündelt. Übliche PDFs enthalten bereits
komprimierte Bild- und Datenströme; ZIP spart dort oft kaum Platz, verschlechtert die
Empfängerkompatibilität und ändert das ausgelieferte Format. Eine verlustfreie, verlässlich
wirksame PDF-Optimierung bräuchte einen eigens vertrauten und konfigurierten Backend-Prozess, den
dieses Projekt nicht mitbringt. Das Gateway führt daher keine externen Programme aus und schreibt
Dokumente nicht um.

### SMTP-Limit für größere Anhangsmengen konfigurieren

Soll beispielsweise CV + SCHUFA + Vertrag als **eine** Nachricht versandt werden:

1. Die Rohgrößen der drei lokalen Dateien bzw. die in der Freigabeansicht gezeigte Gesamtsumme
   bestimmen. Diese Werte bleiben lokal.
2. Beim SMTP-Anbieter das Limit der vollständigen MIME-Nachricht prüfen, nicht nur ein eventuell
   beworbenes „Anhangslimit“. Für ein Limit `M` sollte der konfigurierte Rohdatenwert höchstens
   `floor((M - 1 MiB) / 1.37)` sein; das 1 MiB ist Reserve für Text, Header und MIME-Grenzen.
3. Nur am betreffenden SMTP-Ziel `maxAttachmentBytes` auf diesen geprüften Rohdatenwert setzen.
   Beispiel für ein bestätigtes 50-MiB-Nachrichtenlimit:

   ```json
   "maxAttachmentBytes": 37503813
   ```

4. Gateway neu starten und mit `list_targets` kontrollieren, dass
   `max_attachment_bytes` den Wert meldet. Danach eine neue Aktion vorbereiten; bereits
   abgelehnte Aktionen werden nicht nachträglich verändert.

Der Wert hebt nur die lokale Obergrenze an. Die strikte Summenprüfung vor der Freigabe und die
zweite Prüfung unmittelbar vor dem SMTP-Versand bleiben aktiv. Ist die Summe größer als der vom
Anbieter sicher unterstützte Rohdatenwert, bleibt die ehrliche Alternative: Dateien außerhalb
dieses Gateways verlustfrei verkleinern oder auf mehrere Nachrichten verteilen.

Die Freigabeoberfläche zeigt jede lokale Ressource mit Quelle, Kennung, Link, Inhaltsgrundlage und
eigener Modellbewertung sowie jeden ausgehenden Anhang mit Dateiname, Medientyp, Größe und SHA-256.
Der Bestätigungsdialog wiederholt die vollständige Ressourcen- und Anhangsmenge. Erst ein Klick auf
diese eine vollständige Aktion erlaubt den Versand; eine Einzelressource einer Mehrfachaktion lässt
sich nicht nachträglich austauschen.

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
wissen, woher eine Ressource stammt. Die Schnittstelle kennt bewusst kein Schreiben. `fetchText`
ist optional: eine Quelle ohne auswertbaren Text kann alles außer `summarize_resource`.

**Neues Ziel**: `EgressTarget` implementieren und in `targets/registry.ts` ergänzen. Der Empfänger
gehört in die Konfiguration und in die Instanz; die Signatur von `deliver` trägt zwar ein optionales
`recipient`-Feld, aber ein Ziel, das nicht ausdrücklich für einen dynamischen Empfänger gebaut ist,
muss es ignorieren und seine eigene, feste Adresse verwenden.

## Datenhaltung

Alles unter `dataDir` (Standard `./data`), bewusst ohne Datenbank und ohne native Abhängigkeiten:

| Datei | Inhalt |
| --- | --- |
| `references.jsonl` | Zuordnung opake Referenz → echte Ressource |
| `actions.jsonl` | vorbereitete und entschiedene Aktionen, samt Nachrichtentext bzw. Zusammenfassung |
| `selections.jsonl` | offene und entschiedene lokale Auswahlen |
| `audit.jsonl` | Entscheidungsprotokoll, wird nie verdichtet oder gelöscht |
| `telegram-approval.json` | AES-256-GCM-Ciphertext der portalverwalteten Telegram-Freigabekonfiguration, Modus 0600 |

Dieses Verzeichnis enthält die Zuordnung zwischen Referenzen und privaten Dokumenten und darf den
Rechner nicht verlassen. `.gitignore` schließt es aus. Das Protokoll führt von beiden Textsorten
nur Prüfsumme und Länge: es wird nie verdichtet und nie gelöscht, und eine zweite Kopie privater
Inhalte mit dieser Aufbewahrung wäre der falsche Ort dafür.

Der Ollama-Chat läuft als NDJSON-Stream. Das Gateway sammelt lokal ausschließlich
`message.content`, bis ein terminales `done: true` eintrifft. `localModel.idleTimeoutMs` ist kein
Gesamtlimit für die Inferenz: Nur eine Phase ohne Verbindungsaufbau, Header oder neue Bytes wird
nach dem konfigurierten Zeitraum abgebrochen; jeder Fortschritt setzt den Wächter zurück.
Bei einem Upgrade muss das frühere `localModel.requestTimeoutMs` in der Konfiguration durch
`localModel.idleTimeoutMs` ersetzt werden; der alte Schlüssel bricht den Start mit einem
Migrationshinweis ab, statt unbemerkt verworfen oder als Gesamtlimit weiterverwendet zu werden.
Fehlerhafte Frames, fehlendes `done`, leerer Inhalt oder ein abrupter Stream-Abbruch gelten als
Ausfall des lokalen Modells. Dieses interne Streaming ändert die synchrone MCP-Oberfläche nicht
und sendet keine Teilfortschritte an Hermes.

### Kontextfenster richtig bemessen

`localModel.numCtx` muss den Prompt **und** die Antwort fassen. Ollama lehnt eine zu große Anfrage
nicht ab, sondern verwirft die ältesten Tokens, sobald das Fenster voll ist — das Modell verliert
also mitten in der Arbeit seine eigenen Anweisungen und antwortet mit unvollständigem JSON oder
mit gar nichts. Beides erreicht Hermes als `local_model_unavailable` und zeigt damit auf den
Endpunkt statt auf die beiden Zahlen, die es verursacht haben.

Drei Stellen halten das jetzt fest:

- `localModel.numPredict` ≥ `localModel.numCtx` bricht den Start ab. Das Ausgabebudget wird aus
  demselben Fenster reserviert; ist es so groß wie das Fenster, bleibt für den Prompt nichts übrig.
- Beim Start schätzt das Gateway den größten Prompt, den es bauen kann — `maxCandidates` gekürzte
  Auszüge für die Auswahl, `summaryChars` Zeichen Volltext für Bewertung und Zusammenfassung — und
  warnt mit konkreten Zahlen, wenn er zusammen mit `numPredict` nicht ins Fenster passt.
- Bricht das Laufzeitsystem eine Antwort am Token-Budget ab (`done_reason: length`) oder liefert
  ein Modell mit `think: true` nur Überlegung und keine Antwort, benennt die Fehlermeldung genau
  das, statt von ungültigem JSON zu sprechen. Der Wortlaut der Überlegung bleibt lokal; nur ihre
  Länge wird gemeldet.

Für die Auswahl wird der Inhaltsauszug je Kandidat auf 800 Zeichen gekappt und im Prompt als
Anfang gekennzeichnet: `find_resource` legt `maxCandidates` Auszüge in ein Fenster, und jedes
dieser Tokens wird vor dem ersten Antwortzeichen bezahlt. Die Inhaltsprüfung in `prepare_action`
sieht weiterhin den Volltext — sie beurteilt ein Dokument, keine Liste.

`think: true` kostet Fenster und Zeit: Die Überlegung zählt gegen dasselbe Budget wie die Antwort.
Auf reiner CPU-Inferenz ist das der Unterschied zwischen einer Suche, die antwortet, und einer, die
das Zeitlimit des Aufrufers überlebt.

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
  nicht verwendet — der Approval-Server läuft auf `node:http`, und der MCP-Endpunkt geht nicht
  über den betroffenen Pfad. Ein Fix erfordert einen Downgrade des SDK und wurde nicht gemacht.
- Die Originaldaten einer vorbereiteten Aktion liegen bis zur Entscheidung im Speicher, damit die
  Freigabeansicht Größe und Prüfsumme aller tatsächlichen Anhänge nennen kann. Nach einem Neustart
  ist dieser Zwischenspeicher leer; die vollständige Menge wird dann bei der Freigabe erneut gelesen
  und jeder Anhang gegen Metadaten, Größe und freigegebene Prüfsumme verglichen.
- Ein Ziel ohne Anhangsunterstützung ist im Modell vorgesehen (`supportsAttachments`), aber beide
  ausgelieferten Ziele können Anhänge, daher gibt es dafür noch keinen Nur-Text-Pfad.
- Die Volltextsuche von Paperless zerlegt deutsche Komposita nicht. `find_resource` mit
  „Abiturzeugnis" antwortet `not_found`, während „Abitur" dieselbe Ablage mit mehreren Treffern
  beantwortet. Bei einer Fehlanzeige lohnt zuerst der kürzere Wortstamm, bevor Quelle oder Modell
  verdächtigt werden. Im lokalen Log ist der Fall daran zu erkennen, dass zu der Suche gar keine
  Modellinferenz steht: ohne Kandidaten wird das lokale Modell nicht befragt.

## Nicht Bestandteil

Einrichtung oder Änderung von Hermes, Ollama, Paperless, des Paperless-MCP-Servers oder von Baikal;
Netzwerk- und Deployment-Konfiguration; Empfänger außerhalb eines dafür ausdrücklich mit
`allowDynamicRecipient` konfigurierten Ziels; Mehrbenutzerbetrieb; automatische Freigaben;
Änderungen oder Löschungen in privaten Quellen; die DAV-Anbindung selbst.
