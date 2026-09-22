# Venice Director v1

Die Umsetzung von `docs/VENICE_DIRECTOR_SPEC.md` im selben Repo: gleiche
SQLite-Schicht (`node:sqlite`), gleicher TypeSafe-Client, gleicher
Env-Loader, gleiche Logger. Der Director läuft als eigener Prozess und rührt
die Bot-Tabellen und die `STOP`-Datei nicht an.

## Start (PowerShell)

```powershell
cd C:\Users\Emanuel\Heizlastberechnung
git pull
pnpm install
pnpm director
```

Dann `http://127.0.0.1:8787` im Browser. Anderer Port: `pnpm director -- --port 9000`
oder `DIRECTOR_PORT` in `.env`.

`.env` (siehe `.env.example`): `VENICE_API_KEY`, `ANTHROPIC_API_KEY`,
`CLAUDE_MODEL` (Standard `claude-opus-5`), `TYPESAFE_API_KEY`. Fehlt ein
Schlüssel, ist nur der zugehörige Knopf aus; der Rest läuft. `ffmpeg` und
`ffprobe` müssen auf dem PATH liegen (oder `FFMPEG`/`FFPROBE` in `.env`),
sonst öffnet das Review ohne Frames und ohne Vergleichsbild.

**Stand 2026-09-22: das TypeSafe-Guthaben ist aufgebraucht (HTTP 402).** Der
Jev-Gate-Knopf ist sichtbar, liefert aber einen Fehler, bis Guthaben da ist.
Alles andere (Claude-Entwurf, Prompt bauen, Code-Checks) läuft ohne Jev;
eine Quote gibt es nur bei grünem Gate, also erst wieder mit Guthaben.

## Ablauf pro Shot

1. **Bibel**: Projekt, Stilguide (DE, EN per Claude-Übersetzung, gecacht
   nach sha256), Figuren mit festen Merkmalen, Referenzen hochladen
   (Bild/Video/Audio, Standardrolle, Consent-Objekt pro Referenz), Regeln
   R1–R10 an/aus, eigene Regeln ergänzen.
2. **Board**: Shot als Beat anlegen; Spalten = Status
   `draft → claude → gated → approved → queued → done → review → failed`.
3. **Karte**: Referenzen den Slots zuordnen (`Image 1`, `Image 2`, `Video 1`),
   dann `1 · Claude-Entwurf` (füllt Einstellungsgröße, Kamerabewegung, Licht,
   Komposition, Aktion DE/EN; ein Aufruf, kein Verlauf, JSON-Schema,
   max 800 Output-Tokens), `2 · Prompt bauen` (deterministisch, Reihenfolge
   Bindung → Einstellungsgröße → Kamerabewegung → Objektiv → Aktion → Licht →
   Komposition → Stil; Meta-Sätze werden entfernt), `3 · Jev-Gate` (elf Fragen
   in einem Aufruf, englischer State nur mit den beteiligten Figuren; plus
   Code-Checks R1/R2/R3/R5/ENGINE/R9/R10). Verdict grün/gelb/rot mit
   Wahrscheinlichkeit je Frage. Gelb → `3b · Claude-Korrektur` ändert nur die
   beanstandeten Felder, dann Gate erneut.
4. **Jobs**: `4 · Venice-Quote` (nur bei grün) legt einen Job mit dem exakten
   Request-Body an. **Freigeben** ist der Klick, ohne den nichts an Venice
   geht. Dann **An Venice senden** (queue), **Status abfragen** (ein
   Retrieve pro Klick; die Service-Schicht kann auch mit Backoff 5→30 s
   warten), Download nach `data/director/<projekt>/outputs/<shot>/`.
   409 `needs_consent` legt den Job auf `needs_consent`; der Knopf in der
   Job-Liste zeigt Venices Antwort, nimmt das Consent-Objekt entgegen und
   holt die Quote erneut.
5. **Review**: erster/mittlerer/letzter Frame, Vergleichsbild (Identität
   links, Frames rechts), Checkliste aus den Vision/Review-Regeln, Pass/Fail,
   optional neue Regel (Herkunft `review:<shot>`), die ab sofort im
   Gate-State jedes weiteren Shots steht. Fail schickt die Karte mit Notiz
   zurück auf `draft`.

Kostenzähler in der Kopfzeile: Venice USD (Quotes freigegebener Jobs),
Claude Tokens/USD (Preistabelle `CLAUDE_USD_PER_MTOKEN_IN/OUT`), Jev-Aufrufe.

## Was nicht verifiziert ist

Die Venice-Doku war aus der Entwicklungsumgebung nicht erreichbar. Pfade und
Feldnamen stehen gebündelt in `ENDPOINTS` (`src/director/venice.ts`); die
Antworten werden tolerant gelesen (`quote_usd|price_usd|usd|cost`,
`queue_id|id|job_id`, `download_url|url`, Status-Wörter). Bevor der erste
echte Job läuft:

```powershell
cd C:\Users\Emanuel\Heizlastberechnung
pnpm director:probe -- --image C:\Pfad\zu\referenz.png
```

Das ruft nur `GET /models` und `POST /video/quote` (kostenlos) und schreibt
`reports/venice-probe.json`. Weichen Feldnamen ab, werden `ENDPOINTS` und
die Parser angepasst; die Logik bleibt.

Ebenso unverifiziert: ob Venice Referenzen als base64-Data-URI annimmt
(Standard hier) oder öffentliche URLs verlangt; dafür gibt es den Hook
`referenceUrl` im `VeniceClient`.

## Definition of Done (Spec §11) — Stand

| # | Punkt | Stand |
| --- | --- | --- |
| 1 | Projekt, Figur mit Identitätsreferenz, Stilguide | UI + API, getestet |
| 2 | Beat → Claude-Draft < 3.000 Input-Tokens | Aufruf ohne Verlauf; Tokens werden geloggt (`claude_call`), Grenze wird auf dem PC gemessen |
| 3 | Gate mit Wahrscheinlichkeiten; fehlende Kamerabewegung → rot | Getestet mit geskriptetem Jev; Latenz erst mit Guthaben messbar |
| 4 | Quote → Freigabe → Queue → Poll → Datei in `outputs/` | Getestet gegen einen Venice-Stub; Feldnamen siehe oben |
| 5 | Review-Vergleichsbild; Fail → neue Regel im nächsten Gate-State | Getestet (Regel im State); Vergleichsbild braucht ffmpeg |
| 6 | Extend ohne Video-Referenz verweigert; mit Referenz `reference_video_total_duration` | Builder getestet; Quote = Abrechnung erst live prüfbar |
| 7 | Kein Claude-Aufruf enthält eine frühere Antwort | Jeder Aufruf ist eine einzelne User-Nachricht aus Kartenfeldern; `request_json` liegt in `claude_call` zum Nachsehen |

## Dateien

- `src/director/schema.ts`, `repo.ts`, `types.ts` — Tabellen und Zugriffe
- `src/director/seed-rules.ts`, `vocabulary.ts`, `director/vocabulary.json`
- `src/director/prompt-builder.ts`, `code-checks.ts`, `jev-gate.ts`
- `src/director/claude.ts`, `venice.ts`, `review.ts`, `engines.ts`
- `src/director/service.ts` — die Schritte hinter den Knöpfen
- `src/director/server.ts`, `ui-html.ts` — JSON-API und Seite
- `scripts/director.ts`, `scripts/director-probe.ts`
- `tests/unit/director/` — 42 Tests, alle ohne Netz
