@echo off
rem Venice Director: ein Doppelklick startet den Server und die Seite. Fenster "Director" schliessen = Stopp.
cd /d "%~dp0" & git pull --ff-only & start "Director" cmd /k pnpm director & timeout /t 4 /nobreak >nul & start "" http://127.0.0.1:8787 & exit /b