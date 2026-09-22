@echo off
rem Schiebt die aktuellen Berichte (TFT, Karten, Bildmodell-Vergleich, Log-Enden, letzte Spiel-Screenshots) auf den Branch "share", damit Claude sie lesen kann.
rem Das Repository ist oeffentlich: keine Schluessel, keine Desktop-Bilder.
cd /d "%~dp0"
call pnpm -s share
echo.
pause
