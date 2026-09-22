@echo off
rem Vergleicht Bildmodelle am letzten TFT-Screenshot: Zeit und was jedes erkennt. Vorher in einer Planungsphase tft.cmd laufen lassen.
cd /d "%~dp0"
call pnpm -s tft -- --bench-vision
echo.
pause
