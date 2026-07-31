# Architektur: Dokumenttransformation im Gateway

Plan für die Schicht, die Verkleinern (US-001) und Schwärzen (Stretch) gemeinsam trägt.

**Annahme, auf der alles steht:** Einzelnutzer, alles lokal, Dokumente aus der eigenen Quelle.
Prozessisolierung, Sandboxing und Parser-Härtung sind deshalb **nicht** Teil dieses Entwurfs.
Was an Robustheit bleibt — Zeitgrenzen, Aufräumen, begrenztes Lesen — steht hier aus
Betriebsgründen, nicht aus Sicherheitsgründen.

---

## 1. Was hier entsteht

Nicht „PDF-Komprimierung". Das Gateway bekommt eine **Transformationsschicht**: es hört auf, Bytes
nur weiterzureichen, und schreibt sie um. Zwei Anwendungsfälle sind heute konkret, weitere liegen
auf der Hand — Seitenauswahl, Formatkonversion, Wasserzeichen, Neu-OCR, Passwortentfernung.

Die Frage ist deshalb nicht „wie komprimiere ich ein PDF", sondern: **welche Form haben diese
Operationen gemeinsam, und wo unterscheiden sie sich wirklich?**

Die Antwort bestimmt zwei Dinge sofort — den Ablauf einer Aktion und die Technologiewahl. Beide
sind teuer zu ändern, wenn man sie erst beim zweiten Anwendungsfall stellt.

---

## 2. Das gemeinsame Abstraktum

```ts
/** Ein Dokument auf dem Weg nach draußen. Bytes plus das, was man ohne Parsen weiß. */
interface Doc {
    bytes: Uint8Array;
    mimeType: string;
    filename: string;
}

/** Eine Transformation. Zustandslos, parametrisiert, prüfbar. */
interface Transform<S> {
    id: string;
    accepts(doc: Doc): boolean;
    apply(doc: Doc, spec: S, budget: Budget): Promise<Doc>;
    /** Hat die Transformation getan, was die Spec sagt? Siehe §6. */
    verify(before: Doc, after: Doc, spec: S): Promise<Verification>;
}

/** Woher die Parameter kommen. Der eigentliche Unterschied, siehe §3. */
interface SpecProvider<S> {
    derive(doc: Doc, ctx: PreparationContext): Promise<S | 'no-op' | 'needs-input'>;
}

/** Was mit einem Anhang geschehen ist — geordnet, als Daten. */
type TransformChain = Array<{ transformId: string; spec: unknown }>;
```

Drei Eigenschaften machen das tragfähig:

- **`apply` ist zustandslos.** `(Doc, Spec) → Doc`. Kein Zugriff auf Store, Ziel, Referenz oder
  Audit. Isoliert testbar, ohne das halbe Gateway hochzufahren.
- **Die Kette ist eine Datenstruktur, kein Kontrollfluss.** Sie ist protokollierbar, anzeigbar,
  Teil des Plans — und man kann Regeln über sie formulieren, ohne die Ausführung zu kennen.
- **Spec und Transform sind getrennt.** Das ist der Angelpunkt des ganzen Entwurfs.

---

## 3. Die drei Achsen — hier liegt der Unterschied, nicht im Transform

Verkleinern und Schwärzen sehen aus wie zwei Features. Als `Transform` sind sie dieselbe Form. Sie
unterscheiden sich in dem, was *um* den Transform herum passiert:

| | **Verkleinern** | **Schwärzen** |
| --- | --- | --- |
| **Spec-Herkunft** | eine Messung (`Summe > Limit?`) | Mensch, Regel oder lokales Modell |
| **Braucht die Spec eine Freigabe?** | nein — sie ist eine Folge, keine Wahl | **ja** — die Spec *ist* die Entscheidung |
| **Ablauf** | geschlossen, ein Durchlauf | interaktiv, Schleife aus Vorschau und Auswahl |
| **Verifikation** | Größe. Trivial. | **der Kern des Features** |
| **Schlimmster Fehler** | Datei bleibt zu groß — sichtbar, harmlos | Inhalt *scheint* entfernt und ist es nicht |

Die letzte Zeile ist der Grund, warum Schwärzen kein „Verkleinern mit anderen Parametern" ist. Ein
gescheitertes Verkleinern meldet sich. Eine gescheiterte Schwärzung sieht aus wie ein Erfolg.

