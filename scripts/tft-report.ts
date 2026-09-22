/**
 * The last TFT session in one screen (docs/TFT.md): readings, advice by
 * Jev or the text model, errors by kind, tokens and Venice cost.
 *
 *   pnpm tft:report                 # the last session (readings without a 10-minute gap)
 *   pnpm tft:report -- --hours 3    # everything of the last three hours
 */
import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { loadEnvFile } from "../src/app/env.js";
import { ENDPOINTS } from "../src/director/venice.js";
import { TftStore } from "../src/tft/store.js";
import { buildReport, renderReport, type Prices } from "../src/tft/report.js";

loadEnvFile();
const env = (name: string): string | undefined => { const v = process.env[name]?.trim(); return v ? v : undefined; };
const dataDir = env("TFT_DATA") ?? "data/tft";
const dbPath = join(dataDir, "tft.sqlite");
if (!existsSync(dbPath)) { const msg = `Noch keine TFT-Daten in ${dbPath}. Erst tft.cmd starten und spielen.`; console.log(msg); mkdirSync("reports", { recursive: true }); writeFileSync("reports/tft-report.txt", msg + "\n", "utf8"); process.exit(0); }
const store = TftStore.open(dbPath);
const argv = process.argv.slice(2);
const hi = argv.indexOf("--hours");
const since = hi >= 0 ? Date.now() - Number(argv[hi + 1]) * 3_600_000 : undefined;

const prices: Prices = {};
const key = env("VENICE_API_KEY");
if (key) {
  try {
    const r = await fetch(`${ENDPOINTS.base}${ENDPOINTS.models}?type=text`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
    const j = (await r.json()) as { data?: { id: string; model_spec?: { pricing?: { input?: { usd?: number }; output?: { usd?: number } } } }[] };
    for (const m of j.data ?? []) { const i = m.model_spec?.pricing?.input?.usd, o = m.model_spec?.pricing?.output?.usd; if (typeof i === "number" && typeof o === "number") prices[m.id] = { inPerM: i, outPerM: o }; }
  } catch { /* report without cost */ }
}
const text = renderReport(buildReport(store, prices, since));
console.log(text);
mkdirSync("reports", { recursive: true });
writeFileSync("reports/tft-report.txt", text + "\n", "utf8");
console.log("\n(auch gespeichert in reports\\tft-report.txt)");
