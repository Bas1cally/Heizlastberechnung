import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The current TFT set from Riot's own data instead of a web search: which
 * champions exist (English and German names, cost, traits) and which
 * augments. Sources, in order: Community Dragon (sets by number) and Data
 * Dragon (per-patch files). Both formats are parsed defensively; whatever
 * is found is cached for a day in data/tft/set.json.
 */
export interface SetChampion { id: string; en: string; de: string; cost: number; traits: string[] }
export interface SetAugment { id: string; en: string; de: string }
export interface SetData { set: string; source: string; version: string; champions: SetChampion[]; augments: SetAugment[] }

type Fetch = (url: string) => Promise<unknown>;
const getJson: Fetch = async (url) => { const r = await fetch(url, { signal: AbortSignal.timeout(20_000) }); if (!r.ok) throw new Error(`${r.status} ${url}`); return r.json(); };

const setNumberOf = (id: string) => Number(/^TFT(\d+)_/i.exec(id)?.[1] ?? NaN);

/** Community Dragon: { sets: { "13": { name, champions: [{ apiName, name, cost, traits }] } }, items: [{ apiName, name }] }. */
export function fromCommunityDragon(en: unknown, de: unknown): SetData | undefined {
  const e = en as { sets?: Record<string, { name?: string; champions?: { apiName?: string; name?: string; cost?: number; traits?: string[] }[] }>; items?: { apiName?: string; name?: string }[] };
  const d = de as typeof e;
  if (!e?.sets) return undefined;
  const nums = Object.keys(e.sets).map(Number).filter((n) => Number.isFinite(n) && n < 100);
  // The live set: the highest number whose roster looks like a real shop (costs 1..5, at least 40 units).
  for (const n of nums.sort((a, b) => b - a)) {
    const s = e.sets[String(n)]!;
    const champs = (s.champions ?? []).filter((c) => c.apiName && c.name && (c.cost ?? 0) >= 1 && (c.cost ?? 0) <= 5 && (c.traits?.length ?? 0) > 0);
    if (champs.length < 40) continue;
    const deBy = new Map((d?.sets?.[String(n)]?.champions ?? []).map((c) => [c.apiName, c.name]));
    const deItems = new Map((d?.items ?? []).map((i) => [i.apiName, i.name]));
    const augments = (e.items ?? []).filter((i) => i.apiName && i.name && /Augment/i.test(i.apiName) && (setNumberOf(i.apiName) === n || /^TFT_Augment/i.test(i.apiName)))
      .map((i) => ({ id: i.apiName!, en: i.name!, de: deItems.get(i.apiName) ?? i.name! }));
    return { set: `Set ${n}${s.name ? ` (${s.name})` : ""}`, source: "communitydragon", version: "latest", champions: champs.map((c) => ({ id: c.apiName!, en: c.name!, de: deBy.get(c.apiName) ?? c.name!, cost: c.cost!, traits: c.traits ?? [] })), augments };
  }
  return undefined;
}

/** Data Dragon: tft-champion.json / tft-augments.json, { data: { key: { id, name, tier|cost } } }. */
export function fromDataDragon(version: string, champEn: unknown, champDe: unknown, augEn: unknown, augDe: unknown): SetData | undefined {
  const vals = (x: unknown) => Object.values((x as { data?: Record<string, { id?: string; name?: string; tier?: number; cost?: number }> })?.data ?? {});
  const ce = vals(champEn).filter((c) => c.id && c.name);
  const n = Math.max(...ce.map((c) => setNumberOf(c.id!)).filter(Number.isFinite));
  if (!Number.isFinite(n)) return undefined;
  const deBy = new Map(vals(champDe).map((c) => [c.id, c.name]));
  const champs = ce.filter((c) => setNumberOf(c.id!) === n && ((c.tier ?? c.cost ?? 0) >= 1) && ((c.tier ?? c.cost ?? 9) <= 5));
  const augDeBy = new Map(vals(augDe).map((a) => [a.id, a.name]));
  const augments = vals(augEn).filter((a) => a.id && a.name && (setNumberOf(a.id) === n || /^TFT_Augment/i.test(a.id))).map((a) => ({ id: a.id!, en: a.name!, de: augDeBy.get(a.id) ?? a.name! }));
  if (champs.length < 20) return undefined;
  return { set: `Set ${n}`, source: "datadragon", version, champions: champs.map((c) => ({ id: c.id!, en: c.name!, de: deBy.get(c.id) ?? c.name!, cost: c.tier ?? c.cost ?? 0, traits: [] })), augments };
}

