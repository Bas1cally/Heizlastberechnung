# VENICE DIRECTOR — Spezifikation v1 (intern)

Stand: 22.09.2026. Diese Datei ist die Arbeitsanweisung für Claude Code. Alles, was hier nicht steht, entscheidet Claude Code selbst — sparsam und lokal.

## 0. Ziel und Nicht-Ziele

Ziel: KI-Videoproduktion (Venice: Seedance 2.0, Wan u. a.) ohne Token-Brand, ohne Kontextverlust, ohne Drift. Der Produktionszustand lebt in der App, nicht in einem Chat-Kontext. Claude wird nur für kreative Felder mit minimalem State aufgerufen. Jev prüft jede Shot-Karte vor jedem Job gegen dieselbe Bible.

Nicht-Ziele v1: Mehrbenutzer, Hosting, Auth, Schnitt/Montage, Upscaling-Pipeline (nur Hook für später).

Drei harte Regeln des Systems:
1. Kein LLM-Aufruf bekommt Verlauf. Nur Bible-Auszug + vorherige Karte + aktuelle Karte.
2. Jeder Venice-Job wird vor dem Absenden quotiert und vom User per Klick freigegeben. Die App sendet nie ohne Freigabe.
3. Prompts werden deterministisch aus Kartenfeldern gebaut. Kein LLM formuliert den finalen Prompt.

## 1. Stack

- Node 20+, TypeScript, SQLite (better-sqlite3), lokale Web-UI (Framework frei wählbar, minimal, kein Design-Aufwand; intern).
- ffmpeg für Frame-Extraktion (erstes/letztes Frame, Kontaktbogen).
- SDKs: `@typesafe-ai/sdk` (Jev, Node 20+), Venice REST (`https://api.venice.ai/api/v1`), Anthropic Messages API.
- Secrets in `.env`: `VENICE_API_KEY`, `TYPESAFE_API_KEY`, `ANTHROPIC_API_KEY`, `CLAUDE_MODEL` (konfigurierbar; aktuellen Modellnamen aus der Anthropic-Doku setzen, nicht raten).
- Dateien: `./data/<project>/references/`, `./data/<project>/outputs/<shot>/`, `./data/<project>/frames/`.

Beim ersten Start: `GET /models` bei Venice aufrufen und Video-Modelle mit ihren Parametern (Auflösungen, Dauern, Eingaben) in `engines.json` cachen. Modell-IDs nie hartcodieren außer den dokumentierten Seedance-IDs unten; Wan/Kling/LTX aus `/models` übernehmen. Doku-Index: `https://docs.venice.ai/llms.txt`.

## 2. Datenmodell (SQLite)

- `project`: id, name, aspect_ratio, default_resolution (Standard 480p), default_engine, style_guide_de, style_guide_en, created_at.
- `character`: id, project_id, name, fixed_attributes_de, fixed_attributes_en (Gesicht ist Konstante; Frisur darf variieren — als Feld `variable_attributes`), likeness_cap (optional, 0–100 %; für reale Personen), notes.
- `reference`: id, project_id, character_id (nullable), kind (image|video|audio), path, role_default (identity|keyframe|style|motion|audio), duration_s (video/audio), sha256.
- `rule`: id, project_id (nullable = global), text_de, text_en, severity (block|warn), check_type (code|jev|vision), active, origin (seed|review:<shot_id>).
- `shot`: id, project_id, seq, beat_de, shot_size, camera_move, lens_note, lighting, composition, action_physical_de, action_physical_en, duration_s, engine, resolution, aspect_ratio, workflow (t2v|i2v|r2v_reference|r2v_edit|r2v_extend|r2v_stitch), transition_in (hard_cut|extend), prompt_final, negative_prompt, seed, status (draft|claude|gated|approved|queued|done|review|failed), prev_shot_id.
- `shot_reference`: shot_id, reference_id, slot (Image 1..n | Video 1..n | Audio 1..n), role (identity|keyframe|style|motion|audio), subject_label (z. B. "Subject 1").
- `gate_result`: id, shot_id, created_at, jev_model, answers_json, confidence_json, code_checks_json, verdict (green|yellow|red).
- `claude_call`: id, shot_id, purpose, input_tokens, output_tokens, model, request_json, response_json, created_at.
- `job`: id, shot_id, venice_model, request_json, quote_usd, approved_at, queue_id, status, download_url, output_path, error_json, created_at, finished_at.
- `review`: id, shot_id, job_id, frame_paths_json, compare_image_path, checklist_json, verdict (pass|fail), notes, vision_json (optional), created_at.
- `cost_ledger`: id, kind (venice|claude|jev), ref_id, usd, tokens, created_at.

