import { describe, expect, it } from "vitest";
import { checklistFrom } from "../../../src/director/review.js";
import { SEED_RULES } from "../../../src/director/seed-rules.js";

describe("review checklist", () => {
  it("lists the vision/review rules and any rule born in a review, in order", () => {
    const rules = SEED_RULES.map((r, i) => ({ id: i + 1, project_id: 1, code: r.code, text_de: r.text_de, text_en: r.text_en, severity: r.severity, check_type: r.check.join("+"), active: 1, origin: "seed" }));
    rules.push({ id: 99, project_id: 1, code: "R11", text_de: "Keine Sonnenbrille.", text_en: "No sunglasses.", severity: "block", check_type: "jev", active: 1, origin: "review:4" });
    const items = checklistFrom(rules);
    expect(items.map((i) => i.rule)).toEqual(["R6", "R7", "R8", "R11"]);
    expect(items.every((i) => i.pass === null)).toBe(true);
  });
});
