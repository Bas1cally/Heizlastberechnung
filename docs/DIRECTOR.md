# Venice Director v1

Die Umsetzung von `docs/VENICE_DIRECTOR_SPEC.md` im selben Repo: gleiche
SQLite-Schicht (`node:sqlite`), gleicher TypeSafe-Client, gleicher
Env-Loader, gleiche Logger. Der Director läuft als eigener Prozess und rührt
die Bot-Tabellen und die `STOP`-Datei nicht an.

## Start

Doppelklick auf `director.cmd` im Projektordner startet Server und Seite.
Von Hand:

```powershell
cd C:\Users\Emanuel\Heizlastberechnung
git pull
pnpm install
pnpm director
```

Dann `http://127.0.0.1:8787` im Browser. Anderer Port: `pnpm director -- --port 9000`
oder `DIRECTOR_PORT` in `.env`.

`.env` (siehe `.env.example`): `VENICE_API_KEY` reicht für alles außer Jev.
Der Venice-Schlüssel bezahlt die Videos **und** das Textmodell hinter
Entwurf, Korrektur und Übersetzung (`VENICE_TEXT_MODEL`, Standard
`kimi-k2-6`, gemessen aus der Modellliste: 0,75 USD je Million
Eingabe-Tokens, 3,50 USD je Million Ausgabe-Tokens, also unter einem Cent
pro Entwurf). Wer stattdessen Anthropic direkt will, setzt
`TEXT_PROVIDER=anthropic` plus `ANTHROPIC_API_KEY`. `TYPESAFE_API_KEY` für
das Jev-Gate. Fehlt ein Schlüssel, ist nur der zugehörige Knopf aus.
`ffmpeg` und `ffprobe` müssen auf dem PATH liegen (oder `FFMPEG`/`FFPROBE`
in `.env`), sonst öffnet das Review ohne Frames und ohne Vergleichsbild.

**Stand 2026-09-22: das TypeSafe-Guthaben ist aufgebraucht (HTTP 402).** Der
Jev-Gate-Knopf ist sichtbar, liefert aber einen Fehler, bis Guthaben da ist.
Alles andere (Entwurf, Prompt bauen, Code-Checks) läuft ohne Jev;
eine Quote gibt es nur bei grünem Gate, also erst wieder mit Guthaben.

## Ablauf pro Shot

1. **Bibel**: Projekt, Stilguide (DE, EN per Textmodell-Übersetzung, gecacht
   nach sha256), Figuren mit festen Merkmalen, Referenzen hochladen
   (Bild/Video/Audio, Standardrolle, Consent-Objekt pro Referenz), Regeln
   R1–R10 an/aus, eigene Regeln ergänzen.
2. **Board**: Shot als Beat anlegen; Spalten = Status
   `draft → claude → gated → approved → queued → done → review → failed`.
3. **Karte**: Referenzen den Slots zuordnen (`Image 1`, `Image 2`, `Video 1`),
   dann „Entwurf erstellen“ (Fotos der genannten Figuren werden zugeordnet, das Textmodell füllt Einstellungsgröße, Kamerabewegung, Licht,
   Komposition, Aktion DE/EN; ein Aufruf, kein Verlauf, JSON-Schema,
   max 800 Output-Tokens), „Prüfen“ baut den Prompt (deterministisch, Reihenfolge
   Bindung → Einstellungsgröße → Kamerabewegung → Objektiv → Aktion → Licht →
   Komposition → Stil; Meta-Sätze werden entfernt), und lässt Jev prüfen (elf Fragen
   in einem Aufruf, englischer State nur mit den beteiligten Figuren; plus
   Code-Checks R1/R2/R3/R5/ENGINE/R9/R10). Verdict grün/gelb/rot mit
   Wahrscheinlichkeit je Frage. Gelb → „Korrigieren“ ändert nur die
   beanstandeten Felder, dann Gate erneut.
4. **Jobs**: „Angebot holen“ (nur bei grün) legt einen Job mit dem exakten
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

Kostenzähler in der Kopfzeile: Venice USD (freigegebene Jobs plus
Textmodell-Aufrufe, Preis aus der Modellliste), Anthropic Tokens/USD falls
genutzt, Jev-Aufrufe.

## Was gegen die echte API geprüft ist

Probe vom 2026-09-22 (`pnpm director:probe`): `GET /models` und
`POST /video/quote` antworten mit 200. Die Quote kommt als `{"quote": 0.44}`
(5 s T2V, 480p); der Parser nimmt dieses Feld zuerst. `GET /models` liefert
ohne Parameter nur Textmodelle, die Videomodelle kommen mit `?type=video`.
Die Textmodelle laufen über `POST /chat/completions` (OpenAI-Form) mit
`response_format` als JSON-Schema.

Noch nicht live gesehen: die Antworten von `/video/queue` und
`/video/retrieve` (Feldnamen `queue_id|id|job_id`, `status`,
`download_url|url` werden tolerant gelesen), ob Venice Referenzen als
base64-Data-URI annimmt (Standard hier; sonst Hook `referenceUrl`), und ob
`reasoning_effort` bei jedem Textmodell akzeptiert wird (ein 400 wird
einmal ohne das Feld wiederholt). Pfade und Feldnamen stehen gebündelt in
`ENDPOINTS` (`src/director/venice.ts`).

## Definition of Done (Spec §11) — Stand

| # | Punkt | Stand |
| --- | --- | --- |
| 1 | Projekt, Figur mit Identitätsreferenz, Stilguide | UI + API, getestet |
| 2 | Beat → Entwurf < 3.000 Input-Tokens | Aufruf ohne Verlauf; Tokens werden geloggt (`claude_call`), Grenze wird auf dem PC gemessen |
| 3 | Gate mit Wahrscheinlichkeiten; fehlende Kamerabewegung → rot | Getestet mit geskriptetem Jev; Latenz erst mit Guthaben messbar |
| 4 | Quote → Freigabe → Queue → Poll → Datei in `outputs/` | Getestet gegen einen Venice-Stub; Feldnamen siehe oben |
| 5 | Review-Vergleichsbild; Fail → neue Regel im nächsten Gate-State | Getestet (Regel im State); Vergleichsbild braucht ffmpeg |
| 6 | Extend ohne Video-Referenz verweigert; mit Referenz `reference_video_total_duration` | Builder getestet; Quote = Abrechnung erst live prüfbar |
| 7 | Kein Textmodell-Aufruf enthält eine frühere Antwort | Jeder Aufruf ist eine einzelne User-Nachricht aus Kartenfeldern; `request_json` liegt in `claude_call` zum Nachsehen |

## Dateien

- `src/director/schema.ts`, `repo.ts`, `types.ts` — Tabellen und Zugriffe
- `src/director/seed-rules.ts`, `vocabulary.ts`, `director/vocabulary.json`
- `src/director/prompt-builder.ts`, `code-checks.ts`, `jev-gate.ts`
- `src/director/claude.ts` (Anthropic), `text-venice.ts` (Textmodell auf Venice), `venice.ts`, `review.ts`, `engines.ts`
- `src/director/service.ts` — die Schritte hinter den Knöpfen
- `src/director/server.ts`, `ui-html.ts` — JSON-API und Seite
- `scripts/director.ts`, `scripts/director-probe.ts`
- `tests/unit/director/` — 47 Tests, alle ohne Netz
