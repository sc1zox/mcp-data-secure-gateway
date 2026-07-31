# US-001 — Zu große PDF- und JPEG-Anhänge automatisch verkleinern

|                  |                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------- |
| **Status**       | Umsetzungsbereit nach Kalibrierung der Qualitätsprofile                                   |
| **Angelegt**     | 2026-07-30                                                                                |
| **Überarbeitet** | 2026-07-31                                                                                |
| **Geltung**      | Maßgeblich bis zur Umsetzung, danach durch Produkt- und Architekturdokumentation abgelöst |
| **Betrifft**     | Attachment-Verarbeitung, Aktionsausführung, Konfiguration, Audit und Egress-Targets       |

---

## User Story

> **Als** Nutzer des Gateways
> **möchte ich**, dass zu große PDF- und JPEG-Anhänge vor dem Versand automatisch verkleinert werden,
> **damit** ich Dokumente versenden kann, ohne sie außerhalb des Gateways manuell komprimieren oder bearbeiten zu müssen.

---

## Ausgangssituation

Ein Versand kann derzeit scheitern, wenn die Summe der Anhänge das Größenlimit des gewählten Versandziels überschreitet.

Insbesondere folgende Dateien verursachen häufig unnötig große Anhänge:

* gescanned PDFs,
* PDFs mit hochauflösenden Bildern,
* Zeugnis- und Bewerbungsunterlagen,
* Smartphone-Fotos im JPEG-Format.

Diese Dateien können häufig deutlich verkleinert werden, ohne dass ihre praktische Verwendbarkeit verloren geht.

Das Gateway soll deshalb PDF- und JPEG-Anhänge bei Bedarf lokal optimieren.

---

# Fachlicher Umfang

Unterstützt werden:

```text
application/pdf
image/jpeg
```

Andere Dateiformate werden nicht verändert.

Sie dürfen weiterhin zusammen mit PDF- und JPEG-Dateien versendet werden, sofern die finale Gesamtgröße das Limit des Ziels nicht überschreitet.

Nicht Bestandteil dieser Story sind:

* WebDAV,
* ZIP-Bündelung,
* Aufteilung auf mehrere Nachrichten,
* PNG- oder TIFF-Optimierung,
* Office-Dokumente,
* OCR,
* Schwärzung,
* Inhaltsanalyse durch ein Sprachmodell,
* Konvertierung in andere Dateiformate.

---

# Grundentscheidung

## Optimierung nach der Freigabe

Die Kompression findet nach der Freigabe und unmittelbar vor dem Transport statt.

```text
Aktion vorbereiten
    ↓
Originalanhänge und Versanddaten anzeigen
    ↓
Nutzer gibt die Aktion frei
    ↓
Originalanhänge materialisieren
    ↓
Anhänge bei Bedarf optimieren
    ↓
finale Größe und Gültigkeit prüfen
    ↓
versenden
```

Die Optimierung erhält kein eigenes zusätzliches Freigabe-Gate.

Der Nutzer gibt mit der Aktion gleichzeitig frei, dass unterstützte Anhänge gemäß der für das Ziel konfigurierten Optimierungspolicy verändert werden dürfen.

## Keine Byte-Gleichheit als Anforderung

Die erzeugten Dateien müssen nicht bei jedem Lauf byte-identisch sein.

Insbesondere Ghostscript kann bei identischer Eingabe intern unterschiedliche Metadaten, Kennungen oder Zeitwerte erzeugen.

Für diese Story gilt deshalb:

```text
Gleiche Eingabe und gleiche Konfiguration
→ gleiche fachliche Stufenentscheidung

Gleiche Eingabe und gleiche Konfiguration
→ nicht zwingend identische Ausgabebytes
```

Die konkrete SHA-256-Prüfsumme des Derivats ist kein Bestandteil der vorherigen Freigabe.

Da die Transformation vollständig lokal innerhalb des kontrollierten Gateways erfolgt, wird keine Reproduzierbarkeit der Ausgabebytes verlangt.

