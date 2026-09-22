# Kartentest für Jev

Drei Tests, bei denen die richtige Antwort exakt bekannt ist. Sie messen,
ob Jev Wahrscheinlichkeiten versteht oder nur plausibel klingt. Alles
lokal: keine Mitspieler, kein Geld, nur Jev-Credits (und Cent-Beträge,
wenn das Textmodell auf Venice mitläuft).

| Test | Frage an Jev | Wahrheit |
| --- | --- | --- |
| `blackjack` | HIT, STAND, DOUBLE oder SPLIT für die ersten zwei Karten gegen die offene Dealer-Karte | Basic-Strategy-Tabelle, 6 Decks, Dealer steht auf Soft 17, Double nach Split |
| `equity` | Wahrscheinlichkeit (noul), dass die Hand heads-up gegen zwei Zufallskarten gewinnt | Monte Carlo mit 20.000 Durchläufen, Fehler etwa ±0,4 Punkte |
| `call` | FOLD oder CALL gegen einen Einsatz, ohne weitere Setzrunden | Pot Odds mit der exakten Gewinnchance |

Beim Call-Test liegen die Einsätze absichtlich nahe an der Grenze, sonst
wäre „immer callen“ meistens richtig. Der Bericht nennt diese Grundlinie
trotzdem mit.

## Start

Doppelklick auf `cards.cmd`: je 100 Situationen, Jev und zum Vergleich
DeepSeek V4 Flash auf Venice. Oder von Hand:

```powershell
cd C:\Users\Emanuel\Heizlastberechnung
pnpm cards
pnpm cards -- blackjack --n 200
pnpm cards -- all --n 100 --text
pnpm cards -- equity --text kimi-k2-6 --seed 7
```

`--seed` erzeugt dieselben Situationen wieder, damit sich Läufe und Modelle
vergleichen lassen. Jede Situation mit Antwort und Wahrheit landet in
`reports/cards-<test>.json`. Bei „keine Credits“ bricht der Lauf nach der
ersten Ablehnung ab, statt 100 Fehler zu sammeln.

## Was die Zahlen bedeuten

- **Blackjack:** Übereinstimmung mit der Tabelle, getrennt nach harten
  Summen, Soft-Händen und Paaren, dazu die häufigsten Abweichungen.
- **Gewinnchance:** mittlerer Fehler in Prozentpunkten, Verzerrung (ist
  Jev zu optimistisch?), Anteil innerhalb von 5 Punkten, Korrelation, und
  eine Kalibrierungstabelle „gesagt gegen wahr“.
- **Call/Fold:** Anteil richtiger Entscheidungen, verlorener
  Erwartungswert in Prozent des Pots pro Hand, und wie oft falsch gecallt
  oder falsch gefoldet wurde.

Zum Einordnen: eine Tabelle oder ein Taschenrechner schafft hier jeweils
100 Prozent. Jev muss also nicht gewinnen, um interessant zu sein. Die
Frage ist, wie nah ein Urteilsmodell ohne Rechnung an die Mathematik kommt,
und ob es besser oder schlechter ist als ein großes Textmodell.

## Dateien

- `src/cards/cards.ts` Karten, Deck, reproduzierbarer Zufall
- `src/cards/poker.ts` 7-Karten-Bewertung, Monte-Carlo-Gewinnchance, Pot Odds
- `src/cards/blackjack.ts` Basic Strategy und Zufallshände
- `src/cards/bench.ts` Situationen, Fragen an Jev und Textmodell, Auswertung
- `scripts/cards.ts`, `cards.cmd`, `tests/unit/cards/`
