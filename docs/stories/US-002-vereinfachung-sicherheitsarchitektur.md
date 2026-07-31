# US-002 — Vereinfachung der Sicherheitsarchitektur

|                  |                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------- |
| **Status**       | Entwurf                                                                                   |
| **Angelegt**     | 2026-07-31                                                                                |
| **Geltung**      | Maßgeblich bis zur Umsetzung, danach durch Produkt- und Architekturdokumentation abgelöst |
| **Betrifft**     | Sicherheitsinfrastruktur, Aktionsverwaltung, Prompt-Härtung, Freigabeoberfläche, Audit    |

---

## User Story

> **Als** Betreiber des MCP Data Secure Gateway
> **möchte ich** die Sicherheitsarchitektur auf die tatsächlich relevanten Bedrohungen reduzieren,
> **damit** das Gateway einfacher zu verstehen, zu warten und zuverlässig zu betreiben ist, während sensible Daten weiterhin vor unkontrollierten Modellzugriffen und Rogue-Agent-Aufrufen geschützt bleiben.

---

## Ausgangssituation

Das MCP Data Secure Gateway vermittelt zwischen einem Cloud-Agenten wie Hermes und lokalen, sensiblen Datenquellen wie Paperless.

Das zentrale Sicherheitsziel besteht darin, zu verhindern, dass ein fehlerhaftes, kompromittiertes oder unerwartet handelndes Modell:

* sensible Dokumente direkt auslesen kann,
* Dokumentinhalte unkontrolliert an Cloud-Dienste überträgt,
* eigenständig Nachrichten oder Anhänge versendet,
* nicht erlaubte Empfänger oder Ziele verwendet,
* durch manipulierte Tool-Aufrufe Datenschutzgrenzen umgeht.

Das Gateway läuft jedoch innerhalb einer kontrollierten lokalen Umgebung. Angriffe auf den lokalen Host, Manipulationen der internen Prozesskommunikation, Man-in-the-Middle-Angriffe innerhalb des Gateways oder eine Kompromittierung der lokalen Freigabeoberfläche gehören nicht zum primären Threat Model.

Die aktuelle Implementierung enthält mehrere Schutzmechanismen, die hauptsächlich gegen solche lokalen Angriffe oder Manipulationen schützen. Diese Mechanismen erhöhen Komplexität, Wartungsaufwand und Fehleranfälligkeit, ohne das eigentliche Sicherheitsziel wesentlich zu verbessern.

---

## Zielbild

Das Gateway soll weiterhin als verbindliche lokale Kontrollinstanz zwischen dem Agenten und privaten Datenquellen dienen.

Der Agent darf:

* nach einer abstrakt beschriebenen Ressource suchen,
* eine Aktion mit einer opaken Ressourcenreferenz vorbereiten,
* erlaubte Ziele auflisten,
* den Status einer Aktion abfragen,
* eine lokal erzeugte und freigegebene Zusammenfassung abrufen.

Der Agent darf nicht:

* direkt auf Paperless oder andere private Quellen zugreifen,
* interne Dokument-IDs, Dateipfade oder Zugangsdaten erhalten,
* Originaldokumente herunterladen,
* beliebige Empfänger oder Übertragungsziele verwenden,
* eine Aktion selbst freigeben,
* eine bereits freigegebene Aktion nachträglich verändern.

Jeder tatsächliche Datenabfluss muss weiterhin durch eine lokale, menschliche Freigabe bestätigt werden.

---

# Funktionale Anforderungen

## 1. Enge MCP-Schnittstelle beibehalten

Die bestehende abstrakte MCP-Schnittstelle bleibt erhalten.

Hermes erhält ausschließlich die für den vorgesehenen Prozess notwendigen Gateway-Tools. Direkte Paperless-Werkzeuge und administrative Werkzeuge dürfen nicht über dieselbe MCP-Schnittstelle verfügbar sein.

