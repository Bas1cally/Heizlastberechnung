import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { TftStore } from "./store.js";
import type { Advice, BoardRead, Meta } from "./types.js";

/**
 * Two consumers: the PowerShell overlay polls /api/advice (three lines of
 * text), the browser page shows the last screenshot, what the reader saw and
 * what the advisor said, refreshed every few seconds.
 */
export interface TftServerDeps { readonly store: TftStore; readonly meta: () => Meta | undefined; readonly status: () => Record<string, unknown>; readonly log: (msg: string, fields?: Record<string, unknown>) => void }

export function overlayText(advice: Advice | undefined, read: BoardRead | undefined): { line1: string; line2: string; line3: string } {
  if (!advice) return { line1: read ? `Stage ${read.stage || "?"} · ${read.gold} Gold · Lvl ${read.level}` : "TFT-Berater wartet auf Screenshot", line2: read?.phase === "not_tft" ? "Kein TFT im Bild" : "noch kein Rat", line3: "" };
  const act = { ROLL: "Rollen", LEVEL: "Leveln", SAVE: "Sparen", BUY: "Kaufen" }[advice.action];
  return { line1: `${advice.comp}${advice.confidence ? ` (${Math.round(advice.confidence * 100)}%)` : ""}`, line2: `${act}${advice.buy.length ? `: ${advice.buy.join(", ")}` : ""}`, line3: `Kurs ${Math.round(advice.onTrack * 100)}% · Druck ${advice.urgency} · ${advice.source} ${advice.latencyMs} ms` };
}

export function createTftApi(d: TftServerDeps) {
  return {
    advice: () => {
      const a = d.store.lastAdvice(); const r = d.store.lastReading();
      const advice = a ? (JSON.parse(a.advice_json) as Advice) : undefined; const read = r ? (JSON.parse(r.read_json) as BoardRead) : undefined;
      return { ...overlayText(advice, read), advice: advice ?? null, read: read ?? null, readAt: r?.ts ?? null, adviceAt: a?.ts ?? null, screenshot: r?.screenshot ?? null, totals: d.store.totals(), status: d.status() };
    },
    meta: () => d.meta() ?? null,
  };
}

export function startTftServer(d: TftServerDeps, port: number, host = "127.0.0.1"): Server {
  const api = createTftApi(d);
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const json = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" }); res.end(JSON.stringify(body)); };
    try {
      if (url.pathname === "/api/advice") return json(200, api.advice());
      if (url.pathname === "/api/meta") return json(200, api.meta());
      if (url.pathname === "/shot") { const r = d.store.lastReading(); if (!r || !existsSync(r.screenshot)) return json(404, { error: "no screenshot" }); res.writeHead(200, { "content-type": "image/jpeg", "content-length": statSync(r.screenshot).size, "cache-control": "no-store" }); createReadStream(r.screenshot).pipe(res); return; }
      if (url.pathname === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(PAGE); return; }
      json(404, { error: "not found" });
    } catch (err) { json(500, { error: err instanceof Error ? err.message : String(err) }); }
  });
  server.listen(port, host, () => d.log(`tft advisor on http://${host}:${port}`));
  return server;
}

const PAGE = `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>TFT-Berater</title>
<style>body{margin:0;font:15px/1.5 system-ui,sans-serif;background:#111;color:#eee}main{padding:16px;max-width:1200px;margin:0 auto}h1{font-size:20px}.row{display:flex;gap:16px;flex-wrap:wrap}.col{flex:1;min-width:320px}
.big{font-size:26px;font-weight:700}.mid{font-size:19px}.muted{color:#999}pre{background:#1c1c1c;padding:10px;border-radius:8px;font-size:12px;white-space:pre-wrap;max-height:60vh;overflow:auto}img{max-width:100%;border:1px solid #333;border-radius:8px}</style></head>
<body><main><h1>TFT-Berater <span class="muted" id="st"></span></h1><div class="row"><div class="col"><div class="big" id="l1">…</div><div class="mid" id="l2"></div><div class="muted" id="l3"></div><h3>Gelesen</h3><pre id="read"></pre><h3>Rat</h3><pre id="adv"></pre></div><div class="col"><img id="shot" alt="letzter Screenshot"><p class="muted" id="ts"></p></div></div></main>
<script>async function tick(){try{const r=await fetch("/api/advice");const j=await r.json();document.getElementById("l1").textContent=j.line1;document.getElementById("l2").textContent=j.line2;document.getElementById("l3").textContent=j.line3;
document.getElementById("read").textContent=j.read?JSON.stringify(j.read,null,1):"–";document.getElementById("adv").textContent=j.advice?JSON.stringify(j.advice,null,1):"–";
document.getElementById("st").textContent=Object.entries(j.status).map(([k,v])=>k+": "+v).join(" · ")+" · Lesungen "+j.totals.readings+" · Ratschläge "+j.totals.advices;
if(j.readAt){document.getElementById("shot").src="/shot?t="+j.readAt;document.getElementById("ts").textContent="gelesen "+new Date(j.readAt).toLocaleTimeString("de")+(j.adviceAt?" · Rat "+new Date(j.adviceAt).toLocaleTimeString("de"):"")}}catch(e){}}
tick();setInterval(tick,3000);</script></body></html>`;
