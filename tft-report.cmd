@echo off
rem TFT-Bericht der letzten Sitzung: Lesungen, Ratschlaege (Jev oder Textmodell), Fehler, Kosten.
cd /d "%~dp0"
call pnpm -s tft:report
echo.
pause