Insbesondere darf es über die Agentenschnittstelle keine Funktionen zum Löschen, Ändern, Hochladen oder direkten Herunterladen von Dokumenten geben.

## 2. Quellen bleiben lokal und read-only

Private Datenquellen werden ausschließlich lokal vom Gateway angesprochen.

Der Zugriff soll technisch oder organisatorisch auf lesende Operationen beschränkt werden. Schreibende Quelloperationen gehören nicht zum Gateway und werden nicht an den Agenten weitergereicht.

## 3. Opake Ressourcenreferenzen beibehalten

Nach einer erfolgreichen Suche erhält der Agent weiterhin eine zufällige, opake Referenz.

Die Referenz darf keine Rückschlüsse auf folgende Informationen ermöglichen:

* interne Paperless-ID,
* Dateipfad,
* Dateiname, sofern dieser sensible Informationen enthält,
* Quellzugangsdaten,
* OCR-Inhalte,
* interne Serverstruktur.

Die Referenz bleibt zeitlich begrenzt und an den bei der Suche angegebenen Zweck gebunden.

## 4. Manuelle Auswahl bei mehrdeutigen Ergebnissen beibehalten

Werden mehere plausible Ressourcen gefunden, darf das lokale Modell keine endgültige Auswahl treffen.

Das Gateway erstellt stattdessen eine lokale Auswahlanfrage. Der Benutzer wählt die richtige Ressource in der lokalen Oberfläche aus.

Damit soll verhindert werden, dass beispielsweise ein Arbeitsvertrag anstelle eines Lebenslaufs verwendet wird.

## 5. Einfache, unveränderliche Aktions-Snapshots

Beim Vorbereiten einer Aktion erstellt das Gateway einen unveränderlichen Snapshot mit mindestens folgenden Informationen:

* ausgewählte Ressourcen,
* Ziel,
* Empfänger,
* Betreff,
* Nachrichtentext,
* Anhangsreihenfolge,
* Dateinamen,
* Dateitypen,
* Dateigrößen.

Der Snapshot wird nach seiner Erstellung nicht mehr verändert.

Möchte der Agent Empfänger, Betreff, Text, Ziel oder Anhänge ändern, muss eine neue Aktion erstellt werden. Die vorherige Aktion wird verworfen.

Eine komplexe kryptografische Bindung sämtlicher Felder ist nicht als primärer Sicherheitsmechanismus erforderlich. Ein interner Hash kann weiterhin als einfache Integritätsprüfung verwendet werden, darf aber die Prozesslogik nicht unnötig verkomplizieren.

## 6. Hashes nicht mehr in der Freigabeoberfläche anzeigen

SHA-256-Werte und andere technische Prüfsummen werden nicht mehr als reguläre Informationen in der Benutzeroberfläche angezeigt.

Die Freigabeoberfläche zeigt stattdessen verständliche Informationen:

* Dokumentbezeichnung,
* Dateityp,
* Dateigröße,
* Datenquelle,
* Änderungsdatum, sofern verfügbar,
* Empfänger,
* Ziel,
* Betreff,
* vollständiger Nachrichtentext,
* erkannte Unsicherheiten,
* Ergebnis der lokalen Inhaltsprüfung.

Prüfsummen dürfen intern weiterhin zur Erkennung unbeabsichtigter Änderungen verwendet werden.

## 7. Offene Aktionen nach Neustart verwerfen

Nicht freigegebene oder noch nicht ausgeführte Aktionen werden nach einem Neustart des Gateways nicht wiederhergestellt.

Beim Start werden alle zuvor offenen Aktionen als abgelaufen oder verworfen markiert.

Hermes muss anschließend eine neue Aktion vorbereiten.

Dadurch entfallen:

* die Wiederherstellung temporärer Originaldateien,
* die Revalidierung alter Freigaben,
* das erneute Laden und Vergleichen historischer Anhangsbytes,
* komplexe Wiederanlaufzustände,
* die Gefahr, veraltete Aktionen nach einem Neustart auszuführen.

