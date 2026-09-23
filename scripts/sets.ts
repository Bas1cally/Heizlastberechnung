/**
 * Independent test of SETS MACHINE (github.com/Shelpid/SETS), engine vendored unchanged
 * in vendor/sets. Market data only: Binance public klines, no key, no orders. docs/SETS.md.
 *
 *   pnpm sets -- test                    # walk-forward over 3 years of BTCUSDT hours, plus a shuffled control
 *   pnpm sets -- test --years 1 --seeds 5
 *   pnpm sets -- shadow                  # leader of today trades the next 8 hours on paper
 *   pnpm sets -- shadow --hours 4 --seed 7
 *
 * Writes reports/sets-walk.txt, reports/sets-shadow.txt and reports/sets-shadow.log.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { FAMILIES, type BotEvent } from "../vendor/sets/bot.js";
import { Evolution, GENES } from "../vendor/sets/evolution.js";
import { makeSeries } from "../vendor/sets/series.js";
import { closed, gaps, hourlyHistory, klines, toCandle } from "../src/sets/data.js";
import { ShadowCore, type Minute } from "../src/sets/shadow.js";
import { renderControl, renderWalk, shuffledTape, walkForward, WALK_DEFAULTS } from "../src/sets/walk.js";

const argv = process.argv.slice(2);
const opt = (n: string): string | undefined => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const cmd = argv.find((a) => a === "test" || a === "shadow") ?? "test";
const CACHE = "data/sets-btcusdt-1h.json";
const pct = (x: number): string => `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(2)} %`;
const clock = (t: number): string => new Date(t * 1000).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
mkdirSync("reports", { recursive: true });

if (cmd === "test") await test();
else await shadow();

async function test(): Promise<void> {
  const years = Number(opt("years") ?? 3), seeds = Number(opt("seeds") ?? 3);
  console.log(`Lade ${years} Jahr(e) BTCUSDT-Stundenkerzen von Binance (öffentlich, ohne Key) …`);
  const rows = await hourlyHistory({ hours: Math.round(years * 8760), file: CACHE, log: (s) => process.stdout.write(`${s}\r`) });
  console.log(`\n${rows.length} Stunden, ${clock(rows[0]![0])} bis ${clock(rows[rows.length - 1]![0])}, ${gaps(rows)} fehlende Stunden (Börsenwartung).`);
  const o = { ...WALK_DEFAULTS, seeds: Array.from({ length: seeds }, (_, k) => k + 1) };
  const t0 = Date.now();
  const w = walkForward(rows, o, (d, n) => process.stdout.write(`  Testmonat ${d}/${n}\r`));
  console.log("\nKontrolle auf zufällig gemischten Kursen …");
  const ctl = walkForward(shuffledTape(rows, 7), { ...o, seeds: [1], randoms: 0 }, (d, n) => process.stdout.write(`  Kontrollmonat ${d}/${n}\r`));
  const text = `${renderWalk(w, o)}\n\n${renderControl(w, ctl)}`;
  console.log(`\n(${((Date.now() - t0) / 1000).toFixed(0)} s)\n\n${text}`);
  writeFileSync("reports/sets-walk.txt", text + "\n");
  console.log("\n→ reports/sets-walk.txt");
}

async function shadow(): Promise<void> {
  const hours = Number(opt("hours") ?? 8), seed = Number(opt("seed") ?? 2026), poll = Number(opt("poll") ?? 60) * 1000;
  const log = (line: string): void => { console.log(line); appendFileSync("reports/sets-shadow.log", `${new Date().toISOString()} ${line}\n`); };
  console.log("Lade die letzten 100 Tage (so viele nutzt SETS selbst) …");
  const rows = (await hourlyHistory({ hours: Math.max(2400, Number(opt("cache-hours") ?? 0)), file: CACHE })).slice(-2399);
  const e = new Evolution(makeSeries(rows), { seed });
  for (let g = 0; g < 50; g++) e.step();
  const L = e.leader;
  if (!L) { log("Kein Sieger besteht das Gate: SETS würde flach bleiben. Nichts zu tun."); return; }
  log(`SETS-Sieger (Seed ${seed}, 50 Generationen, Daten bis ${clock(rows[rows.length - 1]![0])}): g${L.id} ${FAMILIES[L.genome.family]}`);
  log(`  ${GENES.map((G) => `${G.label} ${G.fmt(L.genome[G.key])}`).join(" · ")}`);
  log(`  Lernphase ${pct(L.train.ret)} (DD ${pct(L.train.maxDD)}), Gate-Monat ${pct(L.val.ret)} (DD ${pct(L.val.maxDD)}, ${L.val.trades} Trades)`);

  const now = Date.now() / 1000, start = Math.ceil(now / 3600) * 3600, end = start + hours * 3600;
  const core = new ShadowCore(L.genome, rows, start);
  log(`Shadow-Session ${clock(start)} bis ${clock(end)} (${hours} h), 10.000 USD auf Papier, keine Orders.`);
  log(`Bis zum Start ${Math.round((start - now) / 60)} min. Einstieg entscheidet SETS nur zur vollen Stunde; in ${hours} h sind 0 bis wenige Trades normal.`);

  const show = (book: string, ev: BotEvent[], t: number): void => {
    for (const x of ev) {
      if (x.type === "BUY") log(`[${book}] ${clock(t)} KAUF ${x.level} @ ${x.price.toFixed(2)} · ${x.usd.toFixed(0)} USD`);
      else log(`[${book}] ${clock(t)} ${x.type === "TP" ? "GEWINNMITNAHME" : x.type === "STOP" ? "STOP" : "ENDE"} @ ${x.price.toFixed(2)} · ${x.pnl >= 0 ? "+" : "−"}${Math.abs(x.pnl).toFixed(2)} USD`);
    }
  };
  const report = (final: boolean): string => {
    const h = core.summary("hour"), m = core.summary("minute");
    const line = (n: string, s: typeof h): string => `${n}  ${pct(s.ret).padStart(9)}  ${String(s.trades).padStart(3)} Trades (${s.wins} Gewinner)  DD ${pct(s.maxDD)}  investiert ${Math.round(s.exposure * 100)} %${s.open ? "  · Position offen" : ""}`;
    return [
      `${final ? "== Ergebnis Shadow-Session ==" : "-- Zwischenstand --"} ${clock(start)} bis ${clock(Math.min(end, Math.floor(Date.now() / 60_000) * 60))}`,
      line("SETS wie im Backtest (Stunde) ", h),
      line("SETS minutengenau              ", m),
      `BTC halten                       ${pct(core.holdReturn()).padStart(9)}`,
      final ? "Eine Session ist eine Funktionsprobe, kein Beweis. Aussagekräftig ist der Walk-Forward-Test (sets-test.cmd)." : "",
    ].filter(Boolean).join("\n");
  };
  let stopped = false;
  const finish = (): void => {
    if (stopped) return; stopped = true;
    const text = report(true);
    log(text);
    writeFileSync("reports/sets-shadow.txt", `${text}\n`);
    console.log("→ reports/sets-shadow.txt, Verlauf in reports/sets-shadow.log");
    process.exit(0);
  };
  process.on("SIGINT", finish);

  let nextMinute = start, lastStatus = 0;
  const queue: Minute[] = [];
  for (;;) {
    try {
      const nowMs = Date.now();
      const hs = closed(await klines(`/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=100&startTime=${(core.lastHour + 3600) * 1000}`), nowMs);
      for (const k of hs) { const c = toCandle(k); if (c[0] < end) show("Stunde", core.addHour(c), c[0] + 3600); }
      if (nextMinute < end && nowMs / 1000 > nextMinute + 60) {
        const ms = closed(await klines(`/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=1000&startTime=${nextMinute * 1000}`), nowMs);
        for (const k of ms) { const t = Math.floor(k.openTime / 1000); if (t >= nextMinute && t < end) queue.push({ t, open: k.open, high: k.high, low: k.low, close: k.close }); }
        if (ms.length) nextMinute = Math.floor(ms[ms.length - 1]!.openTime / 1000) + 60;
      }
      while (queue.length) {
        const ev = core.addMinute(queue[0]!);
        if (ev === null) break; // the hour that decides the entry has not arrived yet
        show("Minute", ev, queue[0]!.t);
        queue.shift();
      }
      if (Date.now() - lastStatus > 15 * 60_000 && Date.now() / 1000 >= start) { lastStatus = Date.now(); log(report(false)); }
      if (nextMinute >= end && !queue.length && core.lastHour >= end - 3600) finish();
    } catch (err) {
      log(`Netzfehler, nächster Versuch in ${poll / 1000} s: ${err instanceof Error ? err.message : String(err)}`);
    }
    await new Promise((r) => setTimeout(r, poll));
  }
}
