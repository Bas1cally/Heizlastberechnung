import { TIME_BUCKETS } from "./calibration.js";

/**
 * What a wallet actually did on the BTC 5-minute markets, from its public
 * activity rows: when it bought (seconds before the close), at what price,
 * which side, whether it paired and merged, what came back at redemption,
 * and the cash result per market. Every number is arithmetic over the
 * rows; nothing is inferred about intent.
 */
export interface ActivityRow {
  readonly type: string;
  readonly conditionId: string | null;
  readonly slug: string | null;
  readonly outcome: string | null;
  readonly side: string | null;
  readonly price: number | null;
  readonly shares: number | null;
  readonly amount: number | null;
  readonly tsMs: number;
  readonly txHash: string | null;
}

export interface TraderBuy { readonly outcome: string; readonly price: number; readonly shares: number; readonly usd: number; readonly secondsBeforeClose: number; readonly won: boolean | undefined }
export interface TraderMarket {
  readonly slug: string; readonly openedAtMs: number; readonly closesAtMs: number; readonly outcome: string | undefined;
  readonly buys: TraderBuy[]; readonly sells: number; readonly sellUsd: number; readonly buyUsd: number;
  readonly mergedUsd: number; readonly redeemedUsd: number; readonly netUsd: number; readonly bothSides: boolean;
}
export interface Bucket { readonly bucket: string; readonly trades: number; readonly shares: number; readonly usd: number; readonly meanPrice: number | null; readonly known: number; readonly wonRate: number | null }

export interface TraderReport {
  readonly btcMarkets: number; readonly otherMarkets: number;
  readonly trades: number; readonly buys: number; readonly sells: number; readonly merges: number; readonly redeems: number; readonly splits: number;
  readonly buyUsd: number; readonly meanBuyPrice: number | null;
  readonly settledMarkets: number; readonly netCashUsd: number; readonly netPerMarket: number | null; readonly wins: number; readonly losses: number; readonly flat: number;
  readonly marketsBothSides: number; readonly marketsWithMerge: number;
  readonly buyPriceBuckets: Bucket[]; readonly buyTimeBuckets: Bucket[];
  readonly perMarket: TraderMarket[];
}

export const PRICE_BUCKETS: readonly { label: string; lo: number; hi: number }[] = [
  { label: "0.00-0.02", lo: 0, hi: 0.02 }, { label: "0.02-0.10", lo: 0.02, hi: 0.1 }, { label: "0.10-0.50", lo: 0.1, hi: 0.5 }, { label: "0.50-0.90", lo: 0.5, hi: 0.9 },
  { label: "0.90-0.97", lo: 0.9, hi: 0.97 }, { label: "0.97-0.98", lo: 0.97, hi: 0.98 }, { label: "0.98-0.99", lo: 0.98, hi: 0.99 }, { label: "0.99-0.995", lo: 0.99, hi: 0.995 }, { label: "0.995-1.00", lo: 0.995, hi: 1.0001 },
];

const isBtc5m = (slug: string | null): slug is string => !!slug && /^btc-updown-5m-\d+$/.test(slug);
const norm = (o: string | null | undefined) => { const k = o?.trim().toLowerCase(); return k === "up" || k === "yes" ? "UP" : k === "down" || k === "no" ? "DOWN" : o ?? undefined; };

