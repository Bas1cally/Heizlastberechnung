@echo off
rem Wie teilen.cmd, dazu der letzte Spiel-Screenshot (nur das Spielfenster, kein Desktop). Das Repository ist oeffentlich.
cd /d "%~dp0"
call pnpm -s share -- --bild
echo.
pause