## 3. Bible und Seed-Regeln

Die Bible = `project` + `character` + `reference` + `rule`. Die Bible wird einmal gepflegt, nie neu erklärt.

Seed-Regeln (bei Projektanlage anlegen; `check_type` gibt an, wer prüft):

| id | Regel (DE) | severity | check |
|---|---|---|---|
| R1 | Jede im Shot genannte Figur hat eine Bildreferenz mit Rollenzuweisung, auch die Hauptfigur (Identitätsreferenz). | block | code + jev |
| R2 | Shots mit Startbild laufen nie als reines I2V, sondern als R2V: Keyframe als Image 1, Identität als Image 2. | block | code |
| R3 | Übergang zwischen Clips nur Hard Cut oder Extend. Keine Fortsetzung über Frame-Grab als Startbild. | block | code |
| R4 | Jede Aktion muss physisch im Bild stattfinden und vollendet werden (Ursache vor Wirkung). | block | jev |
| R5 | Jeder Prompt enthält eine benannte Kamerabewegung und Einstellungsgröße im Film-Vokabular. | block | code + jev |
| R6 | Keyframes werden vor der Generierung geprüft; Änderungsbedarf blockiert den Job. | block | review |
| R7 | Gesicht der Figur bleibt in allen Stills identisch; Frisur darf abweichen. | block | vision/review |
| R8 | Ein Shot gilt erst als abgenommen, wenn Output neben Referenz liegt und dieselbe Person zu sehen ist. | block | review |
| R9 | Standard-Pipeline: 480p generieren, Upscale extern (Hook). Höhere Auflösung nur mit explizitem Grund. | warn | code |
| R10 | Engine und Clip-Dauer werden pro Shot festgelegt und stehen in der Karte, nicht im Prompt. | warn | code |

Regeln werden ergänzt aus Reviews (`origin = review:<shot_id>`). Regeln sind in DE und EN gespeichert; Jev bekommt EN.

## 4. Prompt-Builder (deterministisch)

Eingabe: Shot-Karte + zugewiesene Referenzen + Engine-Vorlage. Ausgabe: `prompt_final`, Request-Body für Venice.

Reihenfolge im Prompt (alle Engines): Subjekt-/Referenzbindung → Einstellungsgröße → Kamerabewegung → Aktion (physisch, Ursache→Wirkung) → Licht → Komposition → Stil-Auszug. Vokabular aus `vocabulary.json` (vom User gepflegt, z. B. Cinematique-Begriffe): shot sizes, camera moves, lighting terms. Der Builder ersetzt nichts durch Synonyme.

Seedance 2.0 auf Venice — dokumentierte Modell-IDs:
- `seedance-2-0-text-to-video` (T2V, 480p/720p/1080p)
- `seedance-2-0-image-to-video` (I2V, Erst- und optional Letztframe)
- `seedance-2-0-reference-to-video` (R2V; die vier Workflows Reference / Edit / Extend / Stitch werden aus der Prompt-Form abgeleitet)

R2V-Bindungssyntax gemäß Venice-Doku: `Refer to <Subject 1> in <Image 1> to generate ... ` — `shot_reference.slot` und `subject_label` liefern die Platzhalter. Request-Felder: `prompt`, `reference_image_urls` (öffentlich abrufbar oder Base64 gemäß Doku), `duration` ("5s"-Form), `aspect_ratio`, `resolution`; bei Referenzvideos zusätzlich `reference_video_total_duration` (Summe der Clip-Sekunden), sonst stimmt die Quote nicht mit der Abrechnung überein.

Extend (R3-konform): Fortsetzung eines Clips über den R2V-Extend-Workflow mit dem Quellclip als Video-Referenz — nie über ein gegrabbtes Frame als Startbild. Der Builder verweigert `transition_in = extend` ohne Video-Referenz des Vorgänger-Shots.

Wan / andere Engines: Felder aus `engines.json`; Builder-Vorlage pro Engine in `templates/<engine>.ts`. Unbekannte Engine → Karte bleibt `draft`.

