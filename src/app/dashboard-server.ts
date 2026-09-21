import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Db } from "../persistence/database.js";
import { DecisionRepository } from "../persistence/repositories/decisions.js";
import { percentiles } from "../analytics/latency.js";
import { directionalProbability } from "../analytics/edge-analysis.js";
import { collectTrading } from "./trading-view.js";

/**
 * A small read-mostly dashboard over the bot's database. Runs as its own
 * process; the only writes it makes are operator controls (kill / resume),
 * which the bot polls from the `control` table.
 */
export function collectState(db: Db, nowMs: number): Record<string, unknown> {
  const repo = new DecisionRepository(db);
  const hb = (c: string) => { const r = repo.getControl(`heartbeat:${c}`); return r ? { ...(JSON.parse(r.value) as object), ageS: Number(((nowMs - r.updatedMs) / 1000).toFixed(1)) } : null; };
  const kill = repo.getControl("kill");
  const last = db.get<{ decision_id: string; market_id: string; timestamp_ms: number; state_json: string; answers_json: string; requested_action: string; risk_result: string; risk_reason: string | null; jev_latency_ms: number; model: string; input_tokens: number; output_tokens: number; material_reason: string | null; slug: string }>(
    `SELECT r.decision_id, r.market_id, r.timestamp_ms, r.state_json, a.answers_json, a.requested_action, a.risk_result, a.risk_reason, r.jev_latency_ms, r.model, r.input_tokens, r.output_tokens, r.material_reason, m.slug
     FROM jev_requests r JOIN jev_answers a USING (decision_id) JOIN markets m USING (market_id) ORDER BY r.timestamp_ms DESC LIMIT 1`);
  const recent = (ms: number) => db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM jev_requests WHERE timestamp_ms > ?`, [nowMs - ms])?.n ?? 0;
  const actions = db.all<{ a: string; n: number }>(`SELECT requested_action AS a, COUNT(*) AS n FROM jev_answers a JOIN jev_requests r USING (decision_id) WHERE r.timestamp_ms > ? GROUP BY 1 ORDER BY 2 DESC`, [nowMs - 3_600_000]);
  const risk = db.all<{ r: string; reason: string | null; n: number }>(`SELECT risk_result AS r, risk_reason AS reason, COUNT(*) AS n FROM jev_answers a JOIN jev_requests r USING (decision_id) WHERE r.timestamp_ms > ? GROUP BY 1,2 ORDER BY 3 DESC`, [nowMs - 3_600_000]);
  const jev = db.all<{ ms: number }>(`SELECT jev_latency_ms AS ms FROM jev_requests WHERE timestamp_ms > ?`, [nowMs - 3_600_000]).map((x) => x.ms);
  const tokens = db.get<{ i: number; o: number; n: number }>(`SELECT COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o, COUNT(*) AS n FROM jev_requests`);
  const markets = db.get<{ n: number; resolved: number }>(`SELECT COUNT(*) AS n, SUM(CASE WHEN resolved_outcome IS NOT NULL THEN 1 ELSE 0 END) AS resolved FROM markets`);
  const ticks = db.get<{ last: number | null }>(`SELECT MAX(received_at_ms) AS last FROM ticks`);
  const books = db.get<{ last: number | null }>(`SELECT MAX(received_at_ms) AS last FROM orderbook_snapshots`);
  const errors = db.all<{ ts_ms: number; component: string; message: string }>(`SELECT ts_ms, component, message FROM errors ORDER BY ts_ms DESC LIMIT 8`);
  const shadow = db.get<{ n: number; fills: number; nofill: number }>(`SELECT COUNT(*) AS n, SUM(CASE WHEN hypothetical_status='FILLED' THEN 1 ELSE 0 END) AS fills, SUM(CASE WHEN hypothetical_status='NO_FILL' THEN 1 ELSE 0 END) AS nofill FROM shadow_orders`);
  const recentMarkets = db.all<{ slug: string; resolved_outcome: string | null; closes_at_ms: number; n: number }>(`SELECT m.slug, m.resolved_outcome, m.closes_at_ms, (SELECT COUNT(*) FROM jev_requests r WHERE r.market_id = m.market_id) AS n FROM markets m ORDER BY m.opened_at_ms DESC LIMIT 12`);

  let lastDecision: Record<string, unknown> | null = null;
  if (last) {
    const s = JSON.parse(last.state_json); const a = JSON.parse(last.answers_json);
    const dir = a.settlement_direction ? directionalProbability(a.settlement_direction) : null;
    const probs = a.action?.probabilities ? Object.entries(a.action.probabilities as Record<string, number>).sort((x, y) => y[1] - x[1]).slice(0, 3) : [];
    lastDecision = {
      slug: last.slug, at: last.timestamp_ms, ageS: Number(((nowMs - last.timestamp_ms) / 1000).toFixed(1)),
      secondsRemaining: s.market?.secondsRemaining, distanceBps: s.market?.distanceBps, settlementStart: s.market?.settlementStartPrice, settlementCurrent: s.market?.settlementCurrentPrice,
      upBid: s.orderbook?.upBid, upAsk: s.orderbook?.upAsk, downBid: s.orderbook?.downBid, downAsk: s.orderbook?.downAsk, pairAskCost: s.orderbook?.pairAskCost, pairEdge: s.orderbook?.pairEdge,
      inventory: s.inventory, pUp: dir?.pUp, pDown: dir?.pDown, unresolved: dir?.unresolvedMass,
      action: last.requested_action, actionProbs: probs, risk: last.risk_result, riskReason: last.risk_reason, jevMs: last.jev_latency_ms, model: last.model, tokens: [last.input_tokens, last.output_tokens], materialReason: last.material_reason,
    };
  }
  return {
    now: nowMs,
    bot: { observer: hb("observer"), shadow: hb("shadow") },
    kill: kill ? { ...(JSON.parse(kill.value) as object), updatedMs: kill.updatedMs } : { tripped: false },
    feeds: { chainlinkAgeS: ticks?.last ? Number((Math.max(0, nowMs - ticks.last) / 1000).toFixed(1)) : null, bookAgeS: books?.last ? Number((Math.max(0, nowMs - books.last) / 1000).toFixed(1)) : null },
    decisions: { total: tokens?.n ?? 0, lastMinute: recent(60_000), lastHour: recent(3_600_000) },
    tokens: { input: tokens?.i ?? 0, output: tokens?.o ?? 0 },
    markets: { total: markets?.n ?? 0, resolved: markets?.resolved ?? 0, recent: recentMarkets },
    jevLatencyHour: percentiles(jev),
    actionsHour: Object.fromEntries(actions.map((r) => [r.a, r.n])),
    riskHour: risk,
    shadow: shadow && shadow.n > 0 ? shadow : null,
    errors,
    lastDecision,
  };
}

const HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>jev-btc-5m</title>
<style>
:root{--bg:#0f1115;--card:#171a21;--fg:#e6e6e6;--mut:#8a919e;--ok:#3fb950;--warn:#d29922;--bad:#f85149;--line:#262a33;
 /* data-viz roles, validated on the card surface: series-1 (line), diverging poles (bars) */
 --series-1:#3987e5;--pos:#3987e5;--neg:#e66767;--grid:#262a33;--surface-1:#171a21}
.trading{grid-column:1/-1}.hero{display:flex;gap:28px;align-items:baseline;flex-wrap:wrap}.hero .big{font-size:44px;line-height:1}.hero .lbl{display:block;font-size:11px;color:var(--mut);text-transform:uppercase;letter-spacing:.06em}
.badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;border:1px solid var(--line);color:var(--mut)}
.badge.sim{border-color:var(--warn);color:var(--warn)}.badge.live{border-color:var(--ok);color:var(--ok)}
table{width:100%;border-collapse:collapse;font-size:12px}th{text-align:left;color:var(--mut);font-weight:500;padding:4px 6px;border-bottom:1px solid var(--line)}td{padding:4px 6px;border-bottom:1px dashed var(--line);white-space:nowrap}td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
svg text{fill:var(--mut);font-size:11px}.tip{position:absolute;pointer-events:none;background:#0f1115;border:1px solid var(--line);border-radius:6px;padding:6px 8px;font-size:12px;display:none}
.tabs{display:flex;gap:6px;margin-bottom:10px}.tabs button{background:transparent;color:var(--mut);border:1px solid var(--line)}.tabs button.on{color:var(--fg);border-color:var(--fg)}
.two{display:grid;grid-template-columns:1.4fr 1fr;gap:14px}@media(max-width:900px){.two{grid-template-columns:1fr}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
header{display:flex;align-items:center;gap:16px;padding:12px 20px;border-bottom:1px solid var(--line)}header h1{font-size:16px;margin:0;font-weight:600}
.dot{width:10px;height:10px;border-radius:50%;display:inline-block;background:var(--mut)}.ok{background:var(--ok)}.warn{background:var(--warn)}.bad{background:var(--bad)}
main{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:14px;padding:16px 20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px}.card h2{margin:0 0 10px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--mut)}
.big{font-size:28px;font-weight:600}.mut{color:var(--mut)}.row{display:flex;justify-content:space-between;gap:10px;padding:3px 0;border-bottom:1px dashed var(--line)}.row:last-child{border:0}
button{background:#2b1d1d;color:#ffb4b4;border:1px solid var(--bad);border-radius:6px;padding:8px 14px;font:inherit;cursor:pointer}button.resume{background:#1a2b1d;color:#b4ffc0;border-color:var(--ok)}
.kill{grid-column:1/-1;display:flex;align-items:center;gap:16px;flex-wrap:wrap}.bar{height:8px;background:#222;border-radius:4px;overflow:hidden}.bar i{display:block;height:100%;background:#4c8dff}
pre{margin:0;white-space:pre-wrap;color:var(--mut);font-size:12px}small{color:var(--mut)}
</style></head><body>
<header><span id="botdot" class="dot"></span><h1>jev-btc-5m</h1><span id="mode" class="mut"></span><span id="clock" class="mut" style="margin-left:auto"></span></header>
<main>
<section class="card kill"><span id="killdot" class="dot"></span><div style="flex:1"><div id="killtext" class="big">—</div><small id="killsub"></small></div>
<button id="killbtn" onclick="act('kill')">KILL — stop new orders</button><button id="resumebtn" class="resume" onclick="act('resume')">Resume</button></section>
<section class="card trading"><h2>Trading <span id="tbadge" class="badge">no execution records</span></h2>
<div class="tabs"><button id="tab-paper" class="on" onclick="setMode('paper')">Paper (simulated)</button><button id="tab-live" onclick="setMode('live')">Live</button></div>
<div id="tempty" class="mut">No orders yet. Observe mode never trades. Run <code>pnpm bot:paper</code> for a simulated result, or shadow / live later.</div>
<div id="tbody" style="display:none">
 <div class="hero"><div><span class="lbl">net pnl</span><span id="tnet" class="big">—</span></div><div><span class="lbl">markets</span><span id="tmk" class="big">—</span></div><div><span class="lbl">win / loss</span><span id="twl" class="big">—</span></div><div><span class="lbl">max drawdown</span><span id="tdd" class="big">—</span></div><div><span class="lbl">fill ratio</span><span id="tfr" class="big">—</span></div></div>
 <div class="two" style="margin-top:14px">
  <div><div class="lbl mut" style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">cumulative net pnl by market close</div><div style="position:relative"><svg id="curve" width="100%" height="220" viewBox="0 0 640 220" preserveAspectRatio="none"></svg><div id="ctip" class="tip"></div></div>
   <div class="lbl mut" style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;margin:10px 0 6px">net pnl per market (last 40)</div><div style="position:relative"><svg id="bars" width="100%" height="120" viewBox="0 0 640 120" preserveAspectRatio="none"></svg><div id="btip" class="tip"></div></div></div>
  <div><div id="tpos"></div><div id="tstats"></div></div>
 </div>
 <div class="lbl mut" style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;margin:14px 0 6px">recent fills</div><div style="overflow:auto"><table id="tfills"><thead><tr><th>time</th><th>market</th><th>side</th><th>type</th><th class="num">price</th><th class="num">size</th><th class="num">fee</th></tr></thead><tbody></tbody></table></div>
</div></section>
<section class="card"><h2>Current market</h2><div id="market"></div></section>
<section class="card"><h2>Jev</h2><div id="jev"></div></section>
<section class="card"><h2>Feeds &amp; process</h2><div id="feeds"></div></section>
<section class="card"><h2>Last hour</h2><div id="hour"></div></section>
<section class="card"><h2>Recent markets</h2><div id="markets"></div></section>
<section class="card"><h2>Errors</h2><pre id="errors"></pre></section>
</main>
<script>
const $=id=>document.getElementById(id);const f=(v,d=3)=>v==null||Number.isNaN(v)?'—':(+v).toFixed(d);const pct=v=>v==null?'—':(v*100).toFixed(1)+'%';
const row=(k,v)=>'<div class="row"><span class="mut">'+k+'</span><span>'+v+'</span></div>';
async function act(a){const reason=a==='kill'?prompt('Reason (logged):','manual'):null;if(a==='kill'&&reason===null)return;await fetch('/api/'+a,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({reason})});load();}
async function load(){try{const s=await (await fetch('/api/state')).json();render(s);}catch(e){$('botdot').className='dot bad';}}
function render(s){
 $('clock').textContent=new Date(s.now).toLocaleTimeString();
 const hb=s.bot.observer||s.bot.shadow;const alive=hb&&hb.ageS<10;$('botdot').className='dot '+(alive?'ok':'bad');$('mode').textContent=hb?(s.bot.shadow&&s.bot.shadow.ageS<10?'shadow':'observe')+(alive?' · running':' · no heartbeat for '+hb.ageS+'s'):'no bot heartbeat';
 const k=s.kill;$('killdot').className='dot '+(k.tripped?'bad':'ok');$('killtext').textContent=k.tripped?'KILLED: '+(k.reasons||[]).join(', '):'armed · not tripped';$('killsub').textContent=k.tripped?('since '+new Date(k.since||k.updatedMs).toLocaleTimeString()+(k.hard?' · hard reason, needs Resume':' · transient, clears on recovery')):'kill stops new orders, cancels resting ones, never liquidates';
 const d=s.lastDecision;
 $('market').innerHTML=d?row('slug',d.slug)+row('remaining',f(d.secondsRemaining,1)+' s')+row('Δ settlement',(d.distanceBps>=0?'+':'')+f(d.distanceBps,2)+' bps')+row('start / now',f(d.settlementStart,2)+' / '+f(d.settlementCurrent,2))+row('UP bid/ask',f(d.upBid)+' / '+f(d.upAsk))+row('DOWN bid/ask',f(d.downBid)+' / '+f(d.downAsk))+row('pair cost / edge',f(d.pairAskCost,4)+' / '+f(d.pairEdge,4))+row('inventory',(d.inventory?d.inventory.upShares+' UP · '+d.inventory.downShares+' DOWN · paired '+d.inventory.pairedShares:'—'))+row('last decision',d.ageS+' s ago ('+d.materialReason+')'):'<span class="mut">no decisions yet</span>';
 $('jev').innerHTML=d?'<div class="big">'+d.action+'</div><small>'+(d.actionProbs||[]).map(p=>p[0]+' '+(p[1]*100).toFixed(0)+'%').join(' · ')+'</small>'+row('P(UP) / P(DOWN)',pct(d.pUp)+' / '+pct(d.pDown))+row('unresolved mass',f(d.unresolved))+'<div class="bar"><i style="width:'+((d.pUp||0)*100)+'%"></i></div>'+row('risk',d.risk+(d.riskReason?' ('+d.riskReason+')':''))+row('latency',f(d.jevMs,0)+' ms')+row('tokens',d.tokens[0]+' / '+d.tokens[1])+row('model',d.model):'';
 $('feeds').innerHTML=row('chainlink age',s.feeds.chainlinkAgeS==null?'—':s.feeds.chainlinkAgeS+' s')+row('book age',s.feeds.bookAgeS==null?'—':s.feeds.bookAgeS+' s')+row('heartbeat',hb?hb.ageS+' s ago':'—')+row('decisions total',s.decisions.total)+row('tokens total',s.tokens.input.toLocaleString()+' / '+s.tokens.output.toLocaleString())+row('markets',s.markets.total+' ('+s.markets.resolved+' resolved by feed)')+(s.shadow?row('shadow orders',s.shadow.n+' · would fill '+s.shadow.fills+' · miss '+s.shadow.nofill):'');
 const L=s.jevLatencyHour;$('hour').innerHTML=row('decisions / min',s.decisions.lastMinute)+row('decisions / hour',s.decisions.lastHour)+row('jev p50 / p95 / max',f(L.p50,0)+' / '+f(L.p95,0)+' / '+f(L.max,0)+' ms')+Object.entries(s.actionsHour).map(([a,n])=>row(a,n)).join('')+s.riskHour.map(r=>row(r.r+(r.reason?' · '+r.reason:''),r.n)).join('');
 $('markets').innerHTML=s.markets.recent.map(m=>row(m.slug.replace('btc-updown-5m-',''),(m.resolved_outcome||(m.closes_at_ms>s.now?'live':'?'))+' · '+m.n+' dec')).join('');
 renderTrading(s.trading||{});
 $('errors').textContent=s.errors.length?s.errors.map(e=>new Date(e.ts_ms).toLocaleTimeString()+' '+e.component+': '+e.message).join('\\n'):'none';
}
let mode=localStorage.getItem('tmode')||'paper';function setMode(m){mode=m;localStorage.setItem('tmode',m);load();}
const money=v=>(v>=0?'+':'')+(+v).toFixed(2)+' $';
function renderTrading(tr){
 $('tab-paper').className=mode==='paper'?'on':'';$('tab-live').className=mode==='live'?'on':'';
 const t=tr[mode];const badge=$('tbadge');
 if(!t){badge.className='badge';badge.textContent=mode==='paper'?'no paper run yet':'no live records';$('tempty').style.display='';$('tbody').style.display='none';return;}
 badge.className='badge '+(mode==='paper'?'sim':'live');badge.textContent=mode==='paper'?'SIMULATED — not real money':'LIVE';
 $('tempty').style.display='none';$('tbody').style.display='';
 $('tnet').textContent=money(t.netPnl);
 $('tmk').textContent=t.settledMarkets;$('twl').textContent=t.wins+' / '+t.losses;$('tdd').textContent='−'+(+t.maxDrawdown).toFixed(2)+' $';$('tfr').textContent=t.fillRatio==null?'—':(t.fillRatio*100).toFixed(0)+'%';
 $('tpos').innerHTML=t.openPosition?'<div class="lbl mut" style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">open position · '+t.openPosition.slug.replace('btc-updown-5m-','')+'</div>'+row('UP / DOWN shares',t.openPosition.upShares+' / '+t.openPosition.downShares)+row('paired',t.openPosition.pairedShares)+row('cost',(+t.openPosition.totalCost).toFixed(2)+' $')+row('pnl if UP / DOWN',money(t.openPosition.pnlIfUp)+' / '+money(t.openPosition.pnlIfDown)):'<div class="mut" style="margin-bottom:8px">no open position</div>';
 $('tstats').innerHTML=row('gross pnl',money(t.grossPnl))+row('merge pnl',money(t.mergePnl))+row('fees / gas',(+t.fees).toFixed(2)+' / '+(+t.gas).toFixed(2)+' $')+row('best / worst market',(t.bestMarket==null?'—':money(t.bestMarket))+' / '+(t.worstMarket==null?'—':money(t.worstMarket)))+row('orders → filled / partial / missed',t.orders+' → '+t.fills+' / '+t.partials+' / '+t.noFills)+row('volume',(+t.volumeUsd).toFixed(2)+' $');
 drawCurve(t.curve);drawBars(t.perMarket.slice().reverse());
 $('tfills').querySelector('tbody').innerHTML=t.recentFills.map(f=>'<tr><td>'+new Date(f.tsMs).toLocaleTimeString()+'</td><td>'+f.slug.replace('btc-updown-5m-','')+'</td><td>'+f.side+'</td><td>'+f.orderType+'</td><td class="num">'+(+f.price).toFixed(3)+'</td><td class="num">'+(+f.size).toFixed(0)+'</td><td class="num">'+(+f.fee).toFixed(3)+'</td></tr>').join('')||'<tr><td colspan="7" class="mut">none</td></tr>';
}
function ticks(min,max,n){const span=max-min||1;const raw=span/n;const p=Math.pow(10,Math.floor(Math.log10(raw)));const s=[1,2,5,10].map(x=>x*p).find(x=>x>=raw);const out=[];for(let v=Math.ceil(min/s)*s;v<=max+1e-9;v+=s)out.push(+v.toFixed(6));return out;}
function drawCurve(c){const svg=$('curve');const W=640,H=220,L=44,R=12,T=12,Bt=24;if(!c.length){svg.innerHTML='';return;}
 const ys=c.map(p=>p.pnl).concat([0]);const ymin=Math.min(...ys),ymax=Math.max(...ys);const x=i=>L+(c.length===1?0:(i/(c.length-1))*(W-L-R));const y=v=>T+(1-(v-ymin)/((ymax-ymin)||1))*(H-T-Bt);
 let s='';for(const tv of ticks(ymin,ymax,4))s+='<line x1="'+L+'" x2="'+(W-R)+'" y1="'+y(tv)+'" y2="'+y(tv)+'" stroke="var(--grid)" stroke-width="1"/><text x="'+(L-6)+'" y="'+(y(tv)+4)+'" text-anchor="end">'+tv+'</text>';
 s+='<line x1="'+L+'" x2="'+(W-R)+'" y1="'+y(0)+'" y2="'+y(0)+'" stroke="var(--mut)" stroke-width="1"/>';
 s+='<path d="'+c.map((p,i)=>(i?'L':'M')+x(i).toFixed(1)+' '+y(p.pnl).toFixed(1)).join(' ')+'" fill="none" stroke="var(--series-1)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>';
 const last=c[c.length-1];s+='<circle cx="'+x(c.length-1)+'" cy="'+y(last.pnl)+'" r="4" fill="var(--series-1)" stroke="var(--surface-1)" stroke-width="2"/>';
 s+='<text x="'+(x(c.length-1)-8)+'" y="'+(y(last.pnl)+(last.pnl>=0?-10:16))+'" text-anchor="end" style="fill:var(--fg)">'+money(last.pnl)+'</text>';
 s+='<text x="'+(W-R)+'" y="'+(H-6)+'" text-anchor="end">'+new Date(last.t).toLocaleTimeString()+'</text><text x="'+L+'" y="'+(H-6)+'">'+new Date(c[0].t).toLocaleTimeString()+'</text>';
 s+='<rect x="'+L+'" y="'+T+'" width="'+(W-L-R)+'" height="'+(H-T-Bt)+'" fill="transparent" id="chit"/>';svg.innerHTML=s;
 const hit=svg.querySelector('#chit'),tip=$('ctip');hit.onmousemove=e=>{const r=svg.getBoundingClientRect();const px=(e.clientX-r.left)/r.width*W;const i=Math.max(0,Math.min(c.length-1,Math.round((px-L)/((W-L-R)/Math.max(1,c.length-1)))));tip.style.display='block';tip.style.left=(e.clientX-r.left+12)+'px';tip.style.top=(e.clientY-r.top-10)+'px';tip.textContent=c[i].slug.replace('btc-updown-5m-','')+' · '+money(c[i].pnl);};hit.onmouseleave=()=>tip.style.display='none';}
function drawBars(m){const svg=$('bars');const W=640,H=120,L=44,R=12,T=8,Bt=8;if(!m.length){svg.innerHTML='';return;}
 const vals=m.map(r=>r.netPnl).concat([0]);const ymin=Math.min(...vals),ymax=Math.max(...vals);const y=v=>T+(1-(v-ymin)/((ymax-ymin)||1))*(H-T-Bt);const slot=(W-L-R)/m.length;const bw=Math.min(24,Math.max(2,slot-2));
 let s='<line x1="'+L+'" x2="'+(W-R)+'" y1="'+y(0)+'" y2="'+y(0)+'" stroke="var(--mut)" stroke-width="1"/>';
 m.forEach((r,i)=>{const x0=L+i*slot+(slot-bw)/2;const y0=Math.min(y(0),y(r.netPnl)),h=Math.max(1,Math.abs(y(r.netPnl)-y(0)));s+='<rect x="'+x0.toFixed(1)+'" y="'+y0.toFixed(1)+'" width="'+bw.toFixed(1)+'" height="'+h.toFixed(1)+'" rx="2" fill="'+(r.netPnl>=0?'var(--pos)':'var(--neg)')+'"><title>'+r.slug.replace('btc-updown-5m-','')+' · '+(r.outcome||'?')+' · '+money(r.netPnl)+' · '+r.fills+'/'+r.orders+' filled</title></rect>';});
 svg.innerHTML=s;}
load();setInterval(load,2000);
</script></body></html>`;

export function startDashboard(db: Db, port: number, log: (msg: string) => void, paperDb?: Db): () => void {
  const repo = new DecisionRepository(db);
  const json = (res: ServerResponse, code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const readBody = (req: IncomingMessage) => new Promise<string>((resolve) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => resolve(b)); });

  const server = createServer(async (req, res) => {
    try {
      const url = req.url ?? "/";
      if (req.method === "GET" && url === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(HTML); return; }
      if (req.method === "GET" && url === "/api/state") {
        const state = collectState(db, Date.now());
        // Execution records, grouped by mode so simulated and real money never share a number.
        const trading = {
          paper: paperDb ? collectTrading(paperDb, "paper") : null,
          live: collectTrading(db, "live"),
        };
        return json(res, 200, { ...state, trading });
      }
      if (req.method === "POST" && url === "/api/kill") {
        const body = await readBody(req).then((b) => (b ? (JSON.parse(b) as { reason?: string }) : {}));
        repo.setControl("kill", JSON.stringify({ tripped: true, reasons: ["MANUAL"], hard: true, since: Date.now(), note: body.reason ?? "manual" }), Date.now());
        log(`KILL requested from dashboard: ${body.reason ?? "manual"}`);
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && url === "/api/resume") {
        repo.setControl("kill", JSON.stringify({ tripped: false, resumedAt: Date.now() }), Date.now());
        log("RESUME requested from dashboard");
        return json(res, 200, { ok: true });
      }
      json(res, 404, { error: "not found" });
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
  server.listen(port, "127.0.0.1", () => log(`dashboard on http://127.0.0.1:${port}`));
  return () => server.close();
}
