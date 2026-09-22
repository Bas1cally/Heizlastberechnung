/**
 * Card benchmarks for Jev with an exactly known answer (docs/CARDS.md).
 *
 *   pnpm cards                               # all three tests, 100 situations each, Jev
 *   pnpm cards -- blackjack --n 200
 *   pnpm cards -- equity call --n 50 --text  # plus a text model on Venice as comparison
 *   pnpm cards -- all --text deepseek-v4-flash --seed 7
 *
 * Writes reports/cards-<test>.json with every situation, answer and truth.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { loadEnvFile } from "../src/app/env.js";
import { rng } from "../src/cards/cards.js";
import { blackjackItems, callItems, equityItems, jevAsker, render, run, textAsker, type Asker, type Item } from "../src/cards/bench.js";
import { cardStr } from "../src/cards/cards.js";

loadEnvFile();
const env = (name: string): string | undefined => { const v = process.env[name]?.trim(); return v ? v : undefined; };
const argv = process.argv.slice(2);
const opt = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const tests = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1]!.startsWith("--") && ["n", "seed", "text", "concurrency"].includes(argv[i - 1]!.slice(2))) && ["blackjack", "equity", "call", "all"].includes(a));
const selected = (tests.length === 0 || tests.includes("all") ? ["blackjack", "equity", "call"] : tests) as Item["kind"][];
const n = Number(opt("n") ?? 100);
const seed = Number(opt("seed") ?? 1);
const concurrency = Number(opt("concurrency") ?? 4);

const askers: Asker[] = [];
if (!argv.includes("--no-jev")) {
  const key = env("TYPESAFE_API_KEY");
  if (key) askers.push(jevAsker(new TypeSafeClient({ apiKey: key, timeout: 20_000, retry: { maxRetries: 1 }, logLevel: "off" })));
  else console.log("TYPESAFE_API_KEY fehlt: Jev wird übersprungen.");
}
if (argv.includes("--text")) {
  const key = env("VENICE_API_KEY");
  const t = opt("text");
  const model = t && !t.startsWith("--") && !["blackjack", "equity", "call", "all"].includes(t) ? t : env("CARDS_TEXT_MODEL") ?? "deepseek-v4-flash";
  if (key) askers.push(textAsker({ apiKey: key, model }));
  else console.log("VENICE_API_KEY fehlt: kein Textmodell-Vergleich.");
}
if (!askers.length) { console.log("Niemand zu testen."); process.exit(1); }

mkdirSync("reports", { recursive: true });
for (const test of selected) {
  const r = rng(seed * 1000 + ["blackjack", "equity", "call"].indexOf(test));
  process.stdout.write(`${test}: ${n} Situationen erzeugen …`);
  const items: Item[] = test === "blackjack" ? blackjackItems(n, r) : test === "equity" ? equityItems(n, r) : callItems(n, r);
  process.stdout.write(" fertig\n");
  const report: Record<string, unknown> = { test, n, seed, at: new Date().toISOString() };
  for (const asker of askers) {
    let last = 0;
    const results = await run(items, asker, {
      concurrency,
      onProgress: (d, t) => { if (d - last >= Math.max(5, Math.floor(t / 10)) || d === t) { last = d; process.stdout.write(`  ${asker.name}: ${d}/${t}\r`); } },
      stopOn: (e) => / 402|credits|Insufficient/i.test(e),
    });
    process.stdout.write("\n");
    console.log(render(test, asker.name, results));
    report[asker.name] = results.map((x) => ({
      state: x.item.state, truth: x.item.kind === "equity" ? Number(x.item.truth.toFixed(4)) : x.item.kind === "call" ? { action: x.item.truth, equity: Number(x.item.eq.toFixed(4)) } : x.item.truth,
      answer: x.answer ?? null, error: x.error ?? null,
      ...(x.item.kind !== "blackjack" ? { cards: [...x.item.hand, ...x.item.board].map(cardStr).join(" ") } : {}),
    }));
  }
  writeFileSync(`reports/cards-${test}.json`, JSON.stringify(report, null, 1));
  console.log(`  → reports/cards-${test}.json\n`);
}
