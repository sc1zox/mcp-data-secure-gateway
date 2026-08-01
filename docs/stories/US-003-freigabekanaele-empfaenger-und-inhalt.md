# US-003 — Freigabekanäle: Empfänger prüfen, Informationen konzentrieren

| | |
| --- | --- |
| **Status** | Umsetzungsbereit |
| **Angelegt** | 2026-08-01 |
| **Geltung** | Maßgeblich bis zur Umsetzung, danach durch Produkt- und Architekturdokumentation abgelöst |
| **Betrifft** | Lokales Freigabeportal und optionaler Telegram-Freigabekanal |

---

## User Story

> **Als** Nutzer des Gateways
> **möchte ich** in jedem Freigabekanal die vollständige E-Mail-Empfängeradresse sehen und nur die Informationen erhalten, die für meine Versandentscheidung erforderlich sind,
> **damit** ich das Versandziel verlässlich prüfen kann, ohne von redundanten oder dokumentnahen Metadaten abgelenkt zu werden.

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

### 2. Konzentrierte Telegram-Freigabe

Für eine versendbare Aktion zeigt Telegram nur:

- Zweck,
- Erstell- und Ablaufzeit,
- Ziel und vollständige Empfängeradresse,
- Hinweis auf einen vom Agenten vorgeschlagenen dynamischen Empfänger,
- Kennzeichnung der Autorschaft,
- Betreff und vollständigen Nachrichtentext,
- Anhänge mit Dateiname, Medientyp und Größe,
- zulässige Anhangsoptimierung, sofern konfiguriert,
- Aktions-ID und Freigabe- beziehungsweise Ablehnoption.

Telegram zeigt nicht:

- Dokumenttitel,
- Quelle oder Quellkennung,
- Modellbewertung, Konfidenz oder Modellbegründung,
- Inhaltsauszüge oder sonstige aus dem Dokument gelesene Angaben,
- Quell-URLs, Originaldateien, Portal- oder MCP-Tokens.

Eine Zusammenfassung bleibt in Telegram nicht freigebbar, weil ihr Text dort nicht angezeigt wird.

### 3. Sicherheitsgrenzen

- Hermes erhält weiterhin keine Empfängeradresse, keine zusätzlichen Zieldetails und keine Inhalte privater Dokumente.
- Die vollständige Adresse erscheint ausschließlich in nutzerkontrollierten Freigabekanälen.
- Telegram bleibt optional; nur der gespeicherte private Chat zusammen mit der gespeicherten Benutzer-ID darf Entscheidungen treffen.
- Die lokale Browserfreigabe bleibt jederzeit verfügbar, auch wenn Telegram deaktiviert oder nicht erreichbar ist.

---

## Akzeptanzkriterien

- [ ] Ein fest konfiguriertes E-Mail-Ziel wird im lokalen Portal mit vollständiger Empfängeradresse angezeigt.
- [ ] Dieselbe vollständige Adresse erscheint bei einer Versandfreigabe im privaten Telegram-Freigabekanal.
- [ ] Telegram enthält alle zur Freigabe erforderlichen Versanddaten, aber keine Dokumenttitel, Quellinformationen, Modellbewertung oder Dokumentinhalte.
- [ ] Betreff und Nachrichtentext werden für eine über Telegram freigebbare Versandaktion vollständig angezeigt.
- [ ] Änderungen an Empfänger, Ziel, Betreff, Text oder Anhängen machen eine neue Freigabe erforderlich.
- [ ] Eine Zusammenfassung kann über Telegram weiterhin nur abgelehnt, nicht freigegeben werden.
- [ ] Tests belegen die Projektion in Portal und Telegram sowie die unveränderte Freigabebindung.
