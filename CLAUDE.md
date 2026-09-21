# Working agreements

- Der Nutzer arbeitet in PowerShell unter `C:\Users\Emanuel\Heizlastberechnung`.
  Wenn er etwas neu starten oder ausführen soll, immer die vollständigen
  Befehle angeben, inklusive `cd` in den Projektordner, pro Fenster ein
  eigener Block. Nie nur "starte X neu".
- Bot-Fenster: `pnpm auto` (Jev), `pnpm auto -- animal`, `pnpm auto -- animalplus`.
  Manueller Sync: `pnpm sync`. Live bleibt aus, solange nicht ausdrücklich freigegeben.
- Secrets nie im Chat, nie im Commit (`.env` ist gitignored).