Die tatsächliche Prüfsumme der versendeten Datei wird jedoch nach der Transformation berechnet und im Audit protokolliert.

---

# Freigabevertrag

Die Freigabe bindet:

* Versandziel,
* Empfänger,
* Betreff und Nachrichtentext,
* ausgewählte Originalressourcen,
* ursprüngliche Dateinamen,
* MIME-Typen,
* Hashes der Originaldateien,
* maximales Versandbudget,
* erlaubte Optimierungsformate,
* maximal erlaubtes Qualitätsprofil,
* Version der Transformationspolicy.

Die Freigabe bindet nicht:

* die konkrete Größe des späteren Derivats,
* dessen SHA-256-Prüfsumme,
* interne PDF-Metadaten,
* die exakte Byte-Repräsentation der optimierten Datei.

Nach der Freigabe darf das Gateway ausschließlich Transformationen ausführen, die durch die gebundene Policy erlaubt sind.

Beispiel:

```text
PDF:  erlaubt bis Profil balanced
JPEG: erlaubt bis Profil compact
```

Das Gateway darf dann kein aggressiveres PDF-Profil verwenden als freigegeben.

---

# Architektur

## Attachment Optimization Pipeline

Die Optimierung wird als eigenständige Anwendungskomponente umgesetzt.

```text
ActionExecutor
    │
    ├── Originalanhänge materialisieren
    ├── ursprüngliche Integrität prüfen
    ├── Zielbudget bestimmen
    │
    └── AttachmentOptimizationPipeline
            ├── SourceGuard
            ├── FormatPreflight
            ├── BudgetEvaluator
            ├── CandidatePlanner
            ├── PdfOptimizer
            ├── JpegOptimizer
            └── ResultValidator
                    │
                    ▼
              EgressTarget
```

Die Pipeline ist unabhängig von SMTP oder Telegram.

Das Versandziel liefert lediglich:

* die maximal erlaubte Gesamtgröße,
* die für dieses Ziel aktivierte Optimierungspolicy.

## Verantwortlichkeiten

### ActionExecutor

Der `ActionExecutor`:

1. materialisiert die Originalanhänge,
2. verifiziert ihre ursprünglichen Identitäten,
3. ruft die Optimierungspipeline auf,
4. übergibt ausschließlich das finale Ergebnis an das Target,
5. protokolliert die tatsächlich versendeten Anhänge.

Er enthält keine Ghostscript-, qpdf- oder Sharp-spezifische Logik.

### AttachmentOptimizationPipeline

Die Pipeline:

1. prüft Eingaben und Verarbeitungslimits,
2. ermittelt die Gesamtgröße,
3. erkennt PDF- und JPEG-Dateien,
4. führt erforderliche Preflight-Prüfungen durch,
5. erzeugt Optimierungskandidaten,
6. validiert Kandidaten,
7. ersetzt nur sinnvoll kleinere Dateien,
8. beendet die Verarbeitung, sobald das Zielbudget erreicht ist.

### Egress-Target

Das Target:

* führt keine Kompression durch,
* erhält nur finale Anhänge,
* prüft die tatsächliche Gesamtgröße erneut,
* übernimmt anschließend den Transport.

---

# Werkzeugkette

## PDF

Für PDFs wird folgende Werkzeugkette verwendet:

```text
qpdf
    → Preflight und Validierung
    → optionale strukturelle Optimierung

Ghostscript
    → eigentliche bildbasierte Verkleinerung
```

### qpdf

qpdf wird eingesetzt für:

* Prüfung, ob die Datei syntaktisch als PDF verarbeitet werden kann,
* Erkennung verschlüsselter PDFs,
* Ermittlung struktureller Eigenschaften,
* Validierung erzeugter Derivate,
* optionales strukturelles Neuschreiben.

