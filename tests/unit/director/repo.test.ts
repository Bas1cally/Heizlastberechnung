import { describe, expect, it } from "vitest";
import { SEED_RULES } from "../../../src/director/seed-rules.js";
import { memRepo } from "./helpers.js";

describe("director repo", () => {
  it("seeds R1-R10 once per project and numbers new rules after them", () => {
    const repo = memRepo();
    const p = repo.createProject({ name: "Test" });
    repo.seedRules(p.id);
    const rules = repo.rules(p.id, false);
    expect(rules.map((r) => r.code)).toEqual(SEED_RULES.map((r) => r.code));
    expect(rules.every((r) => r.origin === "seed" && r.active === 1)).toBe(true);
    const added = repo.addRule(p.id, { text_de: "Keine Sonnenbrillen.", text_en: "No sunglasses.", severity: "block", check_type: "jev", origin: "review:3" });
    expect(added.code).toBe("R11");
    repo.setRuleActive(added.id, false);
    expect(repo.rules(p.id).some((r) => r.id === added.id)).toBe(false);
    expect(repo.rules(p.id, false).some((r) => r.id === added.id)).toBe(true);
  });

  it("numbers shots and links each to the previous one; project defaults fill the card", () => {
    const repo = memRepo();
    const p = repo.createProject({ name: "T", default_resolution: "720p", aspect_ratio: "9:16" });
    const a = repo.createShot({ project_id: p.id, beat_de: "A" });
    const b = repo.createShot({ project_id: p.id, beat_de: "B" });
    expect([a.seq, b.seq]).toEqual([1, 2]);
    expect(a.prev_shot_id).toBeNull();
    expect(b.prev_shot_id).toBe(a.id);
    expect(b.resolution).toBe("720p");
    expect(b.aspect_ratio).toBe("9:16");
    expect(b.engine).toBe(p.default_engine);
    repo.updateShot(b.id, { status: "gated", prompt_final: "x", bogus: 1 } as never);
    expect(repo.shot(b.id)?.status).toBe("gated");
  });

  it("stores references with a sha, assigns them to shots in slot order, and keeps the consent", () => {
    const repo = memRepo();
    const p = repo.createProject({ name: "T" });
    const c = repo.createCharacter({ project_id: p.id, name: "Mara" });
    const r1 = repo.addReference({ project_id: p.id, character_id: c.id, kind: "image", path: "a.png", role_default: "identity", duration_s: null, bytes: Buffer.from("abc") });
    const r2 = repo.addReference({ project_id: p.id, character_id: null, kind: "video", path: "b.mp4", role_default: "motion", duration_s: 5 });
    expect(r1.sha256).toHaveLength(64);
    expect(r1.sha256).not.toBe(r2.sha256);
    const s = repo.createShot({ project_id: p.id });
    repo.setShotReferences(s.id, [{ reference_id: r2.id, slot: "Video 1", role: "motion", subject_label: "" }, { reference_id: r1.id, slot: "Image 1", role: "identity", subject_label: "Mara" }]);
    const refs = repo.shotReferences(s.id);
    expect(refs.map((r) => r.slot)).toEqual(["Image 1", "Video 1"]);
    expect(refs[0]?.reference.character_id).toBe(c.id);
    repo.setReferenceConsent(r1.id, { attestation: true });
    expect(JSON.parse(repo.reference(r1.id)!.consent_json!)).toEqual({ attestation: true });
  });

  it("keeps jobs, reviews, costs and the translation cache", () => {
    const repo = memRepo();
    const p = repo.createProject({ name: "T" });
    const s = repo.createShot({ project_id: p.id });
    const j = repo.createJob({ shot_id: s.id, venice_model: "m", request_json: "{}", quote_usd: 0.42 });
    expect(j.status).toBe("quoted");
    repo.updateJob(j.id, { approved_at: 5, status: "approved" });
    expect(repo.job(j.id)?.approved_at).toBe(5);
    const rv = repo.createReview({ shot_id: s.id, job_id: j.id, frame_paths_json: "[]", compare_image_path: null, checklist_json: "[]", verdict: null, notes: "", vision_json: null });
    repo.updateReview(rv.id, { verdict: "pass" });
    expect(repo.reviews(s.id)[0]?.verdict).toBe("pass");
    repo.addCost("venice", "job:1", 0.42, 0); repo.addCost("claude", "draft:1", 0.01, 900); repo.addCost("claude", "translate:-", 0.002, 300);
    const costs = Object.fromEntries(repo.costs().map((c) => [c.kind, c]));
    expect(costs["claude"]?.tokens).toBe(1200);
    expect(costs["venice"]?.usd).toBeCloseTo(0.42);
    expect(repo.cachedTranslation("Hallo")).toBeUndefined();
    repo.cacheTranslation("Hallo", "Hello");
    expect(repo.cachedTranslation("Hallo")).toBe("Hello");
  });
});
