@echo off
rem Kartentest fuer Jev: Blackjack, Poker-Gewinnchance, Call oder Fold. Je 100 Situationen, dazu das Textmodell als Vergleich. Danach teilen mit Claude.
cd /d "%~dp0"
git pull --ff-only
call pnpm -s cards -- all --n 100 --text
call pnpm -s share
echo.
pause