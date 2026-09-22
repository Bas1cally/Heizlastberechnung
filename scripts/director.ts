/**
 * Venice Director (VENICE_DIRECTOR_SPEC.md): the local UI on 127.0.0.1.
 * No trading, no STOP file: this process never touches the bot's tables.
 *
 *   pnpm director                  # http://127.0.0.1:8787
 *   pnpm director -- --port 9000
 *
 * Env: VENICE_API_KEY (quote/queue), ANTHROPIC_API_KEY + CLAUDE_MODEL
 * (draft / review_fix / translate), TYPESAFE_API_KEY (Jev gate),
 * DIRECTOR_PORT, DIRECTOR_DATA (default data/director), FFMPEG / FFPROBE.
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
import { ClaudeCalls } from "../src/director/claude.js";
import { createGateCall } from "../src/director/jev-gate.js";
import { VeniceClient } from "../src/director/venice.js";
import { DirectorService } from "../src/director/service.js";
import { startDirectorServer } from "../src/director/server.js";

loadEnvFile();
const argv = process.argv.slice(2);
const opt = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const port = Number(opt("port") ?? process.env["DIRECTOR_PORT"] ?? 8787);
const dataDir = process.env["DIRECTOR_DATA"] ?? "data/director";
mkdirSync(dataDir, { recursive: true });
const log = createLogger({ write: teeSink("logs/director.log"), bindings: { component: "director" } });

const db = openDirectorDb(`${dataDir}/director.sqlite`);
const repo = new DirectorRepo(db);
const engines = EngineRegistry.load("director/engines.json");
const vocabulary = loadVocabulary("director/vocabulary.json");

const veniceKey = process.env["VENICE_API_KEY"];
const venice = veniceKey ? new VeniceClient({ apiKey: veniceKey }) : undefined;
const model = process.env["CLAUDE_MODEL"] ?? "claude-opus-5";
const claude = process.env["ANTHROPIC_API_KEY"] ? new ClaudeCalls({ apiKey: process.env["ANTHROPIC_API_KEY"], model }) : undefined;
// USD per million tokens for the cost ledger; override for another model.
const claudePrice = { inPerM: Number(process.env["CLAUDE_USD_PER_MTOKEN_IN"] ?? 15), outPerM: Number(process.env["CLAUDE_USD_PER_MTOKEN_OUT"] ?? 75) };
const typesafeKey = process.env["TYPESAFE_API_KEY"];
const gate = typesafeKey ? createGateCall(new TypeSafeClient({ apiKey: typesafeKey, timeout: 20_000, retry: { maxRetries: 0 }, logLevel: "off" })) : undefined;
const tools = { ffmpeg: process.env["FFMPEG"] ?? "ffmpeg", ffprobe: process.env["FFPROBE"] ?? "ffprobe" };
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

const service = new DirectorService({ repo, engines, vocabulary, claude, claudePrice, gate, venice, dataDir, tools, log: (m, f) => log.info(m, f) });
const capabilities = { claude: Boolean(claude), gate: Boolean(gate), venice: Boolean(venice), ffmpeg };
log.info("capabilities", { ...capabilities, model, dataDir });
if (!capabilities.gate) log.warn("TYPESAFE_API_KEY missing: the Jev gate button is off");
startDirectorServer({ repo, service, engines, vocabulary, dataDir, capabilities, log: (m, f) => log.info(m, f) }, port);