Daraus folgt eine Entwurfsregel, die sich durch alles zieht:

> **Automatisch ist, was aus einer Messung folgt. Freigabepflichtig ist, was eine Wahl war.**

Verkleinern folgt aus einer Messung — kein Gate, wie in US-001 festgelegt. Schwärzen ist eine Wahl —
die Auswahl der Regionen muss der Mensch gesehen und bestätigt haben, sonst ist das Feature sinnlos.

---

## 4. Warum das die Ablaufarchitektur bestimmt

```
Verkleinern:   fetch ──► transform ──► plan ──► Freigabe ──► deliver
                                                       (geschlossen, ein Durchlauf)

Schwärzen:     fetch ──► render ──► ┌──────────────────┐
                                    │ auswählen ⇄ Vorschau │  ← dauert, hat Zustand
                                    └────────┬─────────┘
                                             ▼
                              transform ──► verify ──► plan ──► Freigabe ──► deliver
```

Die interaktive Schleife braucht eine Vorbereitungsphase, die **Zeit braucht und Zustand hält**.
Heute gibt es die nicht: `prepare_action` ist ein synchroner Aufruf, der fertig zurückkommt.

Genau denselben Umbau verlangt aber auch das Verkleinern — aus einem ganz anderen Grund: das
MCP-SDK setzt clientseitig 60 Sekunden, und Abholen + Ghostscript + lokale Bewertung können das
reißen. Dann sähe Hermes einen Transportfehler statt eines Statuscodes.

**Ein Umbau, zwei Gewinne.** Das ist der Hebel dieses Plans:

```
prepare_action → 202, Aktion in `preparing`, sofortige Rückgabe
                     │
                     ▼   Worker
        resolve → fetch → [SpecProvider] → transform → verify → judge
                                 │
                                 ├─ 'needs-input' → Status `needs_input`,
                                 │                  Oberfläche fragt, Worker macht weiter
                                 └─ fertig        → awaiting_local_approval
```

Hermes wartet mit dem bereits vorhandenen `await_action_decision` — dieselbe Form, die es für die
menschliche Freigabe ohnehin benutzt. Kein neues Protokollkonzept, zwei neue Status.

Wer diese Phase jetzt baut, bekommt Schwärzen später als **Inkrement**. Wer sie später baut, macht
aus dem Stretch Goal einen Umbau des Aktionsmodells.

---

## 5. Technologiewahl — das Stretch Goal entscheidet sie jetzt

Der praktisch folgenreichste Punkt des ganzen Dokuments — und er hängt **nicht** am Stretch Goal.

**Erstes Argument, unabhängig vom Schwärzen: Ghostscript allein holt bei Scans nicht das Meiste
heraus.** Bei bitonalen Scans liegt der Faktor 5–10 in JBIG2, und den erschließt `jbig2enc`, nicht
`pdfwrite`. Dazu `pngquant` für palettierte Bilder. Genau diese Kette ist `ocrmypdf --optimize 2|3`
— ein gepflegtes Python-Werkzeug, das für diesen Fall gebaut wurde. Wer nur `gs` aufruft, lässt bei
der Dateigattung, um die es hier geht, Ersparnis liegen. Das gilt auch dann, wenn Schwärzen nie
kommt.

**Zweites Argument, das erste verstärkend: Schwärzen braucht vier Dinge, die Ghostscript nicht
kann:**

1. Seiten als Bild rendern (Vorschau, Auswahlfläche)
2. Text **mit Koordinaten** extrahieren (Suche nach Begriffen, Trefferrechtecke)
3. Inhalt **physisch entfernen**, nicht überdecken
4. Prüfen, dass er weg ist

Das ist PyMuPDF. `Page.add_redact_annot(rect)` markiert, `Page.apply_redactions()` entfernt — laut
Dokumentation wird Text „**physically** removed from the page", mit getrennter Steuerung für Text
(`PDF_REDACT_TEXT_REMOVE`), Bilder (`PDF_REDACT_IMAGE_REMOVE` vs. Pixel schwärzen) und
Vektorgrafik. Dazu `get_pixmap()` fürs Rendern und `search_for()` / `get_text("words")` für
Koordinaten.