Bereits erfolgreich abgeschlossene oder abgelehnte Aktionen können für das Audit weiterhin gespeichert bleiben.

## 8. Einfache Integritätsprüfung unmittelbar vor dem Versand

Unmittelbar vor dem Versand überprüft das Gateway weiterhin:

* ob die Aktion lokal freigegeben wurde,
* ob sie noch nicht abgelaufen ist,
* ob Ziel und Empfänger dem freigegebenen Snapshot entsprechen,
* ob Anzahl und Gesamtgröße der Anhänge innerhalb der Limits liegen,
* ob Dateitypen und Dateinamen zulässig sind,
* ob die zum Versand verwendeten Dateien dem vorbereiteten Snapshot entsprechen.

Die Integritätsprüfung soll intern erfolgen und keine kryptografische Interaktion mit dem Benutzer erfordern.

Der Benutzer bestätigt eine Aktions-ID beziehungsweise den sichtbaren Snapshot, nicht einen technischen Binding-Hash.

## 9. Nonces aus internen Modell-Prompts entfernen

Nonces in Prompts zwischen dem Gateway und dem lokalen Modell werden entfernt.

Die Modellanfragen entstehen vollständig innerhalb des vertrauenswürdigen lokalen Gateway-Prozesses. Das lokale Modell erhält keinen extern erzeugten Prompt, der anhand einer Nonce authentifiziert werden müsste.

Eine Nonce bietet innerhalb dieses Threat Models keinen relevanten Schutz gegen Rogue-Agent-Aufrufe, da:

* der Agent den internen Modellprompt nicht direkt erzeugt,
* die Kommunikation zwischen Gateway und lokalem Modell als vertrauenswürdig gilt,
* keine nicht vertrauenswürdige Partei eine gültige Modellantwort in den internen Prozess einschleusen können soll,
* eine erfolgreiche Nonce-Prüfung keine inhaltliche Sicherheit garantiert.

Prompts sollen stattdessen durch klare strukturierte Ein- und Ausgabeformate abgesichert werden.

Die Antwort des lokalen Modells wird weiterhin streng validiert. Ungültige, unvollständige oder nicht parsebare Antworten werden verworfen.

## 10. Prompt-Härtung auf relevante Risiken begrenzen

Die internen Modellprompts sollen weiterhin klar zwischen folgenden Daten unterscheiden:

* Systemanweisung,
* Benutzerzweck,
* Dokumentmetadaten,
* Dokumentinhalt,
* erwartetes Ausgabeformat.

Dokumentinhalte werden als nicht vertrauenswürdige Daten behandelt. Anweisungen innerhalb eines Dokuments dürfen nicht als Gateway-Anweisungen interpretiert werden.

Dafür genügen:

* eine klare Systemanweisung,
* strukturierte Datenfelder,
* ein festes JSON-Ausgabeformat,
* Schema-Validierung,
* definierte Fallbacks bei ungültiger Ausgabe.

Zusätzliche Challenge-Response-Verfahren, Nonces oder kryptografisch markierte Prompt-Blöcke sind nicht erforderlich.

## 11. Freigabeoberfläche vereinfachen

Die lokale Freigabeoberfläche bleibt ausschließlich lokal oder innerhalb eines administrativ kontrollierten Netzes erreichbar.

Beibehalten werden:

* Bindung an Loopback beziehungsweise eine explizit konfigurierte interne Adresse,
* Authentifizierung der Oberfläche,
* Schutz gegen unbeabsichtigte externe Erreichbarkeit,
* getrennte Berechtigungen zwischen Agentenschnittstelle und Freigabeoberfläche.

Vereinfacht werden können:

* unnötig komplexe Nonce-Mechanismen,
* kryptografische Bestätigungswerte im UI,
* besonders umfangreiche clientseitige Routenvalidierungen,
* Schutzmechanismen, die ausschließlich gegen einen bereits kompromittierten lokalen Host wirken.

