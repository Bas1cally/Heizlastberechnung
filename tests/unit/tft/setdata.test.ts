import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureSetData, fetchSetData, fromCommunityDragon, fromDataDragon, nameResolver, normaliseReading, validComps, type SetData } from "../../../src/tft/setdata.js";
import { ensureMeta } from "../../../src/tft/meta.js";
import { BoardReadSchema } from "../../../src/tft/types.js";
import type { FetchLike } from "../../../src/director/venice.js";

const names = ["Ahri", "Rek'Sai", "Xayah", "Malphite", "Syndra", "Kai'Sa", "Jinx", "Vi", "Garen", "Lux"];
const roster = (n: number, prefix: string) => Array.from({ length: 45 }, (_, i) => ({ apiName: `TFT${n}_${prefix}${i}`, name: i < names.length ? names[i]! : `${prefix}${i}`, cost: 1 + (i % 5), traits: ["T"] }));
const cdEn = { sets: { "12": { name: "Old", champions: roster(12, "Old") }, "15": { name: "Live", champions: roster(15, "Unit") }, "1000": { name: "PvE", champions: [] } }, items: [{ apiName: "TFT15_Augment_Pandora", name: "Pandora's Items" }, { apiName: "TFT12_Augment_Old", name: "Old Aug" }, { apiName: "TFT_Augment_Generic", name: "Cybernetic Uplink" }] };
const cdDe = { sets: { "15": { champions: roster(15, "Unit").map((c) => (c.name === "Malphite" ? { ...c, name: "Malphite" } : c.name === "Rek'Sai" ? { ...c, name: "Rek'Sai" } : c.name === "Garen" ? { ...c, name: "Garen" } : c)).map((c, i) => (i === 3 ? { ...c, name: "Kiesel" } : c)) } }, items: [{ apiName: "TFT15_Augment_Pandora", name: "Pandoras Gegenstände" }] };

describe("official set data", () => {
  it("Community Dragon: picks the highest real set, German names, the set's and generic augments", () => {
    const s = fromCommunityDragon(cdEn, cdDe)!;
    expect(s.set).toBe("Set 15 (Live)");
    expect(s.champions).toHaveLength(45);
    expect(s.champions.find((c) => c.en === "Malphite")?.de).toBe("Kiesel");
    expect(s.augments.map((a) => a.en).sort()).toEqual(["Cybernetic Uplink", "Pandora's Items"]);
    expect(s.augments.find((a) => a.en === "Pandora's Items")?.de).toBe("Pandoras Gegenstände");
  });
  it("Data Dragon: champions of the newest set number only", () => {
    const data = (xs: { id: string; name: string; tier?: number }[]) => ({ data: Object.fromEntries(xs.map((x) => [x.id, x])) });
    const en = data([...Array.from({ length: 25 }, (_, i) => ({ id: `TFT15_U${i}`, name: `U${i}`, tier: 1 + (i % 5) })), { id: "TFT14_Old", name: "Old", tier: 1 }]);
    const s = fromDataDragon("15.18.1", en, data([{ id: "TFT15_U0", name: "DeU0" }]), data([{ id: "TFT15_Augment_X", name: "X" }]), undefined)!;
    expect(s.set).toBe("Set 15");
    expect(s.champions).toHaveLength(25);
    expect(s.champions[0]!.de).toBe("DeU0");
    expect(s.augments).toEqual([{ id: "TFT15_Augment_X", en: "X", de: "X" }]);
  });
  it("falls back from Community Dragon to Data Dragon and caches", async () => {
    const calls: string[] = [];
    const get = async (url: string) => { calls.push(url); if (url.includes("communitydragon")) throw new Error("403"); if (url.endsWith("versions.json")) return ["15.18.1"]; if (url.includes("en_US/tft-champion")) return { data: Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`k${i}`, { id: `TFT15_U${i}`, name: `U${i}`, tier: 1 }])) }; return { data: {} }; };
    const s = await fetchSetData(get);
    expect(s.source).toBe("datadragon");
    const dir = mkdtempSync(join(tmpdir(), "set-")); const p = join(dir, "set.json");
    await ensureSetData(p, get, 1e9, 1000);
    const n = calls.length;
    expect((await ensureSetData(p, get, 1e9, 2000)).fromCache).toBe(true);
    expect(calls.length).toBe(n);
    await expect(fetchSetData(async () => { throw new Error("offline"); })).rejects.toThrow(/set data unavailable/);
  });
});

describe("names", () => {
  const set: SetData = fromCommunityDragon(cdEn, cdDe)!;
  it("resolves English, German and small typos; rejects unrelated words", () => {
    const r = nameResolver(set.champions);
    expect(r("Kiesel")).toBe("Malphite");
    expect(r("reksai")).toBe("Rek'Sai");
    expect(r("Kaisa")).toBe("Kai'Sa");
    expect(r("Syndraa")).toBe("Syndra");
    expect(r("Klubber Moloch")).toBeUndefined();
    expect(r("Vi")).toBe("Vi");
  });
  it("normalises a reading and reports unknown names", () => {
    const read = BoardReadSchema.parse({ stage: "2-1", shop: ["Kiesel", "Rek Sai", "", "Klubber Moloch", "Xayah"], board: [{ name: "Syndraa" }], phase: "planning", augment_options: ["Pandoras Gegenstände"] });
    const n = normaliseReading(read, set);
    expect(n.read.shop).toEqual(["Malphite", "Rek'Sai", "", "Klubber Moloch", "Xayah"]);
    expect(n.read.board[0]!.name).toBe("Syndra");
    expect(n.read.augment_options).toEqual(["Pandora's Items"]);
    expect(n.unknown).toEqual(["Klubber Moloch"]);
  });
  it("keeps only comps of the live set and maps their units to official names", () => {
    const v = validComps([{ name: "Live", core_units: ["Ahri", "Kiesel", "Syndra"] }, { name: "Invented", core_units: ["Morgana", "Azir", "Sivir"] }], set);
    expect(v.keep.map((c) => c.name)).toEqual(["Live"]);
    expect(v.keep[0]!.core_units).toEqual(["Ahri", "Malphite", "Syndra"]);
    expect(v.dropped.map((c) => c.name)).toEqual(["Invented"]);
  });
  it("the meta fetch sends the roster and rejects a meta from another set", async () => {
    const bodies: string[] = [];
    const wrong = { set: "Set 18", patch: "18.2b", comps: [1, 2, 3].map((i) => ({ name: `Fake ${i}`, tier: "S", core_units: ["Morgana", "Azir", "Sivir"] })), augments: [{ name: "A" }] };
    const fetch: FetchLike = async (_u, init) => { bodies.push(init?.body ?? ""); const b = { choices: [{ message: { content: JSON.stringify(wrong) } }], usage: {} }; return { status: 200, ok: true, json: async () => b, text: async () => JSON.stringify(b), headers: { get: () => null } }; };
    const dir = mkdtempSync(join(tmpdir(), "meta-"));
    await expect(ensureMeta({ apiKey: "k", model: "m", cachePath: join(dir, "m.json"), set, fetch })).rejects.toThrow(/does not match Set 15/);
    expect(bodies[0]).toContain("Use only these champions");
    expect(bodies[0]).toContain("Malphite");
  });
});
