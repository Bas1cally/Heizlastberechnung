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
