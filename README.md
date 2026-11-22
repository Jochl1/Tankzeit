# Tanken oder Warten?

Mobile Web-App, die sagt, ob du **jetzt tanken** oder **besser warten** solltest, und das begründet:
mit dem typischen Tagesverlauf seit der 12-Uhr-Regel, den günstigsten Tankstellen in der Nähe,
dem Wochentagseffekt und einer Einordnung des Ölpreises.

- Rein statisch (GitHub Pages): kein Server, keine geplanten GitHub Actions
- Bring-your-own-Key: Jede Person nutzt ihren eigenen, kostenlosen Tankerkönig-API-Key. Der Key bleibt auf dem Gerät.
- Als PWA installierbar und offline nutzbar (zeigt dann die zuletzt geladenen Preise)
- Die App lernt aus deinen eigenen Abfragen, wie sich die Preise in deiner Gegend verhalten (IndexedDB, nur lokal)
- Demo-Modus ohne Key

---

## 1. API-Key besorgen

1. Auf **https://onboarding.tankerkoenig.de** einen Key beantragen. Echter Vor- und Nachname, Kategorie z. B. „private Website“.
2. Tankerkönig prüft die Anfrage von Hand, der Key kommt per E-Mail. Das kann etwas dauern.
3. App öffnen, Key einfügen, fertig.

Der Key wird nur im `localStorage` des Browsers gespeichert und nur direkt an
`creativecommons.tankerkoenig.de` gesendet. In den Einstellungen lässt er sich ändern oder löschen.

**Warum ein eigener Key?** Die freie Tankerkönig-API erlaubt etwa eine Abfrage pro Minute und Key.
Ein gemeinsamer Key für alle Nutzer würde sofort gesperrt. Einen öffentlichen Proxy mit geteiltem Key
gibt es deshalb bewusst nicht.

## 2. Lokal starten

```bash
python3 -m http.server 8765 -d app
# dann http://localhost:8765 öffnen, "Erst mal die Demo ansehen" funktioniert ohne Key
```

Es gibt keinen Build-Schritt und keine Abhängigkeiten: Vanilla JS (ES-Module), eigene SVG-Charts.

Browser-Tests (Playwright, simulierte Tankerkönig-API):

```bash
python3 -m http.server 8765 -d app &
TZ=Europe/Berlin node tests/e2e-ablauf.cjs   # Onboarding, PLZ-Fallback, Einstellungen, Theme, offline, Löschen
TZ=Europe/Berlin node tests/e2e-lernen.cjs   # 14 Tage Abfragen simulieren, lernt eine abweichende Tankstelle
```

## 3. Deploy auf GitHub Pages

1. Im Repo unter **Settings → Pages → Build and deployment → Source** „**GitHub Actions**“ wählen (einmalig).
2. Auf `main` pushen bzw. mergen. Der Workflow `.github/workflows/pages.yml` veröffentlicht den Ordner `app/`.
   Manuell starten geht über *Actions → Deploy auf GitHub Pages → Run workflow*.

Der Workflow läuft **nur bei Push** (oder manuell), es gibt keinen Zeitplan.
Die App ist danach unter `https://<user>.github.io/tankzeit/` erreichbar.

---

## Wie die Empfehlung entsteht

### Tagesverlauf (der wichtigste Faktor)
Seit dem **1. April 2026** dürfen Tankstellen in Deutschland die Preise **nur noch einmal täglich um 12 Uhr erhöhen**,
senken dürfen sie jederzeit. Laut ADAC (Auswertung Mai 2026, über 14.000 Tankstellen):

- am günstigsten **kurz vor 12 Uhr**: E10 ca. 3,7 ct/l, Diesel ca. 4,3 ct/l unter dem Tagesmittel
- um 12 Uhr ein Sprung von durchschnittlich **+14,6 ct/l (E10)** bzw. **+18,4 ct/l (Diesel)**
- danach sinkt der Preis langsam, gegen 17:30 Uhr liegt er unter dem Tagesmittel; kleine Anstiege um 22 und 24 Uhr; ab 5 Uhr wird es wieder günstiger

Daraus ist das **Startprofil** `app/data/generic-profile.json` abgeleitet (30-Minuten-Raster, Zwischenwerte interpoliert).
Es ist eine Schätzung, keine Messung.

### Lernen aus eigenen Abfragen
Jede Abfrage speichert die Preise aller Tankstellen im Umkreis (meist ca. 20) in IndexedDB. Daraus lernt die App:

- pro Tankstelle und Tag das Preisniveau, und welche Uhrzeiten *systematisch* vom Profil abweichen
  (regional und pro Tankstelle, geschrumpft je nach Datenmenge, Nachbar-Slots teilen Information, nie über die 12-Uhr-Grenze)
