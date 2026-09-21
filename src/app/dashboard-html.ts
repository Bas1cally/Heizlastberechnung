/**
 * The dashboard page. German, for an operator rather than a developer:
 * one status sentence at the top, plain words, the emergency stop with a
 * confirmation, and charts on the validated palette (series-1 blue for
 * Jev, slot-2 orange for the market; diverging blue/red for per-market PnL).
 */
export const HTML = String.raw`<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Jev · BTC 5-Minuten</title>
<style>
:root{--bg:#0f1115;--card:#171a21;--card2:#1d212a;--fg:#e8e8e8;--mut:#8f97a3;--line:#262a33;--ok:#0ca30c;--warn:#fab219;--bad:#d03b3b;
 --series-1:#3987e5;--series-2:#d95926;--pos:#3987e5;--neg:#e66767;--grid:#262a33;--surface-1:#171a21}
*{box-sizing:border-box}html{color-scheme:dark}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.num,.mono,td.num,.big,.hero .big,svg text{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-variant-numeric:tabular-nums}
header{position:sticky;top:0;z-index:2;background:rgba(15,17,21,.92);backdrop-filter:blur(6px);border-bottom:1px solid var(--line);padding:12px 22px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
header h1{font-size:17px;margin:0;font-weight:650}header .sent{color:var(--mut)}header .right{margin-left:auto;display:flex;gap:10px;align-items:center}
.dot{width:12px;height:12px;border-radius:50%;display:inline-block;background:var(--mut);flex:none}.dot.ok{background:var(--ok)}.dot.warn{background:var(--warn)}.dot.bad{background:var(--bad)}
.pill{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600;letter-spacing:.03em;border:1px solid var(--line);color:var(--mut)}
.pill.off{border-color:var(--ok);color:#9ee29e}.pill.sim{border-color:var(--warn);color:#ffd27a}.pill.live{border-color:var(--bad);color:#ffb4b4}
main{display:grid;grid-template-columns:repeat(12,1fr);gap:14px;padding:16px 22px 40px;max-width:1500px;margin:0 auto}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;grid-column:span 4;min-width:0}
.card.w6{grid-column:span 6}.card.w8{grid-column:span 8}.card.w12{grid-column:span 12}
@media(max-width:1100px){.card,.card.w6,.card.w8{grid-column:span 6}}@media(max-width:720px){.card,.card.w6,.card.w8,.card.w12{grid-column:span 12}}
.card h2{margin:0 0 4px;font-size:13px;font-weight:650;letter-spacing:.06em;text-transform:uppercase;color:var(--mut)}.card .sub{color:var(--mut);font-size:13px;margin:0 0 12px}
.big{font-size:30px;font-weight:650;line-height:1.15}.huge{font-size:40px;font-weight:700;line-height:1.1}
.row{display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px dashed var(--line)}.row:last-child{border:0}.row .k{color:var(--mut)}.row .v{text-align:right}
.hero{display:flex;gap:26px;flex-wrap:wrap;margin:6px 0 12px}.hero .lbl{display:block;font-size:11px;color:var(--mut);text-transform:uppercase;letter-spacing:.06em;margin-bottom:2px}
.bar{height:10px;background:#0d0f13;border:1px solid var(--line);border-radius:6px;overflow:hidden}.bar i{display:block;height:100%;background:var(--series-1)}
.split{display:flex;height:26px;border-radius:6px;overflow:hidden;border:1px solid var(--line);font-size:12px;font-weight:650}.split .up{background:var(--series-1);color:#fff;display:flex;align-items:center;padding-left:8px}.split .down{background:var(--series-2);color:#fff;display:flex;align-items:center;justify-content:flex-end;padding-right:8px;flex:1}
button{font:inherit;cursor:pointer;border-radius:8px;padding:9px 16px;border:1px solid var(--line);background:var(--card2);color:var(--fg)}
button.kill{background:#2a1416;border-color:var(--bad);color:#ffb4b4;font-weight:700}button.resume{background:#122417;border-color:var(--ok);color:#b4ffc0}
.killbox{display:flex;align-items:center;gap:18px;flex-wrap:wrap}.killbox .txt{flex:1;min-width:240px}
.badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;letter-spacing:.05em;text-transform:uppercase;border:1px solid var(--line);color:var(--mut);font-weight:600}
.badge.sim{border-color:var(--warn);color:#ffd27a}.badge.live{border-color:var(--bad);color:#ffb4b4}
table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;color:var(--mut);font-weight:600;padding:5px 6px;border-bottom:1px solid var(--line)}td{padding:5px 6px;border-bottom:1px dashed var(--line);white-space:nowrap}td.num,th.num{text-align:right}
.tabs{display:flex;gap:6px;margin:6px 0 12px}.tabs button{color:var(--mut)}.tabs button.on{color:var(--fg);border-color:var(--fg)}
.legend{display:flex;gap:16px;font-size:12px;color:var(--mut);margin:4px 0 6px}.legend i{display:inline-block;width:14px;height:3px;vertical-align:middle;margin-right:6px;border-radius:2px}
.tip{position:absolute;pointer-events:none;background:#0b0d11;border:1px solid var(--line);border-radius:6px;padding:6px 9px;font-size:12px;display:none;white-space:nowrap;z-index:3}.tip b{font-family:ui-monospace,Menlo,Consolas,monospace}
svg text{fill:var(--mut);font-size:11px}.two{display:grid;grid-template-columns:1.4fr 1fr;gap:14px}@media(max-width:900px){.two{grid-template-columns:1fr}}
details summary{cursor:pointer;color:var(--mut)}details p{color:var(--mut);margin:8px 0}.st{display:inline-flex;align-items:center;gap:6px}.muted{color:var(--mut)}code{background:#0d0f13;padding:1px 5px;border-radius:4px;font-size:13px}
</style></head><body>
<header><span id="botdot" class="dot"></span><h1>Jev · BTC 5-Minuten</h1><span id="sentence" class="sent">verbinde …</span>
<div class="right"><span id="moneypill" class="pill off">Echtgeld: AUS</span><span id="clock" class="muted num"></span></div></header>
<main>
<section class="card w12"><div class="killbox"><span id="killdot" class="dot ok"></span><div class="txt"><div id="killtext" class="big">Notaus bereit · nicht ausgelöst</div><div id="killsub" class="muted">Stoppt sofort jede neue Order, storniert ruhende, verkauft nie eine Position zwangsweise.</div></div>
<button id="killbtn" class="kill" onclick="act('kill')">NOTAUS – keine neuen Orders</button><button class="resume" onclick="act('resume')">Wieder freigeben</button></div></section>

<section class="card"><h2>Aktueller Markt</h2><p class="sub" id="msub">—</p><div id="market"></div></section>
<section class="card"><h2>Was Jev gerade denkt</h2><p class="sub" id="jsub">—</p><div id="jev"></div></section>
<section class="card"><h2>Verbindung &amp; Betrieb</h2><p class="sub">Grün heißt: alles frisch. Rot: Daten veraltet – der Bot entscheidet dann nicht.</p><div id="feeds"></div></section>

<section class="card w8"><h2>Jev gegen den Markt</h2><p class="sub">Blau: Wahrscheinlichkeit für „Up" laut Jev. Orange: Preis des Up-Tokens (= was der Markt glaubt). Liegen sie weit auseinander, sieht Jev etwas anderes als der Markt.</p>
<div class="legend"><span><i style="background:var(--series-1)"></i>Jev P(Up)</span><span><i style="background:var(--series-2)"></i>Markt Up-Preis</span></div>
<div style="position:relative"><svg id="jm" width="100%" height="240" viewBox="0 0 800 240" preserveAspectRatio="none"></svg><div id="jmtip" class="tip"></div></div></section>
<section class="card"><h2>Tagesnote: Kalibrierung</h2><p class="sub">Sagt Jev „90 %", muss es in etwa 90 % der Fälle stimmen. Das ist die Kernfrage des Projekts.</p><div id="cal"></div></section>

<section class="card"><h2>Heute</h2><p class="sub">Seit Mitternacht.</p><div id="today"></div></section>
<section class="card"><h2>Letzte Stunde</h2><p class="sub">Wie oft, wie schnell, was entschieden.</p><div id="hour"></div></section>
<section class="card"><h2>Letzte Märkte</h2><p class="sub">Fenster · Ausgang · Entscheidungen</p><div id="markets"></div></section>

<section class="card w12"><h2>Handel <span id="tbadge" class="badge">keine Aufträge</span></h2><p class="sub">Paper = mit echten Kursen simuliert, aber ohne Geld. Live = echte Aufträge. Beides wird nie zusammengerechnet.</p>
<div class="tabs"><button id="tab-paper" class="on" onclick="setMode('paper')">Paper (simuliert)</button><button id="tab-live" onclick="setMode('live')">Live</button></div>
<div id="tempty" class="muted">Noch keine Aufträge. Im Beobachtungsmodus wird nie gehandelt. <code>pnpm bot:paper</code> erzeugt ein simuliertes Ergebnis aus den Aufzeichnungen.</div>
<div id="tbody" style="display:none">
 <div class="hero"><div><span class="lbl">Netto-Ergebnis</span><span id="tnet" class="huge"></span></div><div><span class="lbl">Märkte</span><span id="tmk" class="big"></span></div><div><span class="lbl">Gewonnen / verloren</span><span id="twl" class="big"></span></div><div><span class="lbl">Größter Rückgang</span><span id="tdd" class="big"></span></div><div><span class="lbl">Ausführungsquote</span><span id="tfr" class="big"></span></div></div>
 <div class="two">
  <div><div class="lbl muted" style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Kumuliertes Netto-Ergebnis je Marktende</div><div style="position:relative"><svg id="curve" width="100%" height="220" viewBox="0 0 640 220" preserveAspectRatio="none"></svg><div id="ctip" class="tip"></div></div>
   <div class="lbl muted" style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;margin:10px 0 6px">Ergebnis je Markt (letzte 40)</div><div style="position:relative"><svg id="bars" width="100%" height="120" viewBox="0 0 640 120" preserveAspectRatio="none"></svg></div></div>
  <div><div id="tpos"></div><div id="tstats"></div></div>
 </div>
 <div class="lbl muted" style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;margin:14px 0 6px">Letzte Ausführungen</div><div style="overflow:auto"><table id="tfills"><thead><tr><th>Zeit</th><th>Markt</th><th>Seite</th><th>Typ</th><th class="num">Preis</th><th class="num">Stück</th><th class="num">Gebühr</th></tr></thead><tbody></tbody></table></div>
</div></section>

<section class="card w6"><h2>Meldungen</h2><p class="sub">Die letzten Einträge aus dem Fehlerprotokoll.</p><div id="errors" class="mono muted" style="font-size:12px;white-space:pre-wrap"></div></section>
<section class="card w6"><h2>Was bedeutet das alles?</h2>
<details><summary>Modi: Beobachten, Paper, Shadow, Live</summary><p><b>Beobachten</b>: Bot schaut zu, Jev entscheidet, nichts wird gesendet. <b>Paper</b>: dieselben Entscheidungen, Ausführung wird gegen echte Kurse simuliert. <b>Shadow</b>: alles wie live, inklusive Signatur – aber die Order wird nie abgeschickt. <b>Live</b>: echtes Geld. Existiert erst nach ausdrücklicher Freigabe.</p></details>
<details><summary>Notaus</summary><p>Stoppt sofort jede neue Order und storniert ruhende. Verkauft nie eine Position zu beliebigen Kursen. Manche Auslöser (z. B. Datenstau) heilen nach 30 s von selbst; harte (Tagesverlust, Buchungsfehler, Notaus per Knopf) bleiben, bis du „Wieder freigeben" drückst.</p></details>
<details><summary>P(Up), Brier, Kalibrierung</summary><p><b>P(Up)</b> ist Jevs Wahrscheinlichkeit, dass der Markt „Up" auflöst. <b>Brier</b> misst, wie gut solche Wahrscheinlichkeiten stimmen: 0 wäre perfekt, 0,25 ist Münzwurf. <b>Kalibrierung</b>: Wenn Jev „90 %" sagt, sollten es auch etwa 90 % sein – steht dort deutlich weniger, ist Jev zu selbstsicher.</p></details>
<details><summary>Warum „abgelehnt: Echtgeld aus"?</summary><p>Jedes Kaufsignal läuft durch das Risiko-Gate. Im Beobachtungsmodus lehnt es jeden Kauf ab – genau das beweist, dass nichts rausgeht. Die Entscheidung wird trotzdem gespeichert und ausgewertet.</p></details>
</section>
</main>
<script>
const $=id=>document.getElementById(id);
const f=(v,d=3)=>v==null||Number.isNaN(+v)?'—':(+v).toFixed(d);const pct=v=>v==null?'—':(v*100).toFixed(1)+' %';const money=v=>(v>=0?'+':'')+(+v).toFixed(2).replace('.',',')+' $';
const row=(k,v)=>'<div class="row"><span class="k">'+k+'</span><span class="v num">'+v+'</span></div>';
const hhmm=ms=>new Date(ms).toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'});const hhmmss=ms=>new Date(ms).toLocaleTimeString('de-DE');
const slugWin=(slug,o,c)=>o&&c?hhmm(o)+'–'+hhmm(c):slug;
const ACT={HOLD:'Halten',BUY_UP:'Up kaufen',BUY_DOWN:'Down kaufen',BUY_PAIR:'Paar kaufen',ADD_COMPLEMENT:'Gegenseite ergänzen',CANCEL:'Stornieren',ABSTAIN:'Aussetzen'};
const RISK={APPROVED:'freigegeben',LIVE_TRADING_DISABLED:'abgelehnt: Echtgeld aus',STALE_DECISION:'abgelehnt: Kurs hat sich bewegt',KILL_SWITCH:'abgelehnt: Notaus',STALE_CHAINLINK:'abgelehnt: Preisfeed veraltet',STALE_ORDERBOOK:'abgelehnt: Orderbuch veraltet',JEV_TOO_SLOW:'abgelehnt: Jev zu langsam',TOO_CLOSE_TO_CLOSE:'abgelehnt: zu nah am Ende',INSUFFICIENT_LIQUIDITY:'abgelehnt: zu wenig Liquidität',SPREAD_TOO_WIDE:'abgelehnt: Spread zu breit',ORDER_TOO_LARGE:'abgelehnt: Order zu groß',TOO_MANY_OPEN_ORDERS:'abgelehnt: zu viele offene Orders',MARKET_EXPOSURE_EXCEEDED:'abgelehnt: Marktlimit',TOTAL_EXPOSURE_EXCEEDED:'abgelehnt: Gesamtlimit',UNPAIRED_EXPOSURE_EXCEEDED:'abgelehnt: ungepaartes Limit',DAILY_LOSS_REACHED:'abgelehnt: Tagesverlust erreicht',ERROR_STREAK:'abgelehnt: Fehlerserie'};
const OUT={Up:'▲ Up',Down:'▼ Down',UP:'▲ Up',DOWN:'▼ Down'};
async function act(a){if(a==='kill'){if(!confirm('NOTAUS auslösen?\n\nEs werden sofort keine neuen Orders mehr erzeugt, ruhende werden storniert. Positionen bleiben bestehen.'))return;}
 const reason=a==='kill'?(prompt('Grund (wird protokolliert):','manuell')||'manuell'):null;await fetch('/api/'+a,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({reason})});load();}
async function load(){try{const s=await (await fetch('/api/state')).json();render(s);}catch(e){$('botdot').className='dot bad';$('sentence').textContent='Dashboard erreicht die Datenbank nicht.';}}
function stTag(ok,warn,txt){return '<span class="st"><span class="dot '+(ok?'ok':warn?'warn':'bad')+'"></span>'+txt+'</span>';}
function render(s){
 $('clock').textContent=hhmmss(s.now);
 const hb=s.bot.shadow&&s.bot.shadow.ageS<10?s.bot.shadow:s.bot.observer;const alive=hb&&hb.ageS<10;const modeName=s.bot.shadow&&s.bot.shadow.ageS<10?'Shadow':'Beobachten';
 $('botdot').className='dot '+(alive?'ok':hb?'warn':'bad');
 const mk=s.market;const live=mk&&mk.live;const win=mk?slugWin(mk.slug,mk.openedAtMs,mk.closesAtMs):null;
 $('sentence').textContent=!hb?'Kein Bot aktiv – starte pnpm bot:observe.':!alive?'Bot meldet sich seit '+hb.ageS+' s nicht mehr.':modeName==='Shadow'?'Shadow-Modus · Markt '+win+' · signiert, sendet aber nichts.':'Beobachtet Markt '+win+' · entscheidet laufend · sendet nichts.';
 const k=s.kill;$('killdot').className='dot '+(k.tripped?'bad':'ok');
 $('killtext').textContent=k.tripped?'NOTAUS AKTIV: '+(k.reasons||[]).map(r=>({MANUAL:'manuell',CHAINLINK_STALE:'Preisfeed veraltet',MARKET_WS_STALE:'Orderbuch veraltet',CLOCK_DRIFT:'Uhr weicht ab',JEV_UNAVAILABLE:'Jev nicht erreichbar',JEV_TIMEOUT:'Jev zu langsam',JEV_INVALID:'Jev-Antwort ungültig',POLYMARKET_API_ERRORS:'Polymarket-Fehler',DAILY_LOSS:'Tagesverlust erreicht',INVENTORY_MISMATCH:'Bestand stimmt nicht',WALLET_MISMATCH:'Wallet stimmt nicht',UNEXPECTED_TOKEN_IDS:'unbekannte Token',ACK_INCONSISTENCY:'Bestätigung widersprüchlich',UNKNOWN_SETTLEMENT_CONFIG:'Auflösung unklar'})[r]||r).join(', '):'Notaus bereit · nicht ausgelöst';
 $('killsub').textContent=k.tripped?('seit '+hhmmss(k.since||k.updatedMs)+(k.hard?' · harter Auslöser, bleibt bis „Wieder freigeben"':' · heilt von selbst, sobald die Daten wieder frisch sind')):'Stoppt sofort jede neue Order, storniert ruhende, verkauft nie eine Position zwangsweise.';
 const d=s.lastDecision;
 if(mk){const total=(mk.closesAtMs-mk.openedAtMs)/1000;const rem=Math.max(0,(mk.closesAtMs-s.now)/1000);const done=1-rem/total;
  $('msub').textContent=win+(live?' · läuft':' · beendet');
  $('market').innerHTML=(live?'<div class="big num">'+Math.floor(rem/60)+':'+String(Math.floor(rem%60)).padStart(2,'0')+' <span class="muted" style="font-size:14px">verbleibend</span></div><div class="bar" style="margin:6px 0 12px"><i style="width:'+(done*100).toFixed(1)+'%"></i></div>':'<div class="muted" style="margin-bottom:10px">Warte auf das nächste 5-Minuten-Fenster.</div>')
   +(d?row('BTC bei Start → jetzt',f(d.settlementStart,0)+' → '+f(d.settlementCurrent,0))+row('Veränderung',(d.distanceBps>=0?'▲ +':'▼ ')+f(d.distanceBps,2)+' bps')+row('Up-Token (Kauf)',f(d.upAsk))+row('Down-Token (Kauf)',f(d.downAsk))+row('Paar zusammen',f(d.pairAskCost,4)+(d.pairEdge>0?' · Arbitrage!':''))+row('Bestand',d.inventory?(d.inventory.upShares+' Up · '+d.inventory.downShares+' Down'):'—'):'');
 } else {$('msub').textContent='—';$('market').innerHTML='<span class="muted">Noch kein Markt aufgezeichnet.</span>';}
 if(d){$('jsub').textContent='vor '+d.ageS+' s · Grund: '+({first:'erster Blick',quote:'Kurs bewegt',pair:'Paarkosten bewegt',settlement:'BTC bewegt',time_bucket:'Zeitfenster gewechselt',inventory:'Bestand geändert',data_quality:'Datenqualität',heartbeat:'Routine-Check'}[d.materialReason]||d.materialReason||'—');
  const up=Math.round((d.pUp||0)*100);$('jev').innerHTML='<div class="huge">'+(ACT[d.action]||d.action)+'</div><div class="muted" style="margin-bottom:10px">'+(d.actionProbs||[]).map(p=>(ACT[p[0]]||p[0])+' '+(p[1]*100).toFixed(0)+' %').join(' · ')+'</div>'
   +'<div class="split"><div class="up" style="width:'+up+'%">Up '+up+' %</div><div class="down">Down '+(100-up)+' %</div></div><div class="muted" style="font-size:12px;margin:4px 0 10px">Anteil „noch unklar": '+pct(d.unresolved)+'</div>'
   +row('Risiko-Gate',RISK[d.riskReason||d.risk]||d.risk)+row('Antwortzeit Jev',f(d.jevMs,0)+' ms')+row('Tokens (ein/aus)',d.tokens[0]+' / '+d.tokens[1])+row('Modell',d.model);
 } else {$('jsub').textContent='—';$('jev').innerHTML='<span class="muted">Noch keine Entscheidung.</span>';}
 const fa=s.feeds.chainlinkAgeS,ba=s.feeds.bookAgeS,ha=hb?hb.ageS:null;
 $('feeds').innerHTML=row('Preisfeed (Chainlink)',fa==null?'—':stTag(fa<3,fa<10,fa+' s alt'))+row('Orderbuch',ba==null?'—':stTag(ba<3,ba<10,ba+' s alt'))+row('Bot-Lebenszeichen',ha==null?stTag(false,false,'keins'):stTag(ha<5,ha<10,ha+' s'))+row('Modus',modeName)+row('Entscheidungen gesamt',s.decisions.total)+row('Märkte aufgezeichnet',s.markets.total+' · '+s.markets.resolved+' aufgelöst');
 $('moneypill').className='pill '+(s.trading&&s.trading.live?'live':'off');$('moneypill').textContent=s.trading&&s.trading.live?'Echtgeld: AN':'Echtgeld: AUS';
 drawJevMarket(mk?mk.timeline:[]);
 const c=s.calibration;
 $('cal').innerHTML=!c||c.observations===0?'<span class="muted">Noch keine aufgelösten Märkte mit Entscheidungen'+(c?' ('+c.resolved+' aufgelöst)':'')+'. Kommt mit der Zeit von selbst.</span>':
  '<div class="hero"><div><span class="lbl">Brier</span><span class="big num">'+f(c.brier,3)+'</span></div><div><span class="lbl">Richtung richtig</span><span class="big num">'+pct(c.accuracy)+'</span></div><div><span class="lbl">Märkte</span><span class="big num">'+c.resolved+'</span></div></div>'
  +'<div class="muted" style="font-size:12px;margin-bottom:8px">'+(c.brier<0.15?'Deutlich besser als Münzwurf.':c.brier<0.22?'Besser als Münzwurf, aber nicht viel.':c.brier<0.28?'Etwa Münzwurf-Niveau.':'Schlechter als Münzwurf – Jev liegt systematisch daneben.')+' (0 = perfekt, 0,25 = Münzwurf)</div>'
  +'<table><thead><tr><th>Jev sagt</th><th class="num">n</th><th class="num">tatsächlich</th></tr></thead><tbody>'+c.buckets.map(b=>'<tr><td>'+b.bucket+'</td><td class="num">'+b.n+'</td><td class="num">'+pct(b.observed)+(b.observed-b.predicted<-0.05?' ▼':b.observed-b.predicted>0.05?' ▲':'')+'</td></tr>').join('')+'</tbody></table>';
 const t=s.today;$('today').innerHTML=row('Entscheidungen',t.decisions)+row('Tokens (ein/aus)',t.input.toLocaleString('de-DE')+' / '+t.output.toLocaleString('de-DE'))+row('Kosten ca.',t.usd==null?'<span class="muted" title="TYPESAFE_USD_PER_MTOKEN in .env setzen">unbekannt</span>':t.usd.toFixed(2).replace('.',',')+' $');
 const L=s.jevLatencyHour;$('hour').innerHTML=row('pro Minute',s.decisions.lastMinute)+row('pro Stunde',s.decisions.lastHour)+row('Jev typisch / langsam / max',f(L.p50,0)+' / '+f(L.p95,0)+' / '+f(L.max,0)+' ms')+Object.entries(s.actionsHour).map(([a,n])=>row(ACT[a]||a,n)).join('')+s.riskHour.map(r=>row(RISK[r.reason||r.r]||r.r,r.n)).join('');
 $('markets').innerHTML=s.markets.recent.map(m=>{return row(hhmm(m.opened_at_ms)+'–'+hhmm(m.closes_at_ms),(m.resolved_outcome?OUT[m.resolved_outcome]||m.resolved_outcome:(m.closes_at_ms>s.now?'läuft':'offen'))+' · '+m.n)}).join('')||'<span class="muted">—</span>';
 $('errors').textContent=s.errors.length?s.errors.map(e=>hhmmss(e.ts_ms)+'  '+e.component+': '+e.message).join('\n'):'keine';
 renderTrading(s.trading||{});
}
function ticks(min,max,n){const span=max-min||1;const raw=span/n;const p=Math.pow(10,Math.floor(Math.log10(raw)));const st=[1,2,5,10].map(x=>x*p).find(x=>x>=raw);const out=[];for(let v=Math.ceil(min/st)*st;v<=max+1e-9;v+=st)out.push(+v.toFixed(6));return out;}
function drawJevMarket(tl){const svg=$('jm');const W=800,H=240,L=40,R=14,T=12,Bt=26;if(!tl||tl.length<2){svg.innerHTML='<text x="'+L+'" y="'+(H/2)+'">Noch zu wenige Entscheidungen in diesem Markt.</text>';return;}
 const x=i=>L+(i/(tl.length-1))*(W-L-R);const y=v=>T+(1-v)*(H-T-Bt);let s='';
 for(const tv of [0,0.25,0.5,0.75,1])s+='<line x1="'+L+'" x2="'+(W-R)+'" y1="'+y(tv)+'" y2="'+y(tv)+'" stroke="var(--grid)" stroke-width="1"/><text x="'+(L-6)+'" y="'+(y(tv)+4)+'" text-anchor="end">'+(tv*100)+'%</text>';
 const path=(key,color)=>'<path d="'+tl.map((p,i)=>(i?'L':'M')+x(i).toFixed(1)+' '+y(Math.min(1,Math.max(0,p[key]||0))).toFixed(1)).join(' ')+'" fill="none" stroke="'+color+'" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>';
 s+=path('upAsk','var(--series-2)')+path('pUp','var(--series-1)');
 const last=tl[tl.length-1];s+='<circle cx="'+x(tl.length-1)+'" cy="'+y(last.pUp)+'" r="4" fill="var(--series-1)" stroke="var(--surface-1)" stroke-width="2"/><circle cx="'+x(tl.length-1)+'" cy="'+y(last.upAsk)+'" r="4" fill="var(--series-2)" stroke="var(--surface-1)" stroke-width="2"/>';
 s+='<text x="'+L+'" y="'+(H-8)+'">'+hhmmss(tl[0].t)+'</text><text x="'+(W-R)+'" y="'+(H-8)+'" text-anchor="end">'+hhmmss(last.t)+'</text>';
 s+='<line id="jmx" x1="0" x2="0" y1="'+T+'" y2="'+(H-Bt)+'" stroke="var(--mut)" stroke-width="1" style="display:none"/><rect id="jmhit" x="'+L+'" y="'+T+'" width="'+(W-L-R)+'" height="'+(H-T-Bt)+'" fill="transparent"/>';
 svg.innerHTML=s;const hit=svg.querySelector('#jmhit'),cx=svg.querySelector('#jmx'),tip=$('jmtip');
 hit.onmousemove=e=>{const r=svg.getBoundingClientRect();const px=(e.clientX-r.left)/r.width*W;const i=Math.max(0,Math.min(tl.length-1,Math.round((px-L)/((W-L-R)/(tl.length-1)))));cx.style.display='';cx.setAttribute('x1',x(i));cx.setAttribute('x2',x(i));
  tip.style.display='block';tip.style.left=(e.clientX-r.left+14)+'px';tip.style.top=(e.clientY-r.top-12)+'px';tip.replaceChildren();const p=tl[i];
  const line=(txt,val)=>{const dv=document.createElement('div');const b=document.createElement('b');b.textContent=val;dv.appendChild(b);dv.appendChild(document.createTextNode(' '+txt));tip.appendChild(dv);};
  line('Jev P(Up)',(p.pUp*100).toFixed(1)+' %');line('Markt Up-Preis',(p.upAsk*100).toFixed(1)+' %');line(hhmmss(p.t)+' · noch '+f(p.s,0)+' s · '+(ACT[p.action]||p.action),'');};
 hit.onmouseleave=()=>{tip.style.display='none';cx.style.display='none';};}
let mode=localStorage.getItem('tmode')||'paper';function setMode(m){mode=m;localStorage.setItem('tmode',m);load();}
function renderTrading(tr){$('tab-paper').className=mode==='paper'?'on':'';$('tab-live').className=mode==='live'?'on':'';const t=tr[mode];const badge=$('tbadge');
 if(!t){badge.className='badge';badge.textContent=mode==='paper'?'noch kein Paper-Lauf':'keine Live-Aufträge';$('tempty').style.display='';$('tbody').style.display='none';return;}
 badge.className='badge '+(mode==='paper'?'sim':'live');badge.textContent=mode==='paper'?'SIMULIERT – kein echtes Geld':'LIVE – echtes Geld';$('tempty').style.display='none';$('tbody').style.display='';
 $('tnet').textContent=money(t.netPnl);$('tmk').textContent=t.settledMarkets;$('twl').textContent=t.wins+' / '+t.losses;$('tdd').textContent='−'+(+t.maxDrawdown).toFixed(2).replace('.',',')+' $';$('tfr').textContent=t.fillRatio==null?'—':(t.fillRatio*100).toFixed(0)+' %';
 $('tpos').innerHTML=t.openPosition?'<div class="lbl muted" style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Offene Position</div>'+row('Up / Down Stück',t.openPosition.upShares+' / '+t.openPosition.downShares)+row('davon gepaart',t.openPosition.pairedShares)+row('Einsatz',(+t.openPosition.totalCost).toFixed(2)+' $')+row('Ergebnis wenn Up / Down',money(t.openPosition.pnlIfUp)+' / '+money(t.openPosition.pnlIfDown)):'<div class="muted" style="margin-bottom:8px">Keine offene Position.</div>';
 $('tstats').innerHTML=row('Brutto',money(t.grossPnl))+row('aus Paaren (Merge)',money(t.mergePnl))+row('Gebühren / Gas',(+t.fees).toFixed(2)+' / '+(+t.gas).toFixed(2)+' $')+row('bester / schlechtester Markt',(t.bestMarket==null?'—':money(t.bestMarket))+' / '+(t.worstMarket==null?'—':money(t.worstMarket)))+row('Orders → ganz / teils / gar nicht',t.orders+' → '+t.fills+' / '+t.partials+' / '+t.noFills)+row('Umsatz',(+t.volumeUsd).toFixed(2)+' $');
 drawCurve(t.curve);drawBars(t.perMarket.slice().reverse());
 $('tfills').querySelector('tbody').innerHTML=t.recentFills.map(x=>'<tr><td>'+hhmmss(x.tsMs)+'</td><td>'+hhmm(+x.slug.replace('btc-updown-5m-','')*1000)+'</td><td>'+x.side+'</td><td>'+x.orderType+'</td><td class="num">'+(+x.price).toFixed(3)+'</td><td class="num">'+(+x.size).toFixed(0)+'</td><td class="num">'+(+x.fee).toFixed(3)+'</td></tr>').join('')||'<tr><td colspan="7" class="muted">keine</td></tr>';}
function drawCurve(c){const svg=$('curve');const W=640,H=220,L=44,R=12,T=12,Bt=24;if(!c.length){svg.innerHTML='';return;}
 const ys=c.map(p=>p.pnl).concat([0]);const ymin=Math.min(...ys),ymax=Math.max(...ys);const x=i=>L+(c.length===1?0:(i/(c.length-1))*(W-L-R));const y=v=>T+(1-(v-ymin)/((ymax-ymin)||1))*(H-T-Bt);let s='';
 for(const tv of ticks(ymin,ymax,4))s+='<line x1="'+L+'" x2="'+(W-R)+'" y1="'+y(tv)+'" y2="'+y(tv)+'" stroke="var(--grid)" stroke-width="1"/><text x="'+(L-6)+'" y="'+(y(tv)+4)+'" text-anchor="end">'+tv+'</text>';
 s+='<line x1="'+L+'" x2="'+(W-R)+'" y1="'+y(0)+'" y2="'+y(0)+'" stroke="var(--mut)" stroke-width="1"/><path d="'+c.map((p,i)=>(i?'L':'M')+x(i).toFixed(1)+' '+y(p.pnl).toFixed(1)).join(' ')+'" fill="none" stroke="var(--series-1)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>';
 const last=c[c.length-1];s+='<circle cx="'+x(c.length-1)+'" cy="'+y(last.pnl)+'" r="4" fill="var(--series-1)" stroke="var(--surface-1)" stroke-width="2"/><text x="'+(x(c.length-1)-8)+'" y="'+Math.min(H-Bt-4,Math.max(T+12,y(last.pnl)+(last.pnl>=0?-10:16)))+'" text-anchor="end" style="fill:var(--fg)">'+money(last.pnl)+'</text>';
 s+='<text x="'+(W-R)+'" y="'+(H-6)+'" text-anchor="end">'+hhmmss(last.t)+'</text><text x="'+L+'" y="'+(H-6)+'">'+hhmmss(c[0].t)+'</text><rect x="'+L+'" y="'+T+'" width="'+(W-L-R)+'" height="'+(H-T-Bt)+'" fill="transparent" id="chit"/>';svg.innerHTML=s;
 const hit=svg.querySelector('#chit'),tip=$('ctip');hit.onmousemove=e=>{const r=svg.getBoundingClientRect();const px=(e.clientX-r.left)/r.width*W;const i=Math.max(0,Math.min(c.length-1,Math.round((px-L)/((W-L-R)/Math.max(1,c.length-1)))));tip.style.display='block';tip.style.left=(e.clientX-r.left+12)+'px';tip.style.top=(e.clientY-r.top-10)+'px';tip.textContent=hhmm(c[i].t)+' · '+money(c[i].pnl);};hit.onmouseleave=()=>tip.style.display='none';}
function drawBars(m){const svg=$('bars');const W=640,H=120,L=44,R=12,T=8,Bt=8;if(!m.length){svg.innerHTML='';return;}
 const vals=m.map(r=>r.netPnl).concat([0]);const ymin=Math.min(...vals),ymax=Math.max(...vals);const y=v=>T+(1-(v-ymin)/((ymax-ymin)||1))*(H-T-Bt);const slot=(W-L-R)/m.length;const bw=Math.min(24,Math.max(2,slot-2));
 let s='<line x1="'+L+'" x2="'+(W-R)+'" y1="'+y(0)+'" y2="'+y(0)+'" stroke="var(--mut)" stroke-width="1"/>';
 m.forEach((r,i)=>{const x0=L+i*slot+(slot-bw)/2;const y0=Math.min(y(0),y(r.netPnl)),h=Math.max(1,Math.abs(y(r.netPnl)-y(0)));s+='<rect x="'+x0.toFixed(1)+'" y="'+y0.toFixed(1)+'" width="'+bw.toFixed(1)+'" height="'+h.toFixed(1)+'" rx="2" fill="'+(r.netPnl>=0?'var(--pos)':'var(--neg)')+'"><title>'+hhmm(+r.slug.replace('btc-updown-5m-','')*1000)+' · '+(r.outcome||'?')+' · '+money(r.netPnl)+' · '+r.fills+'/'+r.orders+' ausgeführt</title></rect>';});svg.innerHTML=s;}
load();setInterval(load,2000);
</script></body></html>`;