Die strukturelle Optimierung wird nur als Kandidat verwendet, wenn sie die Datei tatsächlich verkleinert.

Ghostscript-Kandidaten werden immer direkt aus dem Original erzeugt und nicht aus einem zuvor durch qpdf veränderten Kandidaten.

```text
Original → qpdf structural
Original → Ghostscript balanced
Original → Ghostscript compact
```

### Ghostscript

Ghostscript wird eingesetzt, wenn eine strukturelle Optimierung nicht ausreicht.

Es darf insbesondere:

* große eingebettete Bilder herunterrechnen,
* Bilddaten neu komprimieren,
* redundante PDF-Strukturen neu schreiben,
* die Dateigröße durch angepasste Bildauflösungen reduzieren.

Es werden eigene versionierte Profile verwendet:

```text
balanced
compact
```

Die konkreten Parameter der Profile sind Teil der technischen Konfiguration und werden anhand realistischer Testdokumente festgelegt.

Es werden nicht einfach unkontrolliert Ghostscript-Presets aus der Anfrage übernommen.

## JPEG

JPEGs werden mit Sharp und mozjpeg verarbeitet.

Sharp darf:

* die Bildorientierung anhand der EXIF-Daten korrigieren,
* das Bild in einen definierten sRGB-Farbraum überführen,
* private Metadaten entfernen,
* JPEG-Daten effizient neu codieren,
* die Qualität reduzieren,
* bei Bedarf die maximale Bildkante begrenzen.

Die Ausgabe bleibt immer ein JPEG.

```text
Original JPEG
    ↓
Sharp balanced
    ↓
Sharp compact
```

Jede Stufe wird erneut aus dem Original erzeugt.

---

# Unterstützte PDF-Arten

Der MVP optimiert ausschließlich statische PDFs.

Nicht automatisch verändert werden:

* verschlüsselte PDFs,
* digital signierte PDFs,
* PDF-Formulare,
* XFA-Dokumente,
* PDF-Portfolios,
* PDFs mit eingebetteten Dateien,
* PDFs, deren relevante interaktive Funktionen nicht sicher erhalten werden können.

Eine solche PDF bleibt unverändert.

Passt die gesamte Anhangsmenge trotzdem unter das Zielbudget, darf sie im Original versendet werden.

Bleibt die Nachricht wegen dieser Datei zu groß, wird die Aktion abgebrochen.

---

# Verarbeitungslimits

Es werden mehrere unterschiedliche Limits verwendet.

## `maxSingleInputBytes`

Maximale Größe einer einzelnen Originaldatei, die verarbeitet werden darf.

## `maxTotalInputBytes`

Maximale Gesamtgröße aller Originalanhänge einer Aktion.

## `maxWorkingBytes`

Maximal erlaubtes temporäres Arbeitsvolumen für:

* Originaldateien,
* Kandidaten,
* temporäre Ausgaben,
* Bibliotheks- und Prozessspeicher.

## `maxAttachmentBytes`

Maximale finale Gesamtgröße, die das Ziel transportieren darf.

Beispiel:

```text
maxSingleInputBytes:  50 MiB
maxTotalInputBytes:  100 MiB
maxWorkingBytes:     300 MiB
maxAttachmentBytes: 14,5 MiB
```

Falls die Source-Schnittstelle keine Dateigröße vor dem Abruf liefert und nicht streambar ist, kann `maxSingleInputBytes` erst nach dem Laden geprüft werden.

Ein frühzeitiger Abbruch während des Downloads ist nur dann zugesichert, wenn die Quelle verlässliche Größenmetadaten oder einen begrenzbaren Stream bereitstellt.

---

# Optimierungsstrategie

## Ziel

Die Pipeline soll das Größenlimit mit einer vorhersehbaren und möglichst schonenden festen Strategie erreichen.

Sie garantiert nicht mathematisch die global beste mögliche Qualität.

Sie garantiert:

* eine feste Reihenfolge,
* eine feste Profilleiter,
* einen Abbruch bei der ersten ausreichenden Kombination,
* und keine unnötige weitere Verschlechterung nach Erreichen des Limits.

## Verarbeitungsablauf

```text
1. Originalanhänge materialisieren

2. Originalhashes und Formate prüfen

3. Eingabelimits prüfen

4. Gesamtgröße berechnen

5. Passt die Summe bereits?
   → alle Dateien unverändert weitergeben

6. Preflight für PDFs und JPEGs ausführen

7. schonende Kandidaten erzeugen

8. nach jedem akzeptierten Kandidaten:
   → Gesamtgröße neu berechnen

9. sobald das Zielbudget erreicht ist:
   → Pipeline beenden

10. falls notwendig:
    → balanced-Profile verwenden

11. falls durch die Policy erlaubt:
    → compact-Profile verwenden

12. Zielbudget weiterhin überschritten?
    → Aktion abbrechen
```

## Prioritätsreihenfolge

Die Pipeline verwendet eine fest konfigurierte Reihenfolge.

Empfohlene MVP-Reihenfolge:

```text
1. PDF structural über qpdf

2. JPEG balanced

3. PDF balanced

4. JPEG compact

5. PDF compact
```

Innerhalb derselben Stufe werden die geeigneten Dateien nach Größe absteigend verarbeitet.

Bei gleicher Größe entscheidet die ursprüngliche Reihenfolge der Anhänge.

Diese Reihenfolge kann nach Benchmarks angepasst werden, muss aber versioniert und deterministisch bleiben.

## Keine kaskadierende Kompression

Nicht zulässig:

```text
Original → balanced → compact
```

Zulässig:

```text
Original → balanced
Original → compact
```

Damit wird eine mehrfache verlustbehaftete Codierung vermieden.

---

# Kandidatenannahme

Ein Optimierungskandidat wird nur übernommen, wenn:

* der Verarbeitungsschritt erfolgreich abgeschlossen wurde,
* die Ausgabe vorhanden und nicht leer ist,
* das erwartete Dateiformat erhalten bleibt,
* die Ausgabe erneut geöffnet und geprüft werden kann,
* die Datei kleiner als der bisher verwendete Kandidat ist,
* und die Ausgabe innerhalb der internen Limits liegt.

Ein Kandidat wird verworfen, wenn:

* er größer als das Original ist,
* er ungültig ist,
* eine Prüfung fehlschlägt,
* seine Seitenzahl von der PDF-Ausgangsdatei abweicht,
* er die konfigurierte Warnungspolicy verletzt,
* oder seine Erzeugung das Zeitbudget überschreitet.

---

# PDF-Validierung

Für jedes PDF-Derivat werden mindestens geprüft:

* Datei ist nicht leer,
* Datei ist als PDF erkennbar,
* qpdf kann die Datei prüfen,
* Seitenzahl entspricht dem Original,
* Ausgabe liegt innerhalb der Größenlimits,
* Ausgabe ist kleiner als der bisherige Kandidat.

Ein vollständiger visueller Gleichheitsnachweis ist nicht Bestandteil des Laufzeitpfads.

Die Qualitätsprofile werden stattdessen vor ihrer Freigabe mit einem realistischen Dokumentkorpus getestet.

---

# JPEG-Validierung

Für jedes JPEG-Derivat werden mindestens geprüft:

* Sharp kann die Ausgabe erneut dekodieren,
* Ausgabeformat ist JPEG,
* Breite und Höhe sind gültig,
* Orientierung ist visuell normalisiert,
* Ausgabe liegt innerhalb der Pixel- und Kanalgrenzen,
* Ausgabe ist kleiner als der bisherige Kandidat.

Eingaben werden zusätzlich durch Grenzen für folgende Eigenschaften geschützt:

* maximale Pixelanzahl,
* maximale Anzahl von Kanälen,
* maximale Dateigröße,
* maximale Verarbeitungsdauer.

---