Normale Web-Sicherheitsmaßnahmen wie sichere Header, eine restriktive Content Security Policy und sichere Cookies dürfen beibehalten werden, sofern sie durch Standardmechanismen des verwendeten Frameworks umgesetzt werden können und keine eigene komplexe Infrastruktur erfordern.

## 12. Telegram-Freigabe vereinfachen

Die Telegram-Freigabe bleibt optional.

Die bevorzugte und vollständig informative Freigabe erfolgt über die lokale Browseroberfläche.

Telegram darf verwendet werden, um:

* auf eine offene Aktion hinzuweisen,
* eine Aktion anzunehmen oder abzulehnen,
* den Benutzer auf die lokale Detailansicht zu verweisen.

Die Speicherung des Telegram-Tokens kann über eine geschützte Umgebungsvariable, Docker Secret oder eine Datei mit restriktiven Dateirechten erfolgen.

Eine eigene verschlüsselte Konfigurationsdatenbank mit Schlüsselableitung, Migrationen und rotierenden Nonces ist nicht erforderlich, solange das lokale Betriebssystem und die Deployment-Umgebung als vertrauenswürdig gelten.

Telegram-Bot-Tokens dürfen weiterhin niemals über die Agentenschnittstelle oder das Audit-Log ausgegeben werden.

## 13. Erkennung sensibler Inhalte vereinfachen

Zusammenfassungen werden weiterhin lokal erzeugt und vor der Weitergabe an Hermes lokal angezeigt.

Folgende Inhalte führen weiterhin zu einer harten Sperre:

* erkannte Zugangsdaten,
* API-Schlüssel,
* Passwörter,
* private Schlüssel,
* Tokens,
* eindeutig hochsensible Identifikationsdaten, sofern sie nicht erfolgreich redigiert wurden.

URLs, normale technische Pfade und allgemeine Dateipfade führen nicht mehr automatisch zur Ablehnung.

Sie erzeugen stattdessen einen sichtbaren Warnhinweis in der Freigabeoberfläche.

Beispiele:

* GitHub- oder Projekt-URLs,
* Verweise auf eine Unternehmenswebseite,
* technische Pfade wie `/etc/nginx`,
* allgemeine Dokumentpfade ohne personenbezogene Informationen.

Der Benutzer entscheidet anhand des vollständigen Textes, ob die Zusammenfassung freigegeben werden darf.

## 14. Audit-Log begrenzen

Das Audit-Log darf nicht unbegrenzt wachsen.

Es wird eine konfigurierbare Aufbewahrungsdauer eingeführt, beispielsweise 30 oder 90 Tage.

Alternativ oder ergänzend wird eine maximale Anzahl an Einträgen beziehungsweise eine maximale Dateigröße unterstützt.

Das Audit-Log soll weiterhin dokumentieren:

* Zeitpunkt,
* Aktionstyp,
* abstrakte Ressourcenreferenz,
* Ziel,
* Entscheidung,
* Ergebnis,
* Fehlerkategorie,
* ausführenden Benutzer beziehungsweise Freigabekanal.

Nicht dauerhaft gespeichert werden sollen:

* vollständige Dokumentinhalte,
* vollständige Zusammenfassungen,
* Nachrichtentexte im Klartext,
* Zugangsdaten,
* Originaldateien,
* unnötige personenbezogene Metadaten.

## 15. Schutz gegen Approval Fatigue ergänzen

Da Rogue-Agent-Aufrufe eher zu vielen scheinbar legitimen Freigabeanfragen als zu lokalen kryptografischen Manipulationen führen, wird die Freigabelogik gegen Approval Fatigue gehärtet.

Das Gateway soll mindestens folgende Maßnahmen unterstützen:

* konfigurierbares Rate Limit für vorbereitete Aktionen,
* Begrenzung gleichzeitig offener Aktionen pro Agent oder Sitzung,
* Erkennung identischer oder nahezu identischer Aktionen,
* keine mehrfachen Benachrichtigungen für dieselbe Aktion,
* auffällige Darstellung neuer oder geänderter Empfänger,
* deutlicher Hinweis, dass Betreff und Nachricht vom Agenten vorgeschlagen wurden,
* feste Empfänger als bevorzugter Standard,
* zusätzliche Bestätigung bei erstmalig verwendeten dynamischen Empfängern.

Die Maßnahmen sollen verhindern, dass der Benutzer durch eine hohe Zahl an Freigabeanfragen zu einer unachtsamen Bestätigung verleitet wird.

---

# Nichtfunktionale Anforderungen

## Verständlichkeit

Der Kontrollfluss soll für Entwickler und Betreiber ohne kryptografisches Spezialwissen nachvollziehbar sein.

Der Standardprozess lautet:

1. Ressource suchen.
2. Ressource auswählen.
3. Aktion vorbereiten.
4. Snapshot lokal anzeigen.
5. Aktion freigeben oder ablehnen.
6. Freigegebenen Snapshot ausführen.
7. Ergebnis protokollieren.

## Fail-closed-Verhalten

Bei technischen Fehlern, ungültigen Modellantworten, unbekannten Ressourcen, abgelaufenen Aktionen oder fehlender Freigabe wird keine Information an Hermes oder ein externes Ziel übertragen.

## Wartbarkeit

Nicht verwendete Sicherheitsabstraktionen, Persistenzpfade, Migrationslogik und kryptografische Hilfsfunktionen werden entfernt, sofern sie nach der Vereinfachung keine aktive Funktion mehr besitzen.

Die verbleibenden Sicherheitsmechanismen sollen durch automatisierte Tests abgedeckt werden.

## Datenschutz

Die Vereinfachung darf nicht dazu führen, dass Hermes Originaldokumente, OCR-Volltexte, Zugangsdaten oder interne Quellinformationen erhält.

---

# Akzeptanzkriterien

## MCP- und Quellenzugriff

* Hermes kann keine Paperless-Werkzeuge direkt aufrufen.
* Hermes kann keine Dokumente löschen oder verändern.
* Hermes erhält ausschließlich opake Referenzen.
* Interne Quell-IDs und Zugangsdaten erscheinen nicht in MCP-Antworten.

## Aktionsvorbereitung

* Eine Aktion enthält einen unveränderlichen Snapshot.
* Änderungen an Empfänger, Ziel, Betreff, Text oder Anhängen erzeugen eine neue Aktion.
* Der Benutzer sieht alle für den Datenabfluss relevanten Informationen.
* Technische Hashes werden standardmäßig nicht angezeigt.

## Freigabe

* Ohne lokale Freigabe findet kein Datenabfluss statt.
* Hermes kann eine Aktion nicht selbst freigeben.
* Der Benutzer bestätigt den sichtbaren Snapshot über die action ID.
* Neue oder dynamische Empfänger werden besonders hervorgehoben.

## Neustartverhalten

* Alle offenen Aktionen verfallen bei einem Gateway-Neustart.
* Nach einem Neustart wird keine zuvor offene Aktion automatisch ausgeführt.
* Hermes muss eine neue Aktion vorbereiten.
* Temporäre Originaldateien werden nicht dauerhaft für offene Aktionen gespeichert.

## Interne Modellkommunikation

* Interne Modellprompts verwenden keine Nonces.
* Modellantworten werden weiterhin gegen ein festes Schema validiert.
* Dokumentinhalte werden ausdrücklich als nicht vertrauenswürdige Daten behandelt.
* Anweisungen aus Dokumenten können die Gateway-Policy nicht verändern.

## Zusammenfassungen

* Zusammenfassungen werden ausschließlich lokal erzeugt.
* Der Benutzer sieht den vollständigen Text vor der Weitergabe.
* Geheimnisse führen zu einer Sperre.
* URLs und normale technische Pfade erzeugen lediglich Warnungen.
* Hermes erhält nur den exakt freigegebenen Text.

