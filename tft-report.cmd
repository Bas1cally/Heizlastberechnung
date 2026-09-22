@echo off
rem TFT-Bericht der letzten Sitzung, dazu teilen mit Claude (Branch share).
cd /d "%~dp0"
call pnpm -s tft:report
call pnpm -s share
start "" notepad reports\tft-report.txt