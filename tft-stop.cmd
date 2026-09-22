@echo off
rem Stoppt den TFT-Berater und das Overlay.
taskkill /fi "WINDOWTITLE eq TFT-Berater*" /t /f >nul 2>&1
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 8788 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }; Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.CommandLine -like '*tft-overlay.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
if not "%1"=="quiet" (echo TFT-Berater gestoppt. & timeout /t 2 >nul)
