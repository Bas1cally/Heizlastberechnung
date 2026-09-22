/**
 * TFT advisor (docs/TFT.md): screenshot -> vision model on Venice reads the
 * board -> Jev (or a text model) picks the comp and the action -> the overlay
 * shows three lines. Screen reading only; the game process is never touched.
 *
 *   pnpm tft                          # loop: capture every TFT_INTERVAL_S (8) seconds
 *   pnpm tft -- --once                # one capture, one reading, one advice
 *   pnpm tft -- --image shot.jpg      # read a file instead of the screen
 *   pnpm tft -- --measure C:\shots    # read every image in a folder, write reports/tft-measure.json
 *   pnpm tft -- --refresh-meta        # fetch the meta again (otherwise cached 24 h)
 *
 * Overlay (second window):  powershell -ExecutionPolicy Bypass -File scripts\tft-overlay.ps1
 * Browser view:             http://127.0.0.1:8788
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { loadEnvFile } from "../src/app/env.js";
import { createLogger } from "../src/observability/logger.js";
import { teeSink } from "../src/observability/file-sink.js";
import { captureScreen, ffmpegAvailable, primaryMonitor, type CaptureBackend, type CaptureSource } from "../src/tft/capture.js";
import { fingerprint, readBoard } from "../src/tft/vision.js";
import { ensureMeta } from "../src/tft/meta.js";
import { adviseAugmentWithJev, adviseAugmentWithText, adviseWithJev, adviseWithText, createJevAsk, createJevAugmentAsk } from "../src/tft/advisor.js";
import { TftStore } from "../src/tft/store.js";
import { startTftServer } from "../src/tft/server.js";
import type { Meta } from "../src/tft/types.js";

loadEnvFile();
const env = (name: string): string | undefined => { const v = process.env[name]?.trim(); return v ? v : undefined; };
const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const log = createLogger({ write: teeSink("logs/tft.log"), bindings: { component: "tft" } });

const veniceKey = env("VENICE_API_KEY");
if (!veniceKey) { console.error("VENICE_API_KEY is not set"); process.exit(1); }
const dataDir = env("TFT_DATA") ?? "data/tft";
mkdirSync(join(dataDir, "shots"), { recursive: true });
const visionModel = env("TFT_VISION_MODEL") ?? "qwen-3-8-flash";
// Used for a few cycles after a 429 from the main vision model.
const visionFallback = env("TFT_VISION_FALLBACK") ?? "z-ai-glm-5-3-flash";
let fallbackUntil = 0;
const metaModel = env("TFT_META_MODEL") ?? "qwen-3-8-flash";
const adviceModel = env("TFT_ADVICE_MODEL") ?? "qwen-3-8-flash";
const intervalMs = Number(opt("interval") ?? env("TFT_INTERVAL_S") ?? 8) * 1000;
const port = Number(env("TFT_PORT") ?? 8788);
const width = Number(env("TFT_CAPTURE_WIDTH") ?? 1600);
const store = TftStore.open(join(dataDir, "tft.sqlite"));
const ffmpeg = env("FFMPEG") ?? "ffmpeg";
const backend: CaptureBackend = (env("TFT_CAPTURE") as CaptureBackend | undefined) ?? ((await ffmpegAvailable(ffmpeg)) ? "ffmpeg" : "powershell");
// The game window first (TFT_WINDOW_TITLE), then the primary monitor, then everything.
const windowTitle = env("TFT_WINDOW_TITLE") ?? "League of Legends (TM) Client";
const primary = backend === "ffmpeg" ? await primaryMonitor() : undefined;
const sources: CaptureSource[] = [{ kind: "window", title: windowTitle }, ...(primary ? [{ kind: "region" as const, x: 0, y: 0, w: primary.w, h: primary.h }] : []), { kind: "desktop" }];
log.info("capture backend", { backend, windowTitle, primary: primary ? `${primary.w}x${primary.h}` : "unknown", hint: backend === "powershell" ? "ffmpeg not found; if Defender blocks the script: winget install Gyan.FFmpeg, then restart" : "" });
const typesafeKey = env("TYPESAFE_API_KEY");
const jevClient = typesafeKey ? new TypeSafeClient({ apiKey: typesafeKey, timeout: 15_000, retry: { maxRetries: 0 }, logLevel: "off" }) : undefined;
const jev = jevClient ? createJevAsk(jevClient) : undefined;
const jevAugment = jevClient ? createJevAugmentAsk(jevClient) : undefined;
let jevDown: string | undefined;
// A 402 from Venice pauses everything for a minute instead of knocking every 8 s.
let venicePausedUntil = 0; let veniceError: string | undefined;

// ---- measure mode: recognition rate on hand-labelled screenshots ----
const measureDir = opt("measure");
if (measureDir) {
  if (!existsSync(measureDir)) { console.error(`Ordner nicht gefunden: ${measureDir}. Screenshots aus Planungsphasen (Win+Druck landet in Bilder\\Screenshots) in einen Ordner legen und den Pfad angeben.`); process.exit(1); }
  const files = readdirSync(measureDir).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort();
  if (!files.length) { console.error(`Keine Bilder (png/jpg/webp) in ${measureDir}.`); process.exit(1); }
  const out: Record<string, unknown>[] = [];
  for (const f of files) {
    const t0 = performance.now();
    try { const r = await readBoard(join(measureDir, f), { apiKey: veniceKey, model: visionModel }); out.push({ file: f, ms: Math.round(performance.now() - t0), tokens: r.usage, read: r.value }); console.log(f, JSON.stringify(r.value)); }
    catch (err) { out.push({ file: f, error: err instanceof Error ? err.message : String(err) }); console.log(f, "ERROR", err instanceof Error ? err.message : err); }
  }
  mkdirSync("reports", { recursive: true });
  writeFileSync("reports/tft-measure.json", JSON.stringify({ model: visionModel, at: new Date().toISOString(), results: out }, null, 2));
  console.log(`written reports/tft-measure.json (${out.length} files)`);
  process.exit(0);
}

// ---- server first, so the overlay has contact while the meta loads ----
let meta: Meta | undefined;
let lastFingerprint = "";
let metaError: string | undefined;
const status = () => ({ ...(veniceError ? { error: veniceError } : {}), capture: backend, vision: visionModel, advisor: jev && !jevDown ? "jev" : `text:${adviceModel}`, ...(jevDown ? { jev_error: jevDown.slice(0, 80) } : {}), meta: meta ? `${meta.patch || "?"} (${meta.comps.length} comps)` : metaError ? `Fehler: ${metaError.slice(0, 80)}` : "wird geladen …", interval_s: intervalMs / 1000 });
startTftServer({ store, meta: () => meta, status, log: (m, f) => log.info(m, f) }, port);

// ---- meta ----
async function loadMeta(force: boolean): Promise<void> {
  try {
    const m = await ensureMeta({ apiKey: veniceKey!, model: metaModel, cachePath: join(dataDir, "meta.json") }, force);
    meta = m.meta; metaError = undefined;
    log.info("meta", { fromCache: m.fromCache, set: meta.set, patch: meta.patch, comps: meta.comps.map((c) => `${c.name} ${c.tier}`), augments: meta.augments.length });
    lastFingerprint = "";
  } catch (err) { metaError = err instanceof Error ? err.message : String(err); log.error("meta fetch failed; advice is off until it works, retry in 2 min", { err: metaError }); setTimeout(() => void loadMeta(force), 120_000); }
  if (!metaError) return;
}
// Not awaited: the loop reads screenshots right away; advice starts once the meta is there.
void loadMeta(flag("refresh-meta"));

async function cycle(imagePath?: string): Promise<void> {
  const tc = performance.now();
  const cap = imagePath ? { path: imagePath, source: "file" } : await captureScreen(join(dataDir, "shots", `shot-${Date.now()}.jpg`), { width, backend, ffmpeg, sources });
  const shot = cap.path;
  const bytes = statSync(shot).size;
  log.info("captured", { shot, source: cap.source, kb: Math.round(bytes / 1024), ms: Math.round(performance.now() - tc) });
  const t0 = performance.now();
  const model = Date.now() < fallbackUntil ? visionFallback : visionModel;
  let r;
  try { r = await readBoard(shot, { apiKey: veniceKey!, model }, meta ? `TFT ${meta.set} patch ${meta.patch}. Champion names in this set include: ${[...new Set(meta.comps.flatMap((c) => [...c.core_units, ...c.carries]))].join(", ")}.` : ""); }
  catch (err) {
    if (err instanceof Error && / 429:/.test(err.message) && model === visionModel) { fallbackUntil = Date.now() + 120_000; log.warn("vision model overloaded; using the fallback for 2 min", { model: visionFallback }); r = await readBoard(shot, { apiKey: veniceKey!, model: visionFallback }, ""); }
    else throw err;
  }
  const fp = fingerprint(r.value);
  const reading = store.addReading(shot, r.value, fp, r.usage.model, Math.round(performance.now() - t0), r.usage);
  log.info("read", { id: reading.id, phase: r.value.phase, stage: r.value.stage, gold: r.value.gold, lvl: r.value.level, hp: r.value.hp, ...(r.value.augment_options.length ? { augment_options: r.value.augment_options } : {}), shop: r.value.shop, board: r.value.board.map((u) => `${u.name}${u.stars > 1 ? "*" + u.stars : ""}`), bench: r.value.bench.map((u) => u.name), ms: reading.latency_ms, conf: r.value.confidence });
  if (!meta || r.value.phase === "not_tft" || r.value.phase === "loading" || r.value.phase === "unknown") return;
  const augmentChoice = r.value.phase === "augment_choice" && r.value.augment_options.length >= 2;
  if (!augmentChoice && r.value.board.length === 0 && r.value.shop.every((s) => !s)) return;
  // Stage 1 is PvE with no gold to spend; turn advice starts at 2-1. Augment choices count at any stage.
  if (!augmentChoice && /^1-/.test(r.value.stage)) return;
  if (fp === lastFingerprint) return;
  lastFingerprint = fp;
  let result;
  if (jev && jevAugment && !jevDown) {
    try { result = augmentChoice ? await adviseAugmentWithJev(r.value, meta, jevAugment) : await adviseWithJev(r.value, meta, jev); }
    catch (err) { jevDown = err instanceof Error ? err.message : String(err); log.warn("jev failed; falling back to the text model", { err: jevDown }); }
  }
  if (!result) result = augmentChoice ? await adviseAugmentWithText(r.value, meta, { apiKey: veniceKey!, model: adviceModel }) : await adviseWithText(r.value, meta, { apiKey: veniceKey!, model: adviceModel });
  store.addAdvice(reading.id, result.advice, result.usage);
  log.info("advice", { ...(result.advice.augment ? { augment: result.advice.augment.pick, options: result.advice.augment.options } : {}), comp: result.advice.comp, action: result.advice.action, buy: result.advice.buy, source: result.advice.source, ms: result.advice.latencyMs, reasons: result.advice.reasons });
}

const image = opt("image");
if (image && !existsSync(image)) { console.error(`no such file: ${image}`); process.exit(1); }
if (flag("once") || image) {
  await cycle(image).catch((err) => log.error("cycle failed", { err: err instanceof Error ? err.message : String(err) }));
  log.info("done; the page stays up on http://127.0.0.1:" + port + " until Ctrl+C");
} else {
  log.info("loop", { intervalMs, port, overlay: "powershell -ExecutionPolicy Bypass -File scripts\\tft-overlay.ps1" });
  let n = 0;
  const loop = async () => {
    const t = performance.now();
    if (Date.now() < venicePausedUntil) { setTimeout(loop, 5000); return; }
    try { await cycle(); veniceError = undefined; }
    catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("cycle failed", { n, err: msg });
      if (/ 402:|Insufficient .* balance/i.test(msg)) { veniceError = "Venice: kein Guthaben (402), Pause 60 s"; venicePausedUntil = Date.now() + 60_000; }
    }
    n++; setTimeout(loop, Math.max(1000, intervalMs - (performance.now() - t)));
  };
  void loop();
}
