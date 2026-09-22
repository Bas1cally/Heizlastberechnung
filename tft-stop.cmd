@echo off
rem Stoppt den TFT-Berater und das Overlay.
taskkill /fi "WINDOWTITLE eq TFT-Berater*" /t /f >nul 2>&1
taskkill /fi "WINDOWTITLE eq TFT-Berater" /t /f >nul 2>&1
for /f "tokens=5" %%p in ('netstat -ano ^| findstr :8788 ^| findstr LISTENING') do taskkill /pid %%p /t /f >nul 2>&1
powershell -NoProfile -Command "Get-Process powershell -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq 'TFT-Berater' } | Stop-Process -Force"
echo TFT-Berater gestoppt.
timeout /t 2 >nul
