@echo off
rem SETS-Test: holt 3 Jahre BTC-Stundenkerzen von Binance (oeffentlich, ohne Key) und testet SETS Monat fuer Monat auf ungesehenen Daten, dazu eine Kontrolle auf gemischten Kursen. Dauer etwa 2-4 Minuten.
rem Alles in einer Zeile: git pull darf diese Datei aendern, ohne den laufenden Ablauf zu stoeren.
cd /d "%~dp0" & git pull --ff-only & call pnpm -s sets -- test & echo. & start "" notepad reports\sets-walk.txt & pause & exit /b
