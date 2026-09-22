import { describe, expect, it } from "vitest";
import { rng } from "../../../src/cards/cards.js";
import { blackjackItems, callItems, equityItems, headline, jevAsker, makeGuide, render, renderTeam, run, scoreBlackjack, scoreCall, scoreEquity, textAsker, type Asker } from "../../../src/cards/bench.js";
import type { FetchLike } from "../../../src/director/venice.js";

describe("card benchmark", () => {
  it("items carry the exact truth and an English state without the answer", () => {
    const bj = blackjackItems(20, rng(1));
    expect(bj.every((i) => ["HIT", "STAND", "DOUBLE", "SPLIT"].includes(i.truth))).toBe(true);
    expect(JSON.stringify(bj[0]!.state)).not.toMatch(/HIT|STAND|DOUBLE|SPLIT/);
    const eq = equityItems(5, rng(2), 2000);
    expect(eq.every((i) => i.truth >= 0 && i.truth <= 1 && i.hand.length === 2)).toBe(true);
    expect(eq[0]!.state).not.toHaveProperty("truth");
    const calls = callItems(5, rng(3), 2000);
    for (const c of calls) { expect(c.pot).toBeGreaterThan(c.bet); expect(c.state).not.toHaveProperty("eq"); }
  });

  it("a perfect asker scores 100 %, a coin flip does not; errors stop the run on 402", async () => {
    const items = blackjackItems(40, rng(4));
    const oracle: Asker = { name: "oracle", ask: async (i) => ({ value: i.kind === "blackjack" ? i.truth : 0, ms: 1, tokens: 0 }) };
    expect(scoreBlackjack(await run(items, oracle)).accuracy).toBe(1);
    const r = rng(9);
    const coin: Asker = { name: "coin", ask: async () => ({ value: r() < 0.5 ? "HIT" : "STAND", ms: 1, tokens: 0 }) };
    expect(scoreBlackjack(await run(items, coin)).accuracy).toBeLessThan(0.8);
    let calls = 0;
    const broke: Asker = { name: "broke", ask: async () => { calls++; throw new Error("402 no available TypeSafe API credits"); } };
    const res = await run(items, broke, { concurrency: 1, stopOn: (e) => /402/.test(e) });
    expect(calls).toBe(1);
    expect(res).toHaveLength(1);
    expect(render("blackjack", "broke", res)).toContain("1 Fehler");
  });

  it("equity and call scores: exact answers give zero error and zero EV lost", async () => {
    const eq = equityItems(10, rng(5), 2000);
    const exact: Asker = { name: "x", ask: async (i) => ({ value: i.kind === "equity" ? i.truth : 0, ms: 1, tokens: 0 }) };
    const s = scoreEquity(await run(eq, exact));
    expect(s.mae).toBe(0); expect(s.bias).toBe(0); expect(s.within5).toBe(1);
    // a consistently pessimistic estimator is fixed by the cross-validated recalibration
    const eq2 = equityItems(40, rng(13), 1000);
    const pess: Asker = { name: "p", ask: async (i) => ({ value: i.kind === "equity" ? 0.8 * i.truth : 0, ms: 1, tokens: 0 }) };
    const p2 = scoreEquity(await run(eq2, pess));
    expect(p2.bias).toBeLessThan(-0.05);
    expect(p2.calibratedMae).toBeLessThan(0.01);
    expect(p2.calibration.b).toBeCloseTo(1.25, 1);
    const cs = callItems(20, rng(6), 2000);
    const right: Asker = { name: "y", ask: async (i) => ({ value: i.kind === "call" ? i.truth : "", ms: 1, tokens: 0 }) };
    const c = scoreCall(await run(cs, right));
    expect(c.accuracy).toBe(1); expect(c.evLostPerHandPctPot).toBeCloseTo(0);
    const always: Asker = { name: "z", ask: async () => ({ value: "CALL", ms: 1, tokens: 0 }) };
    const a = scoreCall(await run(cs, always));
    expect(a.accuracy).toBeCloseTo(a.baselineAlwaysCall);
  });

  it("the Jev asker sends state and one question set per test; the text asker validates JSON", async () => {
    const seen: { questions: Record<string, unknown> }[] = [];
    const jev = jevAsker({ systemOne: async (req) => { seen.push(req as never); return { answers: { action: { choice: "STAND", confidence: 0.9 }, win: { noul: 0.61 } }, model: "jev", usage: { input_tokens: 300, output_tokens: 2 } }; } });
    const [bj] = blackjackItems(1, rng(1)); const [eq] = equityItems(1, rng(1), 500);
    expect((await jev.ask(bj!)).value).toBe("STAND");
    expect((await jev.ask(eq!)).value).toBe(0.61);
    expect(Object.keys(seen[0]!.questions)).toEqual(["action"]);
    expect(Object.keys(seen[1]!.questions)).toEqual(["win"]);
    const fetch: FetchLike = async () => { const b = { model: "m", choices: [{ message: { content: JSON.stringify({ win_probability: 0.4 }) } }], usage: { prompt_tokens: 200, completion_tokens: 10 } }; return { status: 200, ok: true, json: async () => b, text: async () => JSON.stringify(b), headers: { get: () => null } }; };
    const text = textAsker({ apiKey: "k", model: "m", fetch });
    expect((await text.ask(eq!)).value).toBe(0.4);
  });
});

