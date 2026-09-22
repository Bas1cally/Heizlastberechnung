@echo off
rem Schiebt die aktuellen Berichte (TFT, Karten, Bildmodell-Vergleich, Log-Enden) auf den Branch "share", damit Claude sie lesen kann.
rem Das Repository ist oeffentlich: nur Text, keine Schluessel, keine Screenshots.
cd /d "%~dp0"
call pnpm -s share
echo.
pause
