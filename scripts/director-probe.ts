/**
 * Records what the Venice video API really answers, so the field names in
 * src/director/venice.ts (ENDPOINTS, the quote / queue / retrieve parsers)
 * can be corrected from evidence instead of docs. Costs nothing: it calls
 * GET /models and POST /video/quote only; a quote is not a job.
 *
 *   pnpm director:probe                       # models + a T2V quote
 *   pnpm director:probe -- --image path.png   # plus an R2V quote with one reference
 *
 * Output: reports/venice-probe.json (raw responses, key redacted).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { loadEnvFile } from "../src/app/env.js";
import { VeniceClient, ENDPOINTS } from "../src/director/venice.js";

loadEnvFile();
const key = process.env["VENICE_API_KEY"]?.trim() || undefined;
if (!key) { console.error("VENICE_API_KEY is not set"); process.exit(1); }
const argv = process.argv.slice(2);
const opt = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const image = opt("image");
const out: Record<string, unknown> = { at: new Date().toISOString(), endpoints: ENDPOINTS };

const raw = async (path: string, init?: { method?: string; body?: string }) => {
  const r = await fetch(`${ENDPOINTS.base}${path}`, { ...init, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" } });
  const text = await r.text();
  let json: unknown; try { json = JSON.parse(text); } catch { json = text.slice(0, 4000); }
  return { status: r.status, headers: Object.fromEntries([...r.headers.entries()].filter(([k]) => !/auth|cookie|key/i.test(k))), body: json };
};

out["models_video"] = await raw(`${ENDPOINTS.models}?type=video`);
out["models_text_ids"] = (((await raw(`${ENDPOINTS.models}?type=text`)).body as { data?: { id: string }[] })?.data ?? []).map((m) => m.id);
const client = new VeniceClient({ apiKey: key });
const t2v = { model: "seedance-2-0-text-to-video-basic", prompt: "Wide shot. Slow dolly in. A paper boat drifts across a puddle and bumps the kerb. Soft overcast light.", duration: "5s", aspect_ratio: "16:9", resolution: "480p" };
out["quote_t2v_body"] = client.wireBody(t2v);
out["quote_t2v"] = await raw(ENDPOINTS.quote, { method: "POST", body: JSON.stringify(client.wireBody(t2v)) });
if (image) {
  const r2v = { ...t2v, model: "seedance-2-0-reference-to-video-basic", prompt: `Refer to <Subject 1> in <Image 1> to generate a clip. ${t2v.prompt}`, reference_images: [{ slot: "Image 1", role: "identity", path: image }] };
  const body = client.wireBody(r2v);
  out["quote_r2v_body_keys"] = Object.keys(body);
  out["quote_r2v"] = await raw(ENDPOINTS.quote, { method: "POST", body: JSON.stringify(body) });
}
mkdirSync("reports", { recursive: true });
writeFileSync("reports/venice-probe.json", JSON.stringify(out, null, 2));
console.log(JSON.stringify({ models_video: (out["models_video"] as { status: number }).status, quote_t2v: (out["quote_t2v"] as { status: number }).status, quote_r2v: image ? (out["quote_r2v"] as { status: number }).status : "skipped", file: "reports/venice-probe.json" }));