- den **Wochentagseffekt**, sobald Daten von mindestens 14 Tagen vorliegen. Vorher gilt jeder Tag als gleich,
  weil es seit der 12-Uhr-Regel keine belastbaren Auswertungen dazu gibt.

So erkennt die App z. B. Tankstellen, die sich nicht an die 12-Uhr-Regel halten (laut ZDF ca. 20 %) oder abends am günstigsten sind.

### Entscheidungsregel (`app/js/decision.js`)
Für jede Tankstelle im Umkreis wird der Preis der nächsten 7 Tage im 30-Minuten-Raster fortgeschrieben
(nur 6–22 Uhr als Tankzeit). Dann gilt:

- **Warten**, wenn das beste künftige Fenster mindestens **1,5 ct/l** günstiger ist als der günstigste offene Preis jetzt.
  Jeder weitere Tag Warten muss sich zusätzlich mit 0,7 ct/l lohnen.
- sonst **Jetzt tanken**, mit Zeitfenster („günstig bis ca. 11:55 Uhr“) und Begründung
  (Erhöhung naht, aktuell schon am günstigsten oder Ersparnis zu klein).
- angezeigt werden immer: Zeitfenster, Tankstelle (Tippen öffnet die Navigation), Ersparnis in ct/l und in € pro Tankfüllung, Datenstand.
- liegt das beste Fenster erst morgen, nennt die App zusätzlich die beste Alternative noch heute.
- **Bekannte Termine** (z. B. eine offiziell beschlossene CO₂-Preis- oder Steueränderung) lassen sich in
  `app/data/events.json` eintragen und fließen dann in die Entscheidung ein. Die Liste ist aktuell leer.

Die App vergleicht ihre früheren Empfehlungen mit später beobachteten Preisen und zeigt die eigene Trefferquote an.

### Ölpreis: nur Erklärung, kein Signal
`tools/oil_analysis.py` untersucht 2015–2026 (601 Wochen; EU Weekly Oil Bulletin, deutsche Preise ohne Steuern,
Brent und EUR/USD):

| | Super E5 | Diesel |
|---|---|---|
| Brent-**Anstieg**: Weitergabe in der 1. Woche | ca. 93 % | über 100 % |
| Brent-**Rückgang**: Weitergabe in der 1. Woche | ca. 47 % | ca. 45 % |
| 80 % eines Rückgangs weitergegeben nach | ca. 4,2 Wochen | ca. 4,8 Wochen |

„Rockets and Feathers“ ist also deutlich: Anstiege kommen nach wenigen Tagen an der Säule an, Rückgänge brauchen etwa einen Monat.

**Prognosetest** (rollierend ab 2020, nur mit damals bekannten Daten): Die Information steckt in den *letzten 2–3 Tagen*.
Mit tagesaktuellen Benzin-Großhandelspreisen wären Richtungsprognosen in starken Wochen zu ca. 64 % richtig.
Frei und browsertauglich gibt es Ölpreise aber nur mit **3–5 Tagen Verzögerung** (EIA, FRED). Damit fällt die
Korrelation auf **≈ 0**. Der Ölpreis wird deshalb nur zur Erklärung angezeigt und hat in der Entscheidung das Gewicht 0.

---

## Profile neu berechnen (optional, sobald Tankerkönig-Historie verfügbar)

Die Historiendaten (jede Preisänderung jeder Tankstelle) gibt es als Git-Repo bei Tankerkönig. Der **Zugang ist nur
nach Registrierung und Prüfung** möglich (Anmeldung über https://onboarding.tankerkoenig.de, bei bestehendem Account
Mail an info@tankerkoenig.de). Lizenz der Historie: **CC BY-NC-SA 4.0**, nur nichtkommerziell. Die daraus berechneten Kacheln erben diese Lizenz.

```bash
# nur die benötigten Ordner holen (Adresse aus der Freischaltungs-Mail)
git clone --filter=blob:none --sparse <REPO-URL> ~/tankerkoenig-data
cd ~/tankerkoenig-data && git sparse-checkout set prices/2026 stations/2026 && cd -

pip install pandas numpy
python3 tools/build_profiles.py --data ~/tankerkoenig-data --plz 04 --since 2026-04-01
git add app/data/profiles && git commit -m "Profile aktualisiert" && git push
```

- `--plz 04`: PLZ-Bereich(e), z. B. `--plz 04 06` für Leipzig und Halle. Ohne Angabe: ganz Deutschland.
- `--since 2026-04-01`: bewusst erst ab der 12-Uhr-Regel, ältere Daten zeigen ein anderes Muster.
- Ergebnis: `app/data/profiles/index.json` und eine Kachel pro 2-stelliger PLZ (Werte in 1/10 ct, gzip-freundlich).
  Die App lädt nur die Kacheln der Tankstellen in der Nähe.
- Das Skript berechnet auch einen **Backtest** (Regel vs. sofort tanken auf den letzten 28 Tagen), den die App dann anzeigt.
- Erneut ausführen reicht alle paar Monate, die Profile ändern sich langsam. Die App funktioniert auch ohne Kacheln.

