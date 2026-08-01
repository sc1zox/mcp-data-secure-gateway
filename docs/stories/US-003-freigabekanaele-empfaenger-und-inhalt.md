# US-003 — Freigabekanäle: Empfänger prüfen, vollständigen Kontext anzeigen

| | |
| --- | --- |
| **Status** | Umsetzungsbereit |
| **Angelegt** | 2026-08-01 |
| **Geltung** | Maßgeblich bis zur Umsetzung, danach durch Produkt- und Architekturdokumentation abgelöst |
| **Betrifft** | Lokales Freigabeportal und optionaler Telegram-Freigabekanal |

---

## User Story

> **Als** Nutzer des Gateways
> **möchte ich** in jedem Freigabekanal die vollständige E-Mail-Empfängeradresse sowie den vollständigen Dokument- und Bewertungs-Kontext sehen,
> **damit** ich Versandziel, Dokument und Bewertung vor einer Freigabe verlässlich prüfen kann.

---

## Ausgangssituation

Die Freigabe ist der letzte menschliche Kontrollpunkt vor einer Übertragung. Dafür muss der konkrete Empfänger sichtbar sein, auch wenn er bei einem festen Ziel lokal konfiguriert ist.

Der Telegram-Freigabekanal ist optional und nur für einen privaten, fest gebundenen Chat mit einer fest gespeicherten Benutzer-ID vorgesehen. Er ist kein lokaler Kanal; daher müssen seine Informationen auf das für eine Versandentscheidung notwendige Minimum beschränkt bleiben.

---

## Fachliche Anforderungen

### 1. Vollständige Empfängeradresse

Bei E-Mail-Versand zeigt das lokale Freigabeportal die vollständige Empfängeradresse an.

Der private, fest gebundene Telegram-Freigabekanal zeigt dieselbe vollständige Empfängeradresse an. Der Betreiber akzeptiert diese Übertragung ausdrücklich für diesen optionalen, privaten Freigabekanal, damit das Versandziel auch dort überprüft werden kann.

Die Adresse bleibt Teil des unveränderlichen Freigabe-Snapshots. Eine Änderung von Ziel oder Empfänger erzeugt weiterhin eine neue Aktion.

### 2. Vollständige Telegram-Freigabe

Für eine versendbare Aktion zeigt Telegram:

- Zweck,
- Erstell- und Ablaufzeit,
- Dokumenttitel, Quelle und Quellkennung,
- Medientyp und Größe der Ressource,
- vollständige Empfängeradresse und Ziel,
- Hinweis auf einen vom Agenten vorgeschlagenen dynamischen Empfänger,
- Modellbewertung mit Sensibilität, Konfidenz, Begründung und Grundlage der Inhaltsprüfung,
- Inhaltsangabe oder Inhaltsauszug, sofern für die Aktion vorhanden,
- Kennzeichnung der Autorschaft,
- Betreff und vollständigen Nachrichtentext,
- Anhänge mit Dateiname, Medientyp und Größe,
- zulässige Anhangsoptimierung, sofern konfiguriert,
- Aktions-ID und Freigabe- beziehungsweise Ablehnoption.

Telegram zeigt nicht:

- Quell-URLs,
- Originaldateien,
- Portal- oder MCP-Tokens.

Eine Zusammenfassung bleibt in Telegram nicht freigebbar, weil ihr vollständiger Zusammenfassungstext dort weiterhin nicht angezeigt wird.

### 3. Sicherheitsgrenzen

- Hermes erhält weiterhin keine Empfängeradresse, keine zusätzlichen Zieldetails und keine Inhalte privater Dokumente.
- Die vollständige Adresse erscheint ausschließlich in nutzerkontrollierten Freigabekanälen.
- Telegram bleibt optional; nur der gespeicherte private Chat zusammen mit der gespeicherten Benutzer-ID darf Entscheidungen treffen.
- Die lokale Browserfreigabe bleibt jederzeit verfügbar, auch wenn Telegram deaktiviert oder nicht erreichbar ist.

---

## Akzeptanzkriterien

- [ ] Ein fest konfiguriertes E-Mail-Ziel wird im lokalen Portal mit vollständiger Empfängeradresse angezeigt.
- [ ] Dieselbe vollständige Adresse erscheint bei einer Versandfreigabe im privaten Telegram-Freigabekanal.
- [ ] Telegram enthält vollständigen Dokumenttitel, Quelle, Quellkennung, Modellbewertung, Konfidenz, Begründung und Inhaltsangabe beziehungsweise -auszug, sofern vorhanden.
- [ ] Telegram enthält keine Quell-URLs, Originaldateien, Portal- oder MCP-Tokens.
- [ ] Betreff und Nachrichtentext werden für eine über Telegram freigebbare Versandaktion vollständig angezeigt.
- [ ] Änderungen an Empfänger, Ziel, Betreff, Text oder Anhängen machen eine neue Freigabe erforderlich.
- [ ] Eine Zusammenfassung kann über Telegram weiterhin nur abgelehnt, nicht freigegeben werden.
- [ ] Tests belegen die Projektion in Portal und Telegram sowie die unveränderte Freigabebindung.
