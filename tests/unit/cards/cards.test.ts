import { describe, expect, it } from "vitest";
import { cardStr, parseCard, parseCards, rng } from "../../../src/cards/cards.js";
import { breakEven, callEv, categoryOf, equity, evaluate } from "../../../src/cards/poker.js";
import { basicStrategy, randomHand } from "../../../src/cards/blackjack.js";

const ev = (s: string) => evaluate(parseCards(s));

describe("cards", () => {
  it("round-trips card names", () => {
    expect(cardStr(parseCard("As"))).toBe("As");
    expect(cardStr(parseCard("td"))).toBe("Td");
    expect(() => parseCard("Xx")).toThrow();
  });
});

describe("poker evaluator", () => {
  it("names categories", () => {
    expect(categoryOf(ev("As Ks Qs Js Ts 2d 3c"))).toBe("straight flush");
    expect(categoryOf(ev("9c 9d 9h 9s 2d 3c 4h"))).toBe("quads");
    expect(categoryOf(ev("9c 9d 9h 2s 2d 3c 4h"))).toBe("full house");
    expect(categoryOf(ev("Ah 9h 5h 3h 2h Kd Kc"))).toBe("flush");
    expect(categoryOf(ev("Ad 2c 3h 4s 5d Kc Qd"))).toBe("straight");
    expect(categoryOf(ev("7c 7d 7h As Kd 2c 3h"))).toBe("trips");
    expect(categoryOf(ev("7c 7d 5h 5s Kd 2c 3h"))).toBe("two pair");
    expect(categoryOf(ev("7c 7d 5h As Kd 2c 3h"))).toBe("pair");
    expect(categoryOf(ev("7c 9d 5h As Kd 2c 3h"))).toBe("high card");
  });
  it("orders hands, including kickers, the wheel and two trips as a full house", () => {
    expect(ev("Ad 2c 3h 4s 5d Kc Qd")).toBeLessThan(ev("2c 3h 4s 5d 6c Kc Qd"));
    expect(ev("Ac Ad Kh 7s 5d 3c 2h")).toBeGreaterThan(ev("Ac Ad Qh 7s 5d 3c 2h"));
    expect(ev("9c 9d 9h 5s 5d 5c 2h")).toBe(ev("9c 9d 9h 5s 5d 2c 3h"));
    expect(categoryOf(ev("9c 9d 9h 5s 5d 5c 2h"))).toBe("full house");
    expect(ev("Kc Kd 5h 5s 3d 3c Ah")).toBe(ev("Kc Kd 5h 5s 2d 2c Ah"));
    expect(ev("Ah Kh Qh Jh 9h 8h 2c")).toBeGreaterThan(ev("Kh Qh Jh 9h 8h 7h 2c"));
  });
  it("equity matches known values within Monte Carlo error", () => {
    const r = rng(7);
    expect(equity(parseCards("As Ah"), [], { iterations: 20_000, random: r })).toBeGreaterThan(0.835);
    expect(equity(parseCards("As Ah"), [], { iterations: 20_000, random: r })).toBeLessThan(0.87);
    const low = equity(parseCards("7c 2d"), [], { iterations: 20_000, random: r });
    expect(low).toBeGreaterThan(0.32); expect(low).toBeLessThan(0.37);
    // made nut flush on the river against one random hand: nearly always wins
    expect(equity(parseCards("Ah Kh"), parseCards("2h 7h 9h Tc 3d"), { iterations: 5_000, random: r })).toBeGreaterThan(0.97);
  });
  it("pot odds", () => {
    expect(breakEven(100, 50)).toBeCloseTo(1 / 3);
    expect(callEv(0.5, 100, 50)).toBeCloseTo(25);
    expect(callEv(1 / 3, 100, 50)).toBeCloseTo(0);
  });
});

describe("blackjack basic strategy (6 decks, S17, DAS)", () => {
  const h = (kind: "hard" | "soft" | "pair", cards: string[], total: number, dealer: string) => basicStrategy({ kind, cards, total, dealer });
  it("hard totals", () => {
    expect(h("hard", ["5", "6"], 11, "A")).toBe("HIT");
    expect(h("hard", ["5", "6"], 11, "10")).toBe("DOUBLE");
    expect(h("hard", ["2", "7"], 9, "3")).toBe("DOUBLE");
    expect(h("hard", ["2", "7"], 9, "2")).toBe("HIT");
    expect(h("hard", ["10", "2"], 12, "3")).toBe("HIT");
    expect(h("hard", ["10", "2"], 12, "4")).toBe("STAND");
    expect(h("hard", ["10", "6"], 16, "K")).toBe("HIT");
    expect(h("hard", ["10", "6"], 16, "6")).toBe("STAND");
    expect(h("hard", ["2", "3"], 5, "6")).toBe("HIT");
  });
  it("soft totals and pairs", () => {
    expect(h("soft", ["A", "7"], 18, "2")).toBe("STAND");
    expect(h("soft", ["A", "7"], 18, "6")).toBe("DOUBLE");
    expect(h("soft", ["A", "7"], 18, "9")).toBe("HIT");
    expect(h("soft", ["A", "2"], 13, "5")).toBe("DOUBLE");
    expect(h("pair", ["8", "8"], 16, "A")).toBe("SPLIT");
    expect(h("pair", ["9", "9"], 18, "7")).toBe("STAND");
    expect(h("pair", ["K", "K"], 20, "6")).toBe("STAND");
    expect(h("pair", ["5", "5"], 10, "9")).toBe("DOUBLE");
    expect(h("pair", ["A", "A"], 12, "A")).toBe("SPLIT");
  });
  it("random hands are valid first two cards and cover all kinds", () => {
    const r = rng(3);
    const kinds = new Set<string>();
    for (let i = 0; i < 400; i++) { const x = randomHand(r); kinds.add(x.kind); expect(() => basicStrategy(x)).not.toThrow(); }
    expect([...kinds].sort()).toEqual(["hard", "pair", "soft"]);
  });
});