**Also: der Transformer ist von Anfang an ein Python-Dienst**, kein Node-Wrapper um `gs`.

```
document-transformer  (Python, lokal)
   PyMuPDF     → rendern, suchen, schwärzen, prüfen, Seitenzahl
   OCRmyPDF    → Verkleinern inkl. jbig2enc/pngquant (bei Scans der große Hebel)
   Ghostscript → Verkleinern über Stufenleiter, Rückfall

   Schnittstelle: lokaler HTTP-Dienst (Loopback) oder Unix-Socket
                  JSON für Specs, Bytes für Dokumente
                  POST /transform · POST /render · POST /extract · GET /health
```

Kein MCP dazwischen: MCP ist die Modell-Werkzeug-Grenze, nicht der interne Datenpfad. Hier fließen
Bytes zwischen zwei Komponenten desselben Systems.

Das ist die eine Entscheidung, die sich später teuer rächt. Baut man erst den Node-`gs`-Wrapper und
kommt das Schwärzen, baut man den Transformer zweimal — und hat währenddessen zwei Werkzeugketten
mit unterschiedlichem Verhalten auf denselben Dateien.

---

## 6. Verifikation ist asymmetrisch

**Verkleinern:** Größe prüfen. Mehr nicht. Keine Seitenzahl-, Text- oder Bildvergleiche — so in
US-001 festgelegt und hier nicht aufgeweicht.

**Schwärzen:** die Verifikation *ist* das Feature. Das schwarze Rechteck über weiterhin
extrahierbarem Text ist der bekannteste Fehlermodus der Domäne — er hat Gerichtsakten und
Behördendokumente geleert, und er sieht auf dem Bildschirm perfekt aus.

Ein Dokument hat aber **zwei Ebenen**, und eine Prüfung nur auf der Textebene gibt bei genau der
Dateigattung, um die es hier geht, ein falsches Grün:

```python
# (1) Textebene — greift bei digitalen PDFs und OCR-Scans.
for term in spec.terms:
    assert not any(page.search_for(term) for page in after)

# (2) Bildebene — greift bei Scans, wo der Inhalt Pixel ist.
#     search_for() findet dort vorher wie nachher nichts; die Zusicherung
#     oben wäre trivial erfüllt, auch wenn nichts entfernt wurde.
for rect in spec.regions:
    assert render(before, page, rect) != render(after, page, rect)
```

Daraus folgt für die Ausführung: `apply_redactions` muss mit `PDF_REDACT_TEXT_REMOVE` **und**
`PDF_REDACT_IMAGE_REMOVE` bzw. `PDF_REDACT_IMAGE_PIXELS` laufen. Ein OCR-Scan trägt beide Ebenen —
geschwärzt werden muss auf beiden, geprüft ebenso.

Bei koordinatenbasierter Auswahl tritt an die Stelle der Begriffssuche: Text im Rechteck vorher
extrahieren, nachher erneut extrahieren, Schnittmenge muss leer sein — plus der Pixelvergleich
oben.

Schlägt eine der Prüfungen fehl, wird die Transformation verworfen — nicht gewarnt.

---

## 7. Die Kette wandert in den Plan

```ts
interface PlannedAttachment {
    filename: string;
    mimeType: string;
    byteSize: number;
    sha256: string;
    /** Nur gesetzt, wenn überhaupt transformiert wurde. */
    chain?: TransformChain;
}
```

Damit ist die Kette Teil dessen, was freigegeben wird, steht im Protokoll und lässt sich anzeigen —
„verkleinert auf Stufe *ebook*, 3 Regionen geschwärzt" statt eines Flags.

**Feste Reihenfolge: schwärzen vor verkleinern.** Umgekehrt würde auf einer bereits
verschlechterten Darstellung geschwärzt, und wenn die Verkleinerung rastert, stimmen die
Koordinaten nicht mehr. Die Reihenfolge ist eine Eigenschaft der Pipeline, keine Option.

---

## 8. Spec-Herkunft als eigene Abstraktion

Die vier Provider, die absehbar entstehen:

