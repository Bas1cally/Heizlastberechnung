# SETS MACHINE: unabhängiger Test

[SETS MACHINE](https://github.com/Shelpid/SETS) züchtet mit einem genetischen
Algorithmus Grid-DCA-Strategien auf BTC-Stundenkerzen. Hier wird die Engine
**unverändert** geprüft (Kopie in `vendor/sets/`, MIT, Commit `da0f110`).
Nur Marktdaten von Binance, öffentlich, ohne Key, keine Orders.

## Start

Doppelklick auf `sets-test.cmd` oder `sets-shadow.cmd`. Oder von Hand:

```powershell
cd C:\Users\Emanuel\Heizlastberechnung
pnpm sets -- test
pnpm sets -- shadow --hours 8
```

| Befehl | Was passiert | Dauer |
| --- | --- | --- |
| `test` | 3 Jahre Stundenkerzen laden, dann Monat für Monat: 60 Tage lernen, 30 Tage Gate, die nächsten 30 Tage **ungesehen** handeln. Danach dasselbe auf zufällig gemischten Kursen als Kontrolle. | 2–4 min |
| `shadow` | SETS wählt seinen Sieger aus den letzten 100 Tagen, genau wie die App. Ab der nächsten vollen Stunde handelt er auf Papier live mit. | 8 h (Strg+C beendet früher) |

Ergebnisse: `reports/sets-walk.txt`, `reports/sets-shadow.txt`, Verlauf in
`reports/sets-shadow.log`. Die Kerzen liegen in `data/sets-btcusdt-1h.json`,
ein zweiter Lauf lädt nur die neuen Stunden nach.

## Lesen

Jeder Testmonat zeigt drei Spalten neben „BTC halten“:

- **SETS:** Buchung wie in SETS selbst.
- **vorsichtig:** gleiche Strategie, aber eine Stunde, in der nachgekauft wurde,
  darf nicht auch noch den Take-Profit treffen. SETS nimmt an, dass das Tief vor
  dem Hoch kam, und bucht beides in derselben Kerze.
- **Zufall:** zufällige Strategien, die dasselbe Gate bestehen.

Die **Kontrolle** mischt die Stunden zufällig. Damit bleiben die Größe der
Bewegungen und der Grundtrend erhalten, aber jedes Muster verschwindet.
Verdient SETS dort ähnlich viel, hat es nichts im Markt gefunden.

Der **Shadow-Test** führt zwei Bücher mit denselben Entscheidungen:

- **Stunde:** SETS' eigene Buchung auf Stundenkerzen.
- **minutengenau:** Nachkauf, Stop und Take-Profit werden an jeder
  1-Minuten-Kerze geprüft. Damit gilt die Reihenfolge, die wirklich passiert ist.

Eine Session mit wenigen Trades ist eine Funktionsprobe. Aussagekraft hat der
Walk-Forward-Test.

## Befund vor dem Lauf (2026-09-23)

Auf den 100 Tagen im SETS-Repo:

| Messung | Ergebnis |
| --- | --- |
| README-Tabelle nachgerechnet | exakt reproduziert |
| echter Rest-Test, 30 Seeds | Sieger +5,3 % (Median), BTC halten +9,4 %, besser als Halten: 0 von 30 |
| Gate | 59 % aller zufälligen Strategien bestehen es |
| Kontrolle mit gemischten Kursen | gleiche Gate- und Testergebnisse wie auf echten Kursen |
| Mean-Revert-Sieger Seed 42, vorsichtig gebucht | Lernphase +30,8 % → +5,5 % |

Auf einem reinen Zufallskurs (synthetisch, 3 Jahre) findet die Evolution
Strategien mit kleinstem Grid-Abstand und Take-Profit (0,30 % / 0,33 %). In
SETS' Buchung bringen sie im ungesehenen Monat +30 % bei 98 % Treffern,
vorsichtig gebucht −0,5 %. Die Suche optimiert auf die Buchung innerhalb der
Kerze, nicht auf den Markt.