# Metadatenpolicy für JPEG

Vor der Neucodierung:

1. EXIF-Orientierung anwenden,
2. Bild visuell korrekt ausrichten,
3. Bild in sRGB konvertieren,
4. definiertes sRGB-Profil verwenden.

Danach werden entfernt:

* GPS-Koordinaten,
* Kameramodell,
* Aufnahmezeit,
* EXIF-Daten,
* XMP-Daten,
* sonstige private Bildmetadaten.

Der ursprüngliche Dateiname bleibt erhalten.

---

# Fehlerverhalten

Die Pipeline arbeitet fail-closed.

## Zielbudget nicht erreichbar

```text
→ kein Versand
→ attachment_budget_not_reached
```

## Optimierer nicht verfügbar

```text
→ kein Versand
→ attachment_optimizer_unavailable
```

## Verarbeitung fehlgeschlagen

```text
→ kein ungültiges Derivat verwenden
→ attachment_optimization_failed
```

## Zeitbudget überschritten

```text
→ laufende Prozesse abbrechen
→ temporäre Dateien entfernen
→ attachment_optimization_timeout
```

## Transportfehler

Ein Transportfehler wird erst erzeugt, wenn die Optimierung erfolgreich abgeschlossen wurde und das Egress-Target anschließend scheitert.

```text
→ delivery_failed
```

Optimierungs- und Transportfehler werden intern getrennt behandelt und protokolliert.

---

# Prozessmodell

qpdf und Ghostscript werden über einen zentralen lokalen `ProcessRunner` ausgeführt.

Der ProcessRunner stellt sicher:

* keine Shell-Ausführung mit zusammengesetzten Befehlsstrings,
* Argumentübergabe als getrennte Werte,
* privater temporärer Workspace pro Aktion,
* intern erzeugte temporäre Dateinamen,
* Prozess-Timeout,
* begrenzte Logausgabe,
* begrenzte Parallelität,
* Beenden der vollständigen Prozessgruppe,
* Cleanup im `finally`-Pfad.

Sharp kann im MVP direkt im Node.js-Prozess laufen.

Die Adaptergrenze wird jedoch so gestaltet, dass die JPEG-Verarbeitung später ohne Änderung der Pipeline in einen lokalen Worker-Prozess verschoben werden kann.

Empfohlene Parallelität:

```text
Ghostscript: maximal 1 Job gleichzeitig
qpdf:        begrenzte kleine Parallelität
Sharp:       begrenzte kleine Parallelität
```

---

# Konfiguration

Die Konfiguration wird in Engine- und Target-Einstellungen getrennt.

## Globale Engine-Konfiguration

```jsonc
{
  "attachmentOptimization": {
    "enabled": true,

    "limits": {
      "maxSingleInputBytes": 52428800,
      "maxTotalInputBytes": 104857600,
      "maxWorkingBytes": 314572800,
      "timeBudgetMs": 30000
    },

    "execution": {
      "maxConcurrentPdfJobs": 1,
      "maxConcurrentJpegJobs": 2
    },

    "pdf": {
      "enabled": true,
      "qpdfStructuralOptimization": true,
      "skipEncrypted": true,
      "skipSigned": true,
      "skipInteractive": true,
      "profiles": [
        "balanced",
        "compact"
      ]
    },

    "jpeg": {
      "enabled": true,
      "autoOrient": true,
      "stripMetadata": true,
      "outputColorSpace": "srgb",
      "profiles": [
        "balanced",
        "compact"
      ]
    }
  }
}
```

## Konfiguration pro Target

```jsonc
{
  "optimization": {
    "mode": "balanced",
    "pdf": true,
    "jpeg": true
  }
}
```

Mögliche Modi:

```text
disabled
    Keine automatische Optimierung.

balanced
    Strukturelle und moderate Optimierung erlaubt.

compact
    Zusätzlich stärkere Profile erlaubt.
```

