# Sicherheitsprüfung: Abomination81/copybot

Geprüft am 2026-09-13. Commit `7cb90082b8b3aa7867525217a5c587ea81494221`
("Use supplied Abomination81 logo across frontends and icons").

Gegenstand: <https://github.com/Abomination81/copybot> — ein selbst gehosteter
Polymarket-Copy-Trading-Bot. Rust-Ausführungs-Engine plus unabhängige
Python-Überwachungsprozesse und ein lokales Dashboard.

## Ergebnis

Kein Schadcode gefunden. Der Quelltext tut das, was die Dokumentation
beschreibt. Das ist ein Befund zur Software, keine Aussage über die
wirtschaftliche Sinnhaftigkeit des Copy-Tradings.

## Geprüfte Punkte

| Prüfung | Ergebnis |
| --- | --- |
| Umfang | 111 Dateien, 5,3 MB, ein einziger Commit (flache Historie) |
| Netzwerk-Endpunkte | Nur Polymarket-APIs, ein Polygon-RPC, Loopback-Dashboard |
| Private-Key-Behandlung | Bleibt lokal; nur Signaturen verlassen den Host |
| Hartcodierte Adressen | Ausschließlich öffentliche Protokolladressen |
| Gebühren-Abschöpfung | Keine |
| Verschleierter Code | Keiner |
| Build-Hooks | Keine `build.rs`, kein `setup.py`, keine Shell-Skripte |
| Abhängigkeiten | 13 verbreitete Crates, keine Typosquats |
| Beispielkonfiguration | Enthält keine nutzbaren Zugangsdaten |

### Schlüsselmaterial

`PRIVATE_KEY` wird aus der Umgebung gelesen, nach `[u8; 32]` dekodiert und
ausschließlich an `SigningKey::from_bytes` übergeben. Verwendungsstellen sind
`order.rs` (EIP-712-Ordersignatur) und `auth.rs` (Polymarket-CLOB-L1-Header).
Der Schlüssel wird nirgends serialisiert, protokolliert oder versendet.

### Adressen

Alle gefundenen Adressen sind öffentliche Polymarket-Infrastruktur:
Conditional Tokens Framework, CTF Exchange V2, NegRisk Exchange, dazu zwei
ERC-1155-Event-Topic-Hashes. `0x9999...` ist eine Testvorgabe. Es existiert
keine Empfängeradresse des Autors.

### Auffällig positive Signale

Die CI-Pipeline pinnt Actions auf Commit-Hashes, setzt `persist-credentials:
false`, beschränkt Rechte auf `contents: read` und prüft die
Gitleaks-Binärdatei gegen eine SHA-256-Summe. Die Installationsanleitung rät
ausdrücklich davon ab, als root zu laufen oder den Dashboard-Port öffentlich
zu exponieren. Solche Sorgfalt findet sich in Schadprojekten nicht.

## Verifikation (selbst ausgeführt)

```
python3 scripts/check_release.py      → 111 Dateien, 0 Funde
pytest deploy/ scripts/               → 185 bestanden, 1 übersprungen
cargo test --lib --bin copybot-hot    → 749 bestanden
cargo build --release                 → erfolgreich, 7,4 MB Binärdatei
```

Ein Test (`pending::tests::a_FAILED_resolution_LATCHES_instead_of_closing_quietly`)
schlägt als root fehl, weil er einen nicht schreibbaren Pfad voraussetzt und
root unter `/` schreiben darf. Als unprivilegierter Nutzer erneut ausgeführt:
bestanden. Kein Codefehler.

## Empirisch bestätigte Schutzmechanismen

Die mitgelieferte Vorlage verweigert den Start ("no enabled lanes"). Platzhalter-
Adressen werden abgewiesen. Mit `mode = "live"` und ohne Schlüssel bricht die
Engine mit "REFUSING TO START" und Exit-Code 2 ab. Nicht gemessene
Leader-Statistiken sind Pflichtfelder. Alle Prüfungen mit Exit-Code 2 bestätigt.

## Offene Punkte

- Die README bezeichnet das Repository als privat; es ist öffentlich anonym
  klonbar. Die Anleitung behauptet an anderer Stelle korrekt, dass ein privates
  Repository kein Schutz für ein laufendes Dashboard ist.
- Eine einzige, flache Commit-Historie lässt keine Beurteilung der Entwicklung zu.
- Keine Open-Source-Lizenz gewählt. Ausdrücklich kein MIT-Release. Eine
  Weiterverwendung ist rechtlich ungeklärt.
- Kontoalter und Reputation des Autors konnten in dieser Sitzung nicht geprüft
  werden, da dafür Schreib-Zugangsdaten nötig gewesen wären.