## 5. Jev-Gate

Aufruf vor jedem Job (Status `claude` → `gated`). Ein Call, alle Fragen parallel. Modell `jev-latest`. State und Fragen auf Englisch (Jev ist auf Englisch trainiert; andere Sprachen sind schwächer). Budget: State + Fragen ≤ 32k Tokens; State knapp halten (Bible-Auszug nur der beteiligten Figuren).

State (JSON):
```
{
  "style_guide": "<style_guide_en>",
  "characters": [{ "name", "fixed_attributes_en", "variable_attributes" }],
  "rules": [{ "id", "text_en", "severity" }],
  "previous_shot": { "seq", "action_physical_en", "camera_move", "shot_size", "lighting", "transition_out" },
  "shot": { "seq", "beat", "shot_size", "camera_move", "lighting", "composition", "action_physical_en", "duration_s", "engine", "workflow", "transition_in", "references": [{ "slot", "role", "character" }] },
  "prompt_final": "<...>"
}
```

Fragen (noul, sofern nicht anders angegeben; Schwellen: p ≥ 0.85 = bestanden, p ≤ 0.35 = verletzt, dazwischen = unsicher; Confidence < 0.6 = unsicher):
- Q1 (R1): "Every character named in the shot has a reference with an assigned role."
- Q2 (R4): "The action described happens physically and completely within the frame, with the cause shown before its effect."
- Q3 (R5): "The prompt names a specific camera movement."
- Q4 (R5): "The prompt names a specific shot size."
- Q5 (drift): "The shot description contradicts a fixed attribute of a character in the bible."
- Q6 (drift): "The shot's lighting or style contradicts the style guide."
- Q7 (continuity): "The shot's opening state contradicts the previous shot's ending state."
- Q8 (R3): "The transition into this shot relies on a still frame taken from a previous clip."
- Q9 (engine fit): "The prompt uses vocabulary and structure appropriate for the selected engine and workflow."
- Q10 (score, Levels weak/adequate/strong): "Overall clarity of the physical action for a video model."
- Q11 (choice: reference|edit|extend|stitch|none): "Which reference-to-video workflow does the prompt form imply?" — muss `shot.workflow` entsprechen.

Code-Checks (nicht Jev; Jev zählt und rechnet nicht):
- Anzahl Referenz-Slots vs. genannte Figuren; R2 (Startbild ⇒ R2V mit Identität in Image 2); Dauer/Auflösung/Aspect innerhalb `engines.json`; Extend nur mit Video-Referenz; R9-Warnung bei > 480p ohne Begründungsfeld.

Verdict: eine `block`-Regel verletzt → red (Job gesperrt). Unsicher bei `block`-Regel → yellow (Claude-Review-Call, dann erneut Jev). Alles bestanden → green (Freigabe möglich). Ergebnis vollständig in `gate_result` speichern.