Das eigentliche Größenbudget bleibt Bestandteil des Targets.

Dadurch kann SMTP beispielsweise `balanced` verwenden, während Telegram aufgrund eines höheren Limits keine Optimierung benötigt.

---

# Audit

Für jeden versendeten Anhang wird protokolliert:

```text
originalFilename
originalMimeType
originalBytes
originalSha256

outputBytes
outputSha256

wasOptimized
optimizer
profile
toolVersion
durationMs
```

Bei unveränderten Dateien gilt:

```text
originalSha256 = outputSha256
wasOptimized = false
```

Bei optimierten Dateien dürfen die Hashes voneinander abweichen.

Das Audit bildet die tatsächlich an das Target übergebenen Dateien ab und nicht nur die ursprünglich freigegebenen Anhänge.

Sensible Dokumentinhalte oder vollständige temporäre Pfade werden nicht protokolliert.

---

# Neustartverhalten

## Neustart vor der Freigabe

Da vor der Freigabe noch kein Derivat erzeugt wird, ist kein persistiertes Kompressionsergebnis erforderlich.

Die Aktion kann nach den bestehenden Regeln erneut geladen oder freigegeben werden.

## Neustart während der Optimierung oder des Versands

Wird das Gateway während einer laufenden Ausführung beendet:

* wird die Aktion beim Start nicht automatisch erneut versendet,
* sie wird als fehlgeschlagen beziehungsweise unklar beendet markiert,
* der Nutzer muss eine neue Aktion vorbereiten.

Damit wird ein möglicher Doppelversand verhindert.

---

# Akzeptanzkriterien