- Geprüft wurde genau dieser Commit. Künftige Commits sind damit nicht abgedeckt.

---

# Nachtrag: Trockenlauf und Wirtschaftlichkeit

## Warum kein echter Paper-Trade möglich war

Die Entdeckung neuer Signale läuft ausschließlich über einen
Polygon-Mempool-Stream (`eth_subscribe` auf `newPendingTransactions` mit
vollständigen Transaktionsobjekten). Einen zweiten Entdeckungspfad gibt es
nicht; der öffentliche Aktivitäts-Endpunkt dient nur dem Vorbefüllen
historischer Positionen.

Zusätzlich verweigert die Netzwerkpolicy dieser Umgebung den Zugriff auf
`data-api.polymarket.com`, `clob.polymarket.com` und `polygon.drpc.org`
(jeweils HTTP 403 auf CONNECT). Ein Live-Trockenlauf gegen echte Marktdaten
ist von hier aus nicht durchführbar.

Stattdessen wurde die Entscheidungslogik offline gegen die echten
Bibliotheksfunktionen der Engine gerechnet (`budget::target_shares`,
`budget::effective_pct`, `venue::buy_limit`, `venue::sell_limit`).

## Wichtige Korrektur: Slippage-Parameter

`buy_slippage_c` und `sell_slippage_c` sind **keine erwartete Slippage**,
sondern absolute Limitbänder in Dollar. In `lanes.rs` gilt
`buy_limit((preis + buy_slippage_c).min(0.99))`.

Die Beispielkonfiguration setzt `buy_slippage_c = 0.15`. Das erlaubt:

| Signalpreis | zulässiges Kauflimit | maximaler Aufschlag |
| --- | --- | --- |
| 0.05 | 0.200 | 300 % |
| 0.10 | 0.250 | 150 % |
| 0.30 | 0.450 | 50 % |
| 0.70 | 0.850 | 21 % |

`sell_slippage_c = 1.0` zusammen mit `sell_floor_frac = 0.0` ergibt ein
Verkaufslimit von 0.01 auf jedem Preisniveau. Das ist faktisch
"zu jedem Preis verkaufen". Beide Bänder gehören vor dem ersten Live-Einsatz
deutlich enger gesetzt.

## Ergebnis der Rechnung

Angenommen wurden realistische Ausführungskosten von 1,5 Cent beim Einstieg
und 1,0 Cent beim Ausstieg. Das ist eine eigene Annahme, deutlich
konservativer als die Bänder oben zulassen.

Mindestrendite, die der Leader erreichen muss, damit der Kopierer bei null
herauskommt:

| Signalpreis | Leader braucht mindestens |
| --- | --- |
| 0.05 | 50,0 % |
| 0.10 | 25,0 % |
| 0.30 | 8,3 % |
| 0.50 | 5,0 % |
| 0.90 | 2,8 % |

Anteil der Leader-Rendite, der beim Kopierer ankommt (Signalpreis 0.30):

| Leader | Kopierer | Anteil |
| --- | --- | --- |
| 5 % | −3,2 % | negativ |
| 10 % | 1,6 % | 16 % |
| 20 % | 11,1 % | 56 % |
| 50 % | 39,7 % | 79 % |
| 100 % | 87,3 % | 87 % |

Entscheidend ist der letzte Fall: ein wirklich guter Leader mit 55 Prozent
Trefferquote, +30 Prozent auf Gewinner und −25 Prozent auf Verlierer, also
+5,25 Prozent im Schnitt pro Trade:

| Signalpreis | Leader-Schnitt | unser Schnitt |
| --- | --- | --- |
| 0.10 | +5,25 % | **−17,17 %** |
| 0.30 | +5,25 % | **−2,94 %** |
| 0.50 | +5,25 % | +0,24 % |
| 0.70 | +5,25 % | +1,64 % |

## Schlussfolgerung

Die Ausführungskosten sind ein fester Abzug pro Trade, kein prozentualer.
Deshalb treffen sie günstige Kontrakte prozentual am härtesten und wirken auf
Gewinner wie Verlierer gleichermaßen. Ein Leader mit kleinem, aber echtem
Vorteil wird dadurch zuverlässig in einen Verlust verwandelt.

Profitabel ist das Kopieren nur, wenn der Leader große Bewegungen pro Trade
erzielt und überwiegend in teureren Kontrakten handelt. Ein dünner Vorteil
überlebt die Reibung nicht. Nicht berücksichtigt sind dabei noch
Polymarket-Gebühren, Gaskosten und die Verzerrung durch das Glattstellen beim
ersten Verkauf des Leaders.