export async function fetchSetData(get: Fetch = getJson): Promise<SetData> {
  const errors: string[] = [];
  try {
    const [en, de] = await Promise.all([get("https://raw.communitydragon.org/latest/cdragon/tft/en_us.json"), get("https://raw.communitydragon.org/latest/cdragon/tft/de_de.json").catch(() => undefined)]);
    const s = fromCommunityDragon(en, de); if (s) return s; errors.push("communitydragon: no live set found");
  } catch (err) { errors.push(`communitydragon: ${err instanceof Error ? err.message : String(err)}`); }
  try {
    const versions = (await get("https://ddragon.leagueoflegends.com/api/versions.json")) as string[];
    const v = versions[0]!;
    const base = `https://ddragon.leagueoflegends.com/cdn/${v}/data`;
    const [ce, cd, ae, ad] = await Promise.all([get(`${base}/en_US/tft-champion.json`), get(`${base}/de_DE/tft-champion.json`).catch(() => undefined), get(`${base}/en_US/tft-augments.json`).catch(() => undefined), get(`${base}/de_DE/tft-augments.json`).catch(() => undefined)]);
    const s = fromDataDragon(v, ce, cd, ae, ad); if (s) return s; errors.push("datadragon: no live set found");
  } catch (err) { errors.push(`datadragon: ${err instanceof Error ? err.message : String(err)}`); }
  throw new Error(`set data unavailable: ${errors.join(" | ")}`);
}

export async function ensureSetData(cachePath: string, get?: Fetch, maxAgeMs = 24 * 3_600_000, now = Date.now()): Promise<{ data: SetData; fromCache: boolean }> {
  if (existsSync(cachePath)) {
    try { const j = JSON.parse(readFileSync(cachePath, "utf8")) as { fetchedAt: number; data: SetData }; if (now - j.fetchedAt < maxAgeMs && j.data.champions.length) return { data: j.data, fromCache: true }; } catch { /* refetch */ }
  }
  const data = await fetchSetData(get);
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify({ fetchedAt: now, data }, null, 1));
  return { data, fromCache: false };
}

// ---- name normalisation ----
const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "");
function lev(a: string, b: string): number {
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
  return prev[n]!;
}

/** A lookup from any spelling (English, German, small typos) to the official English name. */
export function nameResolver(entries: readonly { en: string; de: string }[]): (raw: string) => string | undefined {
  const exact = new Map<string, string>();
  for (const e of entries) { exact.set(norm(e.en), e.en); exact.set(norm(e.de), e.en); }
  const keys = [...exact.keys()];
  return (raw) => {
    const k = norm(raw); if (!k) return undefined;
    const hit = exact.get(k); if (hit) return hit;
    let best: string | undefined, bestD = Infinity;
    for (const key of keys) { const d = lev(k, key); if (d < bestD) { bestD = d; best = key; } }
    // Accept a near miss only when it is clearly the same word: at most 2 edits and a fifth of the length.
    return best && bestD <= Math.min(2, Math.floor(k.length / 5)) ? exact.get(best) : undefined;
  };
}

/** Units, shop and augments of a reading mapped onto the official names; unknown names are kept and counted. */
export function normaliseReading<T extends { shop: string[]; board: { name: string }[]; bench: { name: string }[]; augment_options: string[]; augments: string[] }>(read: T, set: SetData): { read: T; unknown: string[] } {
  const champ = nameResolver(set.champions), aug = nameResolver(set.augments);
  const unknown: string[] = [];
  const fix = (r: (s: string) => string | undefined) => (s: string) => { if (!s) return s; const v = r(s); if (!v) unknown.push(s); return v ?? s; };
  const fc = fix(champ), fa = fix(aug);
  return { read: { ...read, shop: read.shop.map(fc), board: read.board.map((u) => ({ ...u, name: fc(u.name) })), bench: read.bench.map((u) => ({ ...u, name: fc(u.name) })), augment_options: read.augment_options.map(fa), augments: read.augments.map(fa) }, unknown };
}

/** Comps whose core units mostly exist in the live set; the rest came from an old set or were invented. */
export function validComps<C extends { core_units: string[] }>(comps: readonly C[], set: SetData): { keep: C[]; dropped: C[] } {
  const champ = nameResolver(set.champions);
  const keep: C[] = [], dropped: C[] = [];
  for (const c of comps) { const known = c.core_units.filter((u) => champ(u)).length; (c.core_units.length && known / c.core_units.length >= 0.7 ? keep : dropped).push(c); }
  return { keep: keep.map((c) => ({ ...c, core_units: c.core_units.map((u) => champ(u) ?? u) })), dropped };
}
