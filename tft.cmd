@echo off
rem TFT-Berater: alles mit einem Doppelklick. Holt den neuesten Stand, startet den Berater,
rem das Overlay (Rechtsklick schliesst es) und die Browserseite. Fenster "TFT-Berater" schliessen = Stopp.
cd /d "%~dp0"
git pull --ff-only
start "TFT-Berater" cmd /k pnpm tft
timeout /t 4 /nobreak >nul
start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File scripts\tft-overlay.ps1
start "" http://127.0.0.1:8788