| #         | Gegeben                                                              | Wenn                                            | Dann                                                                                        |
| --------- | -------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **AK-1**  | Die Originalsumme liegt unter dem Target-Limit                       | die Aktion ausgeführt wird                      | wird kein Optimierer aufgerufen und alle Anhänge bleiben byte-identisch                     |
| **AK-2**  | Die Originalsumme überschreitet das Target-Limit                     | die freigegebene Aktion ausgeführt wird         | startet die Attachment-Optimization-Pipeline vor dem Transport                              |
| **AK-3**  | Eine Optimierung ist erforderlich                                    | die Pipeline startet                            | verwendet sie ausschließlich Formate und Profile aus der gebundenen Transformationspolicy   |
| **AK-4**  | Eine PDF ist verschlüsselt, signiert oder interaktiv                 | der Preflight läuft                             | wird die PDF nicht verändert                                                                |
| **AK-5**  | Eine nicht transformierbare PDF verhindert das Erreichen des Budgets | die Pipeline endet                              | wird nichts versendet                                                                       |
| **AK-6**  | Eine PDF kann strukturell verkleinert werden                         | der qpdf-Kandidat ist gültig und kleiner        | darf er übernommen werden                                                                   |
| **AK-7**  | Die strukturelle PDF-Optimierung reicht nicht aus                    | ein weiteres Profil ist erlaubt                 | wird ein Ghostscript-Kandidat direkt aus dem Original erzeugt                               |
| **AK-8**  | Ein JPEG wird verarbeitet                                            | die Optimierung läuft                           | bleiben Format und sichtbare Orientierung erhalten                                          |
| **AK-9**  | Ein JPEG enthält GPS- oder EXIF-Daten                                | es optimiert wird                               | werden diese Metadaten aus der Ausgabe entfernt                                             |
| **AK-10** | Ein JPEG besitzt einen anderen Farbraum                              | es verarbeitet wird                             | wird die Ausgabe gemäß der festgelegten Policy in sRGB erzeugt                              |
| **AK-11** | Ein Kandidat ist größer als der aktuelle Stand                       | er bewertet wird                                | wird er verworfen                                                                           |
| **AK-12** | Ein Kandidat ist ungültig                                            | die Validierung läuft                           | wird er niemals an ein Target übergeben                                                     |
| **AK-13** | Eine Stufe bringt die Gesamtsumme unter das Limit                    | die Pipeline läuft                              | beendet sie die weitere Optimierung sofort                                                  |
| **AK-14** | Ein Compact-Profil ist nicht freigegeben                             | Balanced reicht nicht aus                       | wird Compact nicht ausgeführt und die Aktion scheitert                                      |
| **AK-15** | Mehrere Dateien sind für dieselbe Stufe geeignet                     | sie verarbeitet werden                          | gilt eine stabile, dokumentierte Reihenfolge                                                |
| **AK-16** | Eine Datei ist weder PDF noch JPEG                                   | die Pipeline läuft                              | bleibt sie unverändert                                                                      |
| **AK-17** | Kein erlaubter Kandidat erreicht das Zielbudget                      | die Pipeline endet                              | wird nichts versendet und `attachment_budget_not_reached` erzeugt                           |
| **AK-18** | Ein Optimierer fällt aus                                             | seine Ausgabe unvollständig oder ungültig ist   | wird diese Ausgabe gelöscht und nicht versendet                                             |
| **AK-19** | Das Gesamtzeitbudget wird überschritten                              | die Pipeline läuft                              | werden laufende Prozesse beendet und die Aktion scheitert kontrolliert                      |
| **AK-20** | Die Pipeline liefert ein Ergebnis                                    | das Target übernimmt                            | prüft das Target die tatsächliche Gesamtgröße erneut                                        |
| **AK-21** | Ein Anhang wurde optimiert                                           | der Versand erfolgt                             | enthält das Audit Original- und Ausgabegröße sowie beide Hashes                             |
| **AK-22** | Derselbe Input wird erneut verarbeitet                               | Konfiguration und Werkzeugversionen sind gleich | wird dieselbe Stufen- und Profilreihenfolge gewählt; Byte-Gleichheit wird nicht zugesichert |
| **AK-23** | Die Aktion wird freigegeben                                          | eine Optimierung notwendig ist                  | wird kein zweiter Freigabeschritt verlangt                                                  |
| **AK-24** | Die Pipeline endet durch Erfolg oder Fehler                          | temporäre Dateien existieren                    | werden sie zuverlässig entfernt                                                             |
| **AK-25** | Das Gateway wird während einer laufenden Ausführung beendet          | es startet neu                                  | erfolgt kein automatischer erneuter Versand                                                 |

---

# Implementierungsplan

## Phase 1: Domänen- und Freigabevertrag

1. Originalanhänge und ausgelieferte Anhänge begrifflich trennen.
2. Transformationspolicy als Bestandteil der freigegebenen Aktion modellieren.
3. Maximales erlaubtes Profil pro Target festlegen.
4. Auditmodell um tatsächliche Ausgabedaten erweitern.
5. Bestehende Annahme entfernen, dass Plananhänge zwingend den final versendeten Bytes entsprechen.

## Phase 2: Pipeline-Grundstruktur

1. `AttachmentOptimizationPipeline` einführen.
2. Eingabe-, Policy- und Ergebnistypen definieren.
3. No-op-Pfad für bereits passende Anhänge implementieren.
4. Budgetberechnung für die vollständige Anhangsmenge implementieren.
5. Stabile Prioritäts- und Profilreihenfolge implementieren.
6. Interne Optimierungsfehler definieren.

## Phase 3: Limits und Preflight

1. Einzel-, Gesamt- und Working-Set-Limits ergänzen.
2. Bestehende Source-Schnittstellen auf Größenmetadaten oder Streaming prüfen.
3. PDF-Preflight implementieren.
4. Verschlüsselte, signierte und interaktive PDFs erkennen oder konservativ überspringen.
5. JPEG-Pixel-, Kanal- und Formatgrenzen implementieren.

## Phase 4: Prozessinfrastruktur