## Telegram

* Telegram ist optional.
* Das Bot-Token wird über eine einfache geschützte Secret-Verwaltung bereitgestellt.
* Eine eigene verschlüsselte Telegram-Konfigurationsdatenbank ist nicht erforderlich.
* Telegram zeigt keine vollständigen sensiblen Dokumentinhalte.

## Audit

* Audit-Daten werden automatisch rotiert oder nach einer konfigurierbaren Frist gelöscht.
* Originaldokumente und sensible Volltexte werden nicht im Audit gespeichert.
* Sicherheitsrelevante Entscheidungen bleiben für einen begrenzten Zeitraum nachvollziehbar.

## Approval Fatigue

* Die Anzahl offener Aktionen ist begrenzt.
* Wiederholte identische Anfragen werden erkannt.
* Neue Empfänger sind visuell deutlich erkennbar.
* Der Agent kann den Benutzer nicht mit unbegrenzt vielen neuen Freigabeanfragen überfluten.

---

# Explizit zu entfernende oder zu vereinfachende Bestandteile

Folgende Bestandteile sollen überprüft und entfernt oder deutlich vereinfacht werden:

* Nonces in internen Modellprompts,
* Challenge-Response-Logik für lokale Modellantworten,
* Anzeige von Binding-Hashes und Anhangshashes in der normalen UI,
* Wiederherstellung und erneute Validierung offener Freigaben nach Neustarts,
* komplexe kryptografische Bindung als benutzerseitiges Freigabeverfahren,
* eigene AES-GCM-Konfigurationspersistenz für Telegram, sofern Betriebssystem-Secrets ausreichen,
* unbegrenzte Audit-Aufbewahrung,
* pauschale Ablehnung aller URLs und Dateipfade,
* eigene komplexe Browser-Sicherheitsmechanismen, wenn etablierte Framework-Standards dieselbe Funktion erfüllen,
* ungenutzte Kompatibilitäts- und Migrationslogik der entfernten Mechanismen.

---

# Explizit beizubehaltende Sicherheitsgrenzen

Folgende Sicherheitsgrenzen dürfen durch die Vereinfachung nicht entfernt werden:

* Trennung zwischen Hermes und privaten Datenquellen,
* read-only Quellenzugriff,
* opake und zeitlich begrenzte Referenzen,
* Zweckbindung von Referenzen,
* lokale Auswahl bei mehrdeutigen Treffern,
* Allowlist für Ziele,
* vollständige Anzeige von Empfänger, Nachricht und Anhängen,
* zwingende lokale Freigabe,
* strikte Eingabe- und Ausgabevalidierung,
* lokale Verarbeitung sensibler Dokumentinhalte,
* Egress-Kontrolle vor jeder Weitergabe,
* Schutz vor Secrets und Zugangsdaten,
* Größen-, Anzahl- und Dateityplimits,
* Fail-closed-Verhalten,
* begrenztes, datensparsames Audit.

---

# Erwartetes Ergebnis

Nach der Umsetzung bleibt das Gateway zuverlässig gegen die tatsächlich relevanten Risiken geschützt:

* Rogue-Agent-Aufrufe,
* unbeabsichtigte Dokumentauswahl,
* unkontrollierter Zugriff auf private Datenquellen,
* Versand an nicht erlaubte Ziele,
* Weitergabe sensibler Inhalte ohne menschliche Freigabe,
* Prompt Injection aus Dokumentinhalten,
* Überflutung des Benutzers mit Freigabeanfragen.

Gleichzeitig wird die Architektur einfacher, da Schutzmaßnahmen gegen nicht angenommene lokale Angreifer, manipulierte interne Kommunikation und wiederhergestellte historische Freigaben entfallen.

Die vereinfachte Sicherheitslogik soll leichter auditierbar, besser testbar und im laufenden Betrieb weniger fehleranfällig sein.