export function analyzeTrader(
  rows: readonly ActivityRow[],
  window: (slug: string) => { openedAtMs: number; closesAtMs: number } | undefined,
  resolved: (slug: string) => string | undefined,
  nowMs: number = Date.now(),
): TraderReport {
  const bySlug = new Map<string, ActivityRow[]>();
  const other = new Set<string>();
  for (const r of rows) {
    if (isBtc5m(r.slug)) { const arr = bySlug.get(r.slug) ?? []; arr.push(r); bySlug.set(r.slug, arr); }
    else if (r.slug) other.add(r.slug);
  }
  const perMarket: TraderMarket[] = [];
  let trades = 0, buys = 0, sells = 0, merges = 0, redeems = 0, splits = 0, buyUsd = 0, buyShares = 0, buyPriceWeighted = 0;
  for (const [slug, acts] of bySlug) {
    const w = window(slug);
    if (!w) continue;
    // Outcome: recorded resolution, else the redeemed side (a redemption pays only the winner).
    let outcome = norm(resolved(slug));
    const redeemRows = acts.filter((a) => a.type === "REDEEM");
    const buyRows = acts.filter((a) => a.type === "TRADE" && a.side?.toUpperCase() === "BUY");
    const sellRows = acts.filter((a) => a.type === "TRADE" && a.side?.toUpperCase() === "SELL");
    const mergeRows = acts.filter((a) => a.type === "MERGE");
    if (!outcome && redeemRows.length && buyRows.length) {
      // If only one side was bought and something was redeemed, that side won.
      const sides = new Set(buyRows.map((b) => norm(b.outcome)));
      if (sides.size === 1) outcome = [...sides][0];
    }
    const mBuys: TraderBuy[] = buyRows.map((b) => {
      const o = norm(b.outcome) ?? "?";
      return { outcome: o, price: b.price ?? 0, shares: b.shares ?? 0, usd: b.amount ?? (b.price ?? 0) * (b.shares ?? 0), secondsBeforeClose: Math.round((w.closesAtMs - b.tsMs) / 1000), won: outcome ? o === outcome : undefined };
    });
    const mBuyUsd = mBuys.reduce((s, b) => s + b.usd, 0);
    const mSellUsd = sellRows.reduce((s, a) => s + (a.amount ?? (a.price ?? 0) * (a.shares ?? 0)), 0);
    const mergedUsd = mergeRows.reduce((s, a) => s + (a.amount ?? 0), 0);
    const redeemedUsd = redeemRows.reduce((s, a) => s + (a.amount ?? 0), 0);
    trades += buyRows.length + sellRows.length; buys += buyRows.length; sells += sellRows.length; merges += mergeRows.length; redeems += redeemRows.length; splits += acts.filter((a) => a.type === "SPLIT").length;
    buyUsd += mBuyUsd; for (const b of mBuys) { buyShares += b.shares; buyPriceWeighted += b.price * b.shares; }
    perMarket.push({
      slug, openedAtMs: w.openedAtMs, closesAtMs: w.closesAtMs, outcome, buys: mBuys, sells: sellRows.length, sellUsd: mSellUsd, buyUsd: mBuyUsd, mergedUsd, redeemedUsd,
      netUsd: redeemedUsd + mergedUsd + mSellUsd - mBuyUsd, bothSides: new Set(mBuys.map((b) => b.outcome)).size > 1,
    });
  }
  perMarket.sort((a, b) => a.openedAtMs - b.openedAtMs);
  // A market counts as settled once something came back (redeem or merge), or
  // it is resolved with every buy on the losing side, or it closed more than
  // two hours ago with nothing ever coming back: a lost tail is never redeemed
  // and never merged, so it leaves no trace but its purchase. Counting only
  // markets with a redemption or merge (the first version of this rule, with
  // outcomes known only for markets we had recorded) dropped ~500 lost tails
  // and turned an eight-day net of about -670 USD into "+3,992".
  const SETTLED_AFTER_MS = 2 * 3_600_000;
  const settled = perMarket.filter((m) => m.redeemedUsd > 0 || m.mergedUsd > 0 || (m.outcome && m.buys.every((b) => b.won === false)) || m.closesAtMs + SETTLED_AFTER_MS < nowMs);
  const netCashUsd = settled.reduce((s, m) => s + m.netUsd, 0);
  const allBuys = perMarket.flatMap((m) => m.buys);
  const bucketise = (label: string, xs: TraderBuy[]): Bucket => {
    const known = xs.filter((b) => b.won !== undefined);
    const shares = xs.reduce((s, b) => s + b.shares, 0);
    return { bucket: label, trades: xs.length, shares, usd: xs.reduce((s, b) => s + b.usd, 0), meanPrice: shares > 0 ? xs.reduce((s, b) => s + b.price * b.shares, 0) / shares : null, known: known.length, wonRate: known.length ? known.filter((b) => b.won).length / known.length : null };
  };
  return {
    btcMarkets: perMarket.length, otherMarkets: other.size, trades, buys, sells, merges, redeems, splits,
    buyUsd, meanBuyPrice: buyShares > 0 ? buyPriceWeighted / buyShares : null,
    settledMarkets: settled.length, netCashUsd, netPerMarket: settled.length ? netCashUsd / settled.length : null,
    wins: settled.filter((m) => m.netUsd > 0.005).length, losses: settled.filter((m) => m.netUsd < -0.005).length, flat: settled.filter((m) => Math.abs(m.netUsd) <= 0.005).length,
    marketsBothSides: perMarket.filter((m) => m.bothSides).length, marketsWithMerge: perMarket.filter((m) => m.mergedUsd > 0).length,
    buyPriceBuckets: PRICE_BUCKETS.map((b) => bucketise(b.label, allBuys.filter((x) => x.price >= b.lo && x.price < b.hi))),
    buyTimeBuckets: [...TIME_BUCKETS.map((t) => bucketise(t.label, allBuys.filter((x) => x.secondsBeforeClose >= t.lo && x.secondsBeforeClose < t.hi))), bucketise("before open", allBuys.filter((x) => x.secondsBeforeClose >= 300))],
    perMarket,
  };
}
