@echo off
rem TFT-Bericht der letzten Sitzung. Oeffnet ihn im Editor zum Kopieren.
cd /d "%~dp0"
call pnpm -s tft:report
start "" notepad reports\tft-report.txt
