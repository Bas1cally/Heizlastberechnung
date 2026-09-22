# TFT-Berater (Spaßprojekt, Jev-Anwendungsfall)

Screenshot → Vision-Modell auf Venice liest Board, Bank, Shop, Gold, Level,
Stage → Jev wählt Comp und Aktion (vier Fragen, ein Aufruf) → ein kleines
Overlay zeigt drei Zeilen. Ohne Jev-Guthaben antwortet ein Textmodell auf
Venice auf dieselben Fragen. Es wird nur der Bildschirm gelesen; kein
Speicherzugriff, keine Eingaben ins Spiel.

## Start

Doppelklick auf `tft.cmd` im Projektordner. Das holt den neuesten Stand,
startet den Berater in einem Fenster „TFT-Berater“, das Overlay (immer im
Vordergrund, per Maus verschiebbar, Rechtsklick schließt es) und die
Browserseite. `tft-stop.cmd` beendet Berater und Overlay wieder (oder das
Fenster „TFT-Berater“ schließen und das Overlay per Rechtsklick).

Von Hand, falls nötig (PowerShell, zwei Fenster):
```powershell
cd C:\Users\Emanuel\Heizlastberechnung
pnpm tft
```
```powershell
cd C:\Users\Emanuel\Heizlastberechnung
powershell -ExecutionPolicy Bypass -File scripts\tft-overlay.ps1
```

Browser: `http://127.0.0.1:8788` zeigt den letzten Screenshot, was gelesen
wurde und den Rat. TFT im **randlosen Fenstermodus** laufen lassen, im
exklusiven Vollbild liegt kein Overlay obendrauf.

## Screenshot und Defender

Windows Defender blockierte den Bildschirm-Screenshot als Inline-PowerShell
(„enthält schädliche Daten“). Deshalb zwei Wege: mit installiertem ffmpeg
(`winget install Gyan.FFmpeg`, neues Fenster) nimmt `pnpm tft` ffmpeg, sonst
das Skript `scripts\tft-capture.ps1` als Datei. Welcher Weg läuft, steht
beim Start als `capture backend` im Log.

## Augment-Wahl

Zeigt das Spiel Augment-Karten, liest das Modell die drei Namen
(`augment_options`), die Meta liefert die 30 Augments mit der besten
Durchschnittsplatzierung des Patches, und Jev wählt eine Karte, mit der
Statistik in der Beschreibung jeder Option. Das Overlay zeigt dann
„Augment: …“, darunter die Comp, die daraus folgt. Ohne Jev entscheidet das
Textmodell über dieselben Optionen.

## Bevor es sinnvoll wird: die Erkennung messen

Zehn Screenshots aus echten Planungsphasen in einen Ordner legen (Win+Shift+S
oder das Spiel selbst), dann:
```powershell
cd C:\Users\Emanuel\Heizlastberechnung
pnpm tft -- --measure C:\Users\Emanuel\Pictures\tft
```
Das liest jede Datei einmal und schreibt `reports\tft-measure.json`. Shop-
und Board-Namen mit dem Bild vergleichen. Unter 90 Prozent richtiger Namen
lohnt der Rest nicht; dann Modell wechseln (`TFT_VISION_MODEL`, Kandidaten
aus der Modellliste mit `supportsVision`: `qwen-3-8-flash`, `kimi-k2-6`,
`z-ai-glm-5-3-flash`, `gemini-3-8-flash`) oder Zuschnitt auf Shop und Board.

## Was es kostet

| Aufruf | Modell (Standard) | ungefähr |
| --- | --- | --- |
| Bild lesen, alle 8 s | qwen-3-8-flash | 0,03 Cent |
| Meta, einmal täglich | qwen-3-8-flash mit Web-Suche | unter 1 Cent |
| Rat pro Board-Änderung | Jev | 0 (Guthaben) |
| Rat ohne Jev | qwen-3-8-flash | 0,05 Cent |

Ein Spiel liegt damit bei wenigen Cent. Die Kopfzeile der Browser-Seite
zählt Lesungen, Ratschläge und Tokens.

## Was nicht verifiziert ist

Die Web-Suche wird über `venice_parameters.enable_web_search` angefragt;
lehnt das Modell das Feld ab, geht die Anfrage ohne Suche raus (dann kennt
das Modell nur seinen Trainingsstand, was für die aktuelle Meta zu alt sein
kann; steht im Log als Wiederholung). Die Erkennungsrate steht oben. Die
Fragen an Jev sind ein erster Wurf und werden an dem gemessen, was der Rat
in echten Spielen taugt.

## Dateien

- `src/tft/capture.ts` Screenshot per ffmpeg gdigrab (bevorzugt) oder `scripts/tft-capture.ps1`, JPEG 1600 px
- `src/tft/vision.ts` Lesen mit JSON-Schema, Fingerprint der Lage
- `src/tft/meta.ts` Meta per Web-Suche, 24 h Cache in `data/tft/meta.json`
- `src/tft/advisor.ts` Jev-Fragen (comp, action, on_track, urgency), Text-Fallback
- `src/tft/store.ts` SQLite `data/tft/tft.sqlite`, `src/tft/server.ts` API und Seite
- `scripts/tft.ts`, `scripts/tft-overlay.ps1`, `tests/unit/tft/`
