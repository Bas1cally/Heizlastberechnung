@echo off
rem Vergleicht Bildmodelle am letzten TFT-Screenshot: Zeit und was jedes erkennt. Vorher in einer Planungsphase tft.cmd laufen lassen. Danach teilen mit Claude.
cd /d "%~dp0"
call pnpm -s tft -- --bench-vision
call pnpm -s share
echo.
pause