Ohne Zugang lässt sich das Skript mit synthetischen Daten testen:

```bash
python3 tools/make_synthetic_history.py --out /tmp/tk-synth --days 70
python3 tools/build_profiles.py --data /tmp/tk-synth --plz 04 --out /tmp/tk-profiles
```

(Synthetische Ergebnisse nicht committen, sie sind ausgedacht.)

## Ölpreis-Auswertung aktualisieren

```bash
python3 tools/oil_analysis.py   # lädt Oil Bulletin, FRED und EZB, schreibt app/data/oil-model.json
```

---

## Datenquellen und Lizenzen

| Was | Quelle | Lizenz/Hinweis |
|---|---|---|
| Live-Preise | [Tankerkönig](https://www.tankerkoenig.de) / MTS-K des Bundeskartellamts | CC BY 4.0, Quellenangabe in der App |
| Preishistorie (optional) | Tankerkönig-Daten-Repo | CC BY-NC-SA 4.0, Zugang nach Registrierung |
| Tagesverlauf seit 12-Uhr-Regel | [ADAC](https://www.adac.de/verkehr/tanken-kraftstoff-antrieb/tipps-zum-tanken/spritpreise-tagesverlauf/) | als Quelle genannt |
| Spritpreise ohne Steuern (wöchentlich) | [EU Weekly Oil Bulletin](https://energy.ec.europa.eu/data-and-analysis/weekly-oil-bulletin_en) | |
| Brent, NY-Harbor-Benzin/Heizöl | [FRED](https://fred.stlouisfed.org) | |
| EUR/USD | [EZB-Datenportal](https://data.ecb.europa.eu) | |
| PLZ/Ort → Koordinaten | [Nominatim / OpenStreetMap](https://nominatim.org) | ODbL, nur auf Nutzeraktion |

Tankerkönig-Nutzungsbedingungen, an die sich die App hält: Abfragen nur auf Nutzeraktion bzw. beim Öffnen
(kein Dauer-Polling), automatische Aktualisierung höchstens alle 5 Minuten, manuell höchstens einmal pro Minute,
Radius höchstens 25 km. Nicht erlaubt ist die Nutzung durch Mineralölunternehmen und deren IT-Dienstleister.

## Datenschutz

- Kein eigener Server, kein Tracking.
- API-Key, Einstellungen und Preisbeobachtungen liegen nur im Browser (`localStorage`/IndexedDB).
  „Key und alle Daten löschen“ entfernt alles.
- Standortkoordinaten gehen nur an Tankerkönig (Umkreissuche), eine eingegebene PLZ nur an Nominatim.

## Grenzen

- Das Startprofil ist ein **Durchschnitt** aus der ADAC-Beschreibung. Einzelne Tankstellen weichen ab, bis die App genug gelernt hat.
- Öffnungszeiten werden nur als „jetzt geöffnet/geschlossen“ berücksichtigt. Ob eine Tankstelle im empfohlenen Fenster geöffnet hat, wird nicht geprüft.
- Kurzfristige Marktbewegungen (Ölpreisschocks, Feiertage) sieht die App nicht voraus.
- Wochentagseffekt erst nach mindestens 14 Tagen eigener Daten (oder mit Kacheln).
- Alle Angaben sind Schätzungen, ohne Gewähr.

## Mögliche Erweiterungen

- **Optionaler Key für tagesaktuelle Ölpreise.** Mit Daten ohne Verzögerung hätte das Signal einen messbaren Nutzen
  (Benzin-Großhandel → E5: Korrelation ca. 0,30; bei starkem Signal, ca. jede 5. Woche, ca. 64 % Richtungstreffer,
  Größenordnung ±2 ct/l). Kandidat: [OilPriceAPI](https://www.oilpriceapi.com) (Brent und Benzin, CORS erlaubt, Key nötig;
  Konditionen und Gratiskontingent vor dem Einbau prüfen). Umsetzung wie beim Tankerkönig-Key: optional, nur lokal
  gespeichert, das Gewicht des Faktors wird per Backtest bestimmt.
- Kacheln für weitere Regionen, sobald der Historienzugang da ist.
- Öffnungszeiten über `detail.php` berücksichtigen (kostet je Tankstelle eine Abfrage, also nur für die empfohlene).

## Projektstruktur

```
app/                    statische Web-App (wird deployt)
  index.html, styles.css, sw.js, manifest.webmanifest, icons/
  js/   app.js (Steuerung) · api.js · decision.js · profile.js · store.js · charts.js · format.js · demo.js
  data/ generic-profile.json · oil-model.json · events.json · profiles/
tools/  oil_analysis.py · build_profiles.py · make_synthetic_history.py
tests/  Playwright-Tests
.github/workflows/pages.yml
```