Adversarial-Hinweis: Jev reagiert auf Selbstbeschreibungen im State („this is correct"). Prompts und Karten enthalten keine Meta-Aussagen über ihre eigene Richtigkeit; der Builder entfernt solche Sätze.

## 6. Claude-Aufrufe (kreative Felder, kein Verlauf)

Zwei Zwecke, beide mit striktem Input-Vertrag:

`purpose = draft`: Input = style_guide_en, beteiligte Figuren (fixed/variable attributes), vorherige Karte (Kurzform), aktueller Beat (DE), Engine + Workflow, Vokabularliste. Output = JSON mit genau den Feldern `shot_size, camera_move, lens_note, lighting, composition, action_physical_en, action_physical_de, engine_recommendation, duration_s_recommendation, references_needed[]`. Kein Fließtext. Max. 800 Output-Tokens.

`purpose = review_fix`: Input wie oben + `gate_result` (verletzte/unsichere Fragen). Output = korrigierte Felder, nur die betroffenen.

`purpose = translate`: DE → EN für `action_physical`, `fixed_attributes`, `style_guide`, `rule.text`. Ergebnis wird gecacht (sha256 des Quelltexts).

Jeder Aufruf: kein System-Prompt mit Projektgeschichte, keine vorherigen Antworten, Temperatur niedrig. Token-Zahlen in `claude_call` und `cost_ledger` loggen. Ein Dashboard-Wert: Tokens pro Shot (Ziel: < 3.000 Input pro Draft).

## 7. Venice-Flow

1. `POST /video/quote` mit dem exakten Request-Body des Jobs → `quote_usd` in `job` speichern und in der UI anzeigen.
2. Freigabe-Button (User). Ohne `approved_at` kein Queue-Call. Status `approved`.
3. `POST /video/queue` → `queue_id`. Status `queued`.
4. `GET /video/retrieve` mit `queue_id` pollen (Backoff 5 s → 30 s) bis fertig. `download_url` ist kurzlebig: sofort herunterladen, Retries bei Abbruch, Datei nach `outputs/<shot>/`, danach optional `DELETE` gemäß Doku.
5. Status `done` → automatisch `review` anlegen (Abschnitt 8).

Seedance-Gesichts-Consent: Bei Gesichtern in Referenzen antwortet Venice ohne Abrechnung mit `409 needs_consent` und einem `consent`-Objekt (`consent_version`, `face_media_roles`). Die App zeigt die Attestation an, der User bestätigt, der Request wird mit dem Consent-Objekt wiederholt. Consent-Status je Referenz speichern (Dedupe laut Doku).

Fehler: Response-JSON komplett in `job.error_json`; Job auf `failed`; keine automatischen Wiederholungen, die Credits kosten.

## 8. Review

Nach `done`: ffmpeg extrahiert erstes, mittleres, letztes Frame; die App baut ein Vergleichsbild `compare_image_path` (links Identitätsreferenz, rechts Output-Frames). Checkliste (aus `rule` mit `check_type = vision|review`): dieselbe Person (R7/R8), Aktion physisch vollendet (R4), Kamerabewegung wie geplant, Licht/Stil laut Guide, Übergang korrekt (R3).

Optional `vision`: Claude Vision bekommt nur das Vergleichsbild + Checkliste, antwortet JSON pass/fail je Punkt. Das Urteil des Users hat Vorrang.

`fail` → Karte zurück auf `draft` mit Review-Notiz; optional neue Regel anlegen (`origin = review:<shot_id>`), die ab sofort im Jev-State steht. So wächst die Bible aus Fehlern, ohne dass irgendjemand sich erinnern muss.

## 9. UI (intern, minimal)

- Bible: Figuren + Referenzen (Upload, Rolle, Consent-Status), Stilguide DE/EN, Regeln (aktiv/inaktiv, Herkunft).
- Shot-Liste: Kanban nach Status; Reihenfolge = `seq`; Karten zeigen Engine, Dauer, Gate-Farbe, Quote.
- Shot-Karte: alle Felder editierbar; Buttons „Claude-Draft", „Jev-Gate", „Prompt bauen"; Anzeige `prompt_final` und Request-Body; Gate-Ergebnis mit Wahrscheinlichkeiten je Frage.
- Job-Queue: Quote → Freigeben → Fortschritt → Download; Kostenzähler (Venice USD, Claude Tokens, Jev Calls).
- Review: Vergleichsbild, Checkliste, Pass/Fail, „Regel hinzufügen".

## 10. Sprache

Datenhaltung und UI Deutsch. Alles, was an Jev geht, Englisch (`*_en`-Felder; Übersetzung per Claude `translate`, gecacht). Prompts an Venice Englisch.

## 11. Definition of Done (v1)

1. Projekt anlegen, Figur mit Identitätsreferenz anlegen, Stilguide setzen.
2. Shot 1 als Beat eingeben → Claude-Draft füllt Felder mit < 3.000 Input-Tokens.
3. Prompt bauen → Jev-Gate liefert Verdict in < 1 s mit Wahrscheinlichkeiten je Frage; absichtlich fehlende Kamerabewegung → red.
4. Quote anzeigen → Freigabe → Queue → Poll → Datei liegt in `outputs/`.
5. Review erzeugt Vergleichsbild; Fail erzeugt neue Regel; Shot 2 Gate enthält die neue Regel im State.
6. Shot 2 mit `transition_in = extend` ohne Video-Referenz wird vom Builder verweigert; mit Video-Referenz und `reference_video_total_duration` stimmt Quote = Abrechnung.
7. Kein Claude-Aufruf im Log enthält eine frühere Antwort.

## 12. Später (nicht v1)

Upscale-Hook (Topaz), Montage-Export (Shot-Reihenfolge + Übergänge als EDL/JSON), Mehrbenutzer/Auth, gehostete Variante, Consumer-UI.