1. Zentralen `ProcessRunner` einführen.
2. Private temporäre Workspaces implementieren.
3. Timeout und Prozessgruppenabbruch implementieren.
4. Parallelitätsbegrenzung implementieren.
5. Werkzeugverfügbarkeit und Versionen beim Start erfassen.
6. Cleanup in allen Erfolgs- und Fehlerpfaden absichern.

## Phase 5: PDF-Adapter

1. qpdf-Preflight und Validierung implementieren.
2. Optionale strukturelle qpdf-Optimierung implementieren.
3. Ghostscript-Adapter implementieren.
4. Profile `balanced` und `compact` definieren.
5. Sicherstellen, dass jeder Kandidat aus dem Original erzeugt wird.
6. Seitenzahl-, Größen- und Formatvalidierung ergänzen.

## Phase 6: JPEG-Adapter

1. Sharp mit mozjpeg integrieren.
2. Auto-Orientierung implementieren.
3. sRGB-Ausgabe definieren.
4. Entfernung privater Metadaten implementieren.
5. Profile `balanced` und `compact` implementieren.
6. Pixel- und Resize-Grenzen ergänzen.
7. Ausgabe erneut dekodieren und validieren.

## Phase 7: Gateway-Integration

1. Pipeline nach Freigabe in den `ActionExecutor` integrieren.
2. Originalressourcen vor der Transformation erneut verifizieren.
3. Tatsächliche Ausgabedateien an das Target übergeben.
4. Finale Größenprüfung im Target beibehalten.
5. Audit auf die tatsächlich ausgelieferten Anhänge umstellen.
6. Neustartverhalten für laufende Aktionen definieren.

## Phase 8: Profilkalibrierung

Ein realistisches Testkorpus erstellen:

```text
- textlastige PDF
- gescannte PDF
- bildlastige PDF
- bereits optimierte PDF
- verschlüsselte PDF
- digital signierte PDF
- PDF-Formular
- kleines JPEG
- großes Smartphone-JPEG
- JPEG mit EXIF-Rotation
- JPEG mit GPS-Daten
- JPEG in Display-P3 oder CMYK
- gemischte Nachricht aus PDF und JPEG
```

Bewertet werden:

* Größenersparnis,
* Lesbarkeit kleiner Schrift,
* sichtbare Artefakte,
* PDF-Seitenzahl,
* Textdurchsuchbarkeit,
* Farbdarstellung,
* JPEG-Orientierung,
* Verarbeitungsdauer,
* CPU- und Speicherverbrauch.

Die konkreten Profile werden erst danach als stabil markiert.

---

# Definition of Done

* PDF- und JPEG-Pipeline sind implementiert.
* Optimierung findet nach der Freigabe und vor dem Target statt.
* Die Freigabe bindet Originale und Transformationspolicy, nicht konkrete Derivatbytes.
* Byte-Reproduzierbarkeit ist ausdrücklich keine Anforderung.
* Tatsächliche Ausgabehashes werden nach der Transformation ermittelt und auditiert.
* Bereits passende Anhänge werden nicht verändert.
* Nicht unterstützte und nicht transformierbare Dateien bleiben unverändert.
* Kein ungültiges oder weiterhin zu großes Ergebnis erreicht ein Target.
* qpdf-, Ghostscript- und Sharp-Adapter sind unabhängig testbar.
* Normale Unit Tests benötigen keine installierten externen PDF-Werkzeuge.
* Reale Integrationstests prüfen die tatsächliche Werkzeugkette.
* Prozesse besitzen Timeouts und Parallelitätsgrenzen.
* Temporäre Dateien werden in jedem Fehlerpfad entfernt.
* Der Versandkanal behält seine unabhängige finale Größenprüfung.
* Qualitätsprofile wurden anhand realistischer Dokumente kalibriert.
* Audit und Dokumentation zeigen Original- und Ausgabedaten korrekt.
* README und Beispielkonfiguration wurden widerspruchsfrei aktualisiert.
* Typecheck, Tests und Dokumentationsprüfungen sind erfolgreich.