describe("team of two", () => {
  it("agreement, who is right on disagreement, and the average of two probabilities", async () => {
    const items = blackjackItems(40, rng(11));
    const oracle: Asker = { name: "a", ask: async (i) => ({ value: i.kind === "blackjack" ? i.truth : "", ms: 1, tokens: 0 }) };
    const stand: Asker = { name: "b", ask: async () => ({ value: "STAND", ms: 1, tokens: 0 }) };
    const t = renderTeam("blackjack", { name: "a", results: await run(items, oracle) }, { name: "b", results: await run(items, stand) });
    expect(t).toMatch(/einig in \d+ von 40: dann richtig 100.0 %/);
    expect(t).toMatch(/b 0×/);
    expect(t).toContain("dem Besseren folgt: 100.0 %");
    const eq = equityItems(8, rng(12), 1000);
    const hi: Asker = { name: "hi", ask: async (i) => ({ value: i.kind === "equity" ? Math.min(1, i.truth + 0.1) : 0, ms: 1, tokens: 0 }) };
    const lo: Asker = { name: "lo", ask: async (i) => ({ value: i.kind === "equity" ? Math.max(0, i.truth - 0.1) : 0, ms: 1, tokens: 0 }) };
    expect(renderTeam("equity", { name: "hi", results: await run(eq, hi) }, { name: "lo", results: await run(eq, lo) })).toMatch(/Mittelwert beider 0\.\d/);
  });
});

describe("jev teams", () => {
  it("extra state reaches Jev; the guide is one text-model call; headlines summarise each run", async () => {
    const seen: Record<string, unknown>[] = [];
    const jev = jevAsker({ systemOne: async (req) => { seen.push(req.state as Record<string, unknown>); return { answers: { action: { choice: "HIT", confidence: 0.7 } }, model: "jev", usage: { input_tokens: 1, output_tokens: 1 } }; } }, undefined, { name: "jev+wissen", extra: () => ({ guide: "hit 12 vs 2" }) });
    const items = blackjackItems(3, rng(21));
    const res = await run(items, jev);
    expect(jev.name).toBe("jev+wissen");
    expect(seen[0]).toMatchObject({ guide: "hit 12 vs 2", dealer_upcard: expect.any(String) });
    expect(headline("blackjack", res)).toMatch(/% richtig \(3\), Median \d+ ms/);
    const bodies: string[] = [];
    const fetch: FetchLike = async (_u, init) => { bodies.push(init?.body ?? ""); const b = { choices: [{ message: { content: JSON.stringify({ guide: "x".repeat(80) }) } }], usage: { prompt_tokens: 100, completion_tokens: 200 } }; return { status: 200, ok: true, json: async () => b, text: async () => JSON.stringify(b), headers: { get: () => null } }; };
    const g = await makeGuide("blackjack", { apiKey: "k", model: "m", fetch });
    expect(g.guide).toHaveLength(80);
    expect(g.tokens).toBe(300);
    expect(bodies[0]).toContain("basic strategy");
  });
});