| Provider | Liefert | Status |
| --- | --- | --- |
| `SizeBudgetProvider` | Stufe der Verkleinerungsleiter | US-001 |
| `ManualRegionProvider` | Rechtecke aus der Oberfläche | Stretch |
| `PatternProvider` | Trefferrechtecke aus Regeln (IBAN, Adresse, Geburtsdatum) | Stretch |
| `JudgeProvider` | Vorschläge des lokalen Modells, vom Menschen bestätigt | Stretch² |

Der letzte ist näher, als er klingt: der Judge redigiert für `summarize_resource` bereits Inhalte
entlang von `REDACTION_PLACEHOLDERS`. Schwärzen wäre dieselbe Fähigkeit, angewandt auf Koordinaten
statt auf Text — Modell schlägt vor, Mensch bestätigt, Pipeline führt aus, Verifikation prüft.

Wichtig bleibt die Regel aus §3: ein Provider darf eine Spec *vorschlagen*; freigegeben wird sie
vom Menschen, sobald sie eine Wahl war.

---

## 9. Stufenplan

| Stufe | Inhalt | Ergebnis |
| --- | --- | --- |
| **S1** | Transformer-Dienst in Python, `/transform` + `/health`, Verkleinerungsleiter, Golden-Korpus aus echten PDF-Typen | Verkleinern läuft, ohne Änderung am Aktionsmodell |
| **S2** | Asynchrone Vorbereitung: Status `preparing`, Worker, `await_action_decision` | 60-s-Problem gelöst, Voraussetzung für S4 geschaffen |
| **S3** | `TransformChain` im Plan, Anzeige in der Freigabeansicht, Audit-Ereignis | Transformationen sind nachvollziehbar statt implizit |
| **S4** *(Stretch)* | Schwärzen: `/render`, Auswahl-UI, `apply_redactions`, Verifikation, Status `needs_input` | Schwärzen als Inkrement, kein Umbau |
| **S5** *(Stretch²)* | `PatternProvider`, `JudgeProvider` | Vorschläge statt reiner Handarbeit |

S1 und S2 sind unabhängig voneinander und können parallel laufen. S3 ist klein und macht S4 erst
sinnvoll. S4 setzt S2 und S3 voraus.

---

## 10. Was ich nicht bauen würde

| | Grund |
| --- | --- |
| **In-Prozess-PDF-Bibliothek in Node** | Bei Scans praktisch keine Ersparnis, und für Schwärzen fehlt das Werkzeug ganz. Man landet doch bei Python. |
| **Transformer als MCP-Server** | Schichtverwechslung. MCP ist die Modell-Werkzeug-Grenze, nicht der interne Datenpfad. |
| **Schwärzen durch Rastern der ganzen Seite** | Entfernt zuverlässig, zerstört aber Textebene und Dateigröße. Als Rückfall für Seiten, an denen `apply_redactions` scheitert, vertretbar — nicht als Normalweg. |
| **Schwärzung ohne Verifikation** | Gefährlicher als kein Feature. Siehe §6. |
| **Transformationen ohne Kette im Plan** | Man weiß danach nicht mehr, was der Empfänger bekommen hat. |
| **Aufteilung auf mehrere Nachrichten** | Legitime Fähigkeit, aber eine andere — bricht „eine Freigabe = eine gezeigte Sache". Eigene Story. |

---

## 11. Offene Entscheidungen

1. **Python-Dienst als Betriebsvoraussetzung** — das Gateway ist danach nicht mehr „nur ein
   Node-Prozess". Als Container oder als venv + systemd-Unit? Container ist reproduzierbarer,
   venv ist leichter.
2. **Wie weit geht S2?** Der asynchrone Vorbereitungsstatus berührt das Aktionsmodell. Fällt das
   Stretch Goal weg, bleibt er die Antwort auf das 60-s-Problem — dann genügt womöglich ein enges
   Zeitbudget, und S2 kann warten. Die Technologiewahl aus §5 hängt **nicht** an dieser Frage: sie
   steht schon wegen `jbig2enc` fest.
3. **Messung vor S1** — ob Verkleinern beim echten Material überhaupt genug bringt, steht als
   offener Punkt 3 in `docs/stories/US-001-anhang-komprimierung.md`. Ergibt die Probe zu wenig,
   verschiebt sich das Gewicht komplett auf S4: dann ist Schwärzen der eigentliche Wert und
   Verkleinern der Nebeneffekt.
