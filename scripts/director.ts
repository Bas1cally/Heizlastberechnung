/**
 * Venice Director (VENICE_DIRECTOR_SPEC.md): the local UI on 127.0.0.1.
 * No trading, no STOP file: this process never touches the bot's tables.
 *
 *   pnpm director                  # http://127.0.0.1:8787
 *   pnpm director -- --port 9000
 *
 * Env: VENICE_API_KEY (quote/queue and, by default, the text model for
 * draft / review_fix / translate: VENICE_TEXT_MODEL, default kimi-k2-6),
 * TEXT_PROVIDER=anthropic with ANTHROPIC_API_KEY + CLAUDE_MODEL instead,
 * TYPESAFE_API_KEY (Jev gate), DIRECTOR_PORT, DIRECTOR_DATA, FFMPEG / FFPROBE.
 * Missing keys disable the matching buttons; nothing else breaks.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { loadEnvFile } from "../src/app/env.js";
import { createLogger } from "../src/observability/logger.js";
import { teeSink } from "../src/observability/file-sink.js";
import { openDirectorDb } from "../src/director/schema.js";
import { DirectorRepo } from "../src/director/repo.js";
import { EngineRegistry } from "../src/director/engines.js";
import { loadVocabulary } from "../src/director/vocabulary.js";
import { ClaudeCalls, type TextCalls } from "../src/director/claude.js";
import { VeniceTextCalls, veniceTextPricing } from "../src/director/text-venice.js";
import { createGateCall } from "../src/director/jev-gate.js";
import { VeniceClient } from "../src/director/venice.js";
import { DirectorService } from "../src/director/service.js";
import { startDirectorServer } from "../src/director/server.js";

loadEnvFile();
// An empty line in .env (`DIRECTOR_DATA=`) means "not set", not "".
const env = (name: string): string | undefined => { const v = process.env[name]?.trim(); return v ? v : undefined; };
const argv = process.argv.slice(2);
const opt = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const port = Number(opt("port") ?? env("DIRECTOR_PORT") ?? 8787);
const dataDir = env("DIRECTOR_DATA") ?? "data/director";
mkdirSync(dataDir, { recursive: true });
const log = createLogger({ write: teeSink("logs/director.log"), bindings: { component: "director" } });

const db = openDirectorDb(`${dataDir}/director.sqlite`);
const repo = new DirectorRepo(db);
const engines = EngineRegistry.load("director/engines.json");
const vocabulary = loadVocabulary("director/vocabulary.json");

const veniceKey = env("VENICE_API_KEY");
const venice = veniceKey ? new VeniceClient({ apiKey: veniceKey }) : undefined;
// The text model behind draft / review_fix / translate. Default: a text model on the Venice
// account (TEXT_PROVIDER=venice, VENICE_TEXT_MODEL, default kimi-k2-6); TEXT_PROVIDER=anthropic
// uses ANTHROPIC_API_KEY + CLAUDE_MODEL instead.
const provider = env("TEXT_PROVIDER") ?? (veniceKey ? "venice" : env("ANTHROPIC_API_KEY") ? "anthropic" : "none");
let text: TextCalls | undefined;
let textPrice = { inPerM: Number(env("TEXT_USD_PER_MTOKEN_IN") ?? 0), outPerM: Number(env("TEXT_USD_PER_MTOKEN_OUT") ?? 0) };
if (provider === "venice" && veniceKey) {
  const model = env("VENICE_TEXT_MODEL") ?? "kimi-k2-6";
  text = new VeniceTextCalls({ apiKey: veniceKey, model, reasoningEffort: env("VENICE_TEXT_REASONING") ?? "low" });
  if (!textPrice.inPerM && !textPrice.outPerM) {
    const p = await veniceTextPricing(veniceKey, model).catch(() => undefined);
    if (p) textPrice = p; else log.warn("text model price unknown; cost counter stays at 0 for text calls", { model });
  }
} else if (provider === "anthropic" && env("ANTHROPIC_API_KEY")) {
  text = new ClaudeCalls({ apiKey: env("ANTHROPIC_API_KEY"), model: env("CLAUDE_MODEL") ?? "claude-opus-5" });
  if (!textPrice.inPerM && !textPrice.outPerM) textPrice = { inPerM: 15, outPerM: 75 };
}
const typesafeKey = env("TYPESAFE_API_KEY");
const gate = typesafeKey ? createGateCall(new TypeSafeClient({ apiKey: typesafeKey, timeout: 20_000, retry: { maxRetries: 0 }, logLevel: "off" })) : undefined;
const tools = { ffmpeg: env("FFMPEG") ?? "ffmpeg", ffprobe: env("FFPROBE") ?? "ffprobe" };
const ffmpeg = await new Promise<boolean>((res) => execFile(tools.ffmpeg, ["-version"], (err) => res(!err)));

// Engines: the documented Seedance ids are always known; GET /models refines them once per start when the key is there.
if (venice) {
  try {
    const { engines: live } = await venice.listEngines();
    engines.merge(live);
    engines.save("director/engines.json");
    log.info("engines refreshed from Venice", { n: live.length });
  } catch (err) {
    log.warn("GET /models failed; using director/engines.json or the documented Seedance ids", { err: err instanceof Error ? err.message : String(err), cached: existsSync("director/engines.json") });
  }
}

const service = new DirectorService({ repo, engines, vocabulary, text, textPrice, gate, venice, dataDir, tools, log: (m, f) => log.info(m, f) });
const capabilities = { text: Boolean(text), textModel: text?.model ?? "", textProvider: text?.provider ?? "none", gate: Boolean(gate), venice: Boolean(venice), ffmpeg };
log.info("capabilities", { ...capabilities, textPrice, dataDir });
if (!capabilities.gate) log.warn("TYPESAFE_API_KEY missing: the Jev gate button is off");
startDirectorServer({ repo, service, engines, vocabulary, dataDir, capabilities, log: (m, f) => log.info(m, f) }, port);
