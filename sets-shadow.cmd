@echo off
rem SETS-Shadow: SETS waehlt seinen Sieger aus den letzten 100 Tagen und handelt ab der naechsten vollen Stunde 8 Stunden lang auf Papier mit. Keine Orders, kein Key. Strg+C beendet vorzeitig mit Ergebnis.
rem Alles in einer Zeile: git pull darf diese Datei aendern, ohne den laufenden Ablauf zu stoeren.
cd /d "%~dp0" & git pull --ff-only & call pnpm -s sets -- shadow --hours 8 & echo. & start "" notepad reports\sets-shadow.txt & pause & exit /b
