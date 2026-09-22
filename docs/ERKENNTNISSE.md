# Erkenntnisse (Stand 2026-09-22)

Was dieses Repo über Jev (TypeSafe System One) und Venice-Modelle gezeigt
hat, mit den gemessenen Zahlen. Die Einzelheiten stehen in
`docs/JEV_DECISIONS.md` (Polymarket), `docs/DIRECTOR.md`, `docs/TFT.md`
und `docs/CARDS.md`. Alle Projekte sind beendet; die `STOP`-Datei hält
die Bot-Skripte an, Live-Handel war nie freigegeben.

## Die Bauregel

> **Das große Modell schreibt das Wissen, langsam und selten. Der Code
> rechnet. Jev entscheidet, schnell und oft. Jede Entscheidung wird gegen
> die Wirklichkeit gemessen und nachkalibriert.**

Und die Gegenrichtung, die nicht funktioniert: Jev als Richter über den
Vorschlag eines besseren Modells. Er überstimmt ihn, statt ihn zu
übernehmen.

## Jev in Zahlen

| | |
| --- | --- |
| Antwortzeit | Median 279 ms, p99 686 ms (300 Anfragen, 100 % Erfolg) |
| Stabilität | derselbe Zustand 10× gefragt: 10× dieselbe Antwort |
| Stärke | Rangfolgen, Kategorien, Ja/Nein über strukturiertem Text |
| Schwäche | Zahlen und Regeln, die er nicht kennt; systematisch verzerrt |
| Kosten | nicht gratis: rund 20.000 Aufrufe am Tag haben die Monats-Credits in unter einem Tag aufgebraucht |

## Kartentest (lokal, richtige Antwort exakt bekannt)

Je 100 Situationen, `cards.cmd`. Vergleich: DeepSeek V4 Flash über Venice.

**Blackjack** (Basic Strategy, 6 Decks):

| Variante | richtig | Zeit pro Hand |
| --- | --- | --- |
| Jev allein | 60 % (hart 83, weich 30, Paare 44) | 0,28 s |
| Faustregel „unter 17 ziehen“ | 60 % | – |
| Faustregel mit Dealer-Karte | 62 % | – |
| Faustregel, drei Zeilen | 78 % | – |
| DeepSeek allein | 95–97 % | 7–11 s |
| jev+wissen (DeepSeek schreibt einmal eine 28-Zeilen-Tabelle, Jev liest sie) | 80 % (hart 100, weich 55, Paare 66) | 0,29 s |
| jev+wissen mit kaputtem Zettel (55 Zeichen) | 58 % | 0,28 s |
| jev+vorschlag (DeepSeek schlägt pro Hand vor, Jev entscheidet) | 65–68 % | 0,28 s |

In 37 Streitfällen zwischen Jev und DeepSeek lag DeepSeek 37× richtig.
Jev splittet und verdoppelt zu oft (2,2 gegen 8/9, weiche 15–17), auch
wenn die Tabelle es anders sagt.

**Equity** (Gewinnchance heads-up, Monte Carlo als Wahrheit):

| | |
| --- | --- |
| mittlerer Fehler | 18,2 Prozentpunkte |
| Verzerrung | −15,9 (Jev schätzt durchweg zu pessimistisch) |
| Korrelation | 0,80 (die Reihenfolge stimmt) |
| nach linearer Umrechnung | 11,0 Punkte, wahr ≈ 9 + 1,20 × gesagt |

Nicht mehr gemessen: DeepSeek bei Equity, der Call-Test (Pot Odds) und
die Team-Varianten dort. Der Lauf wurde bewusst beendet.

**Folgerung:** Jev nie eine Zahl schätzen lassen, die der Code ausrechnen
kann. Wo Jev doch eine Wahrscheinlichkeit liefert, vorher an echten
Ergebnissen kalibrieren.

## TFT-Berater (Bildschirm → Vision-Modell → Jev → Overlay)

Funktionstest bestanden: automatische Screenshots (ffmpeg, Spielfenster),
Brett gelesen von `qwen3-vl-235b-a22b` auf Venice, offizielle Set-Daten
von Community Dragon zur Prüfung, Jev wählt Comp, Aktion und Augment, ein
Overlay zeigt es an. Start und Stopp per Doppelklick.

- Jev: 9 von 9 Empfehlungen, Median 0,7 s.
- Engpass ist das Lesen des Bildes: Median etwa 12 s, viele Timeouts.
- Ohne offizielle Set-Daten erfindet das Modell Sets und Champions
  („Set 18“); mit Namensabgleich (Levenshtein) und Prüfung verschwindet das.

## Venice Director (Videoaufträge)

Formular im Browser, Prompt-Entwurf und Übersetzung durch ein Venice-
Textmodell, Prüfung durch Jev vor dem bezahlten Video, 141 Videomodelle
über die API, Preisabfrage vor dem Auftrag. Gebaut und lauffähig, mangels
Anwendung nicht weiter verfolgt.

Venice-Eigenheiten: Pro-Abo-Guthaben gilt nicht für die API (402 ohne
USD/DIEM-Guthaben); `qwen-3-8-flash` denkt immer und läuft ins
Token-Limit; Antworten gegen ein JSON-Schema brauchen eine
Korrekturrunde.

## Polymarket (BTC-5-Minuten-Märkte)

- Jev als Richtungsentscheider: kein Vorteil. 302 Käufe, die gekaufte
  Seite gewann 21,5 %, der Marktpreis hatte 28,8 % gesagt.
- Der Referenz-Trader: Volumen-Farming, über acht Tage −672 USD vor
  Rebates. Nichts zum Kopieren.
- Delta-neutrale Volumenschleife: ein vollständiges Set kostete 1,011
  statt 1,00, in 0 von 2.879 Entscheidungen war es billiger.

**Folgerung:** Gegen einen liquiden Preis hat ein Sprachmodell keinen
Vorsprung. Jev passt zu vielen billigen Urteilen über Text, nicht zur
Vorhersage.

## Wo die Bauregel hinpasst

Viele kleine Entscheidungen, jemand wartet auf die Antwort, das Wissen
lässt sich vorab aufschreiben und die Zahlen rechnet der Code. Nicht
geeignet: Märkte ohne feste richtige Antwort, Aufgaben, bei denen Jev
rechnen müsste, und Dauerbetrieb, bei dem die Credits pro Aufruf zählen.
