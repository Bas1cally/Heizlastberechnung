import { describe, expect, it } from "vitest";
import { buildPrompt, stripMetaStatements } from "../../../src/director/prompt-builder.js";
import { engines, identityRef, mara, shotOf } from "./helpers.js";

const r2v = engines.get("seedance-2-0-reference-to-video-basic");
const t2v = engines.get("seedance-2-0-text-to-video-basic");

describe("prompt builder", () => {
  it("keeps the fixed order: binding, shot size, camera move, action, lighting, composition, style", () => {
    const res = buildPrompt({ shot: shotOf(), references: [identityRef()], characters: [mara], engine: r2v, styleGuideEn: "Muted colours, 35 mm grain." });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const p = res.prompt;
    const order = ["Refer to Mara in Image 1", "Medium close-up.", "Slow push-in.", "Mara lifts the cup", "Lighting: soft window light", "Composition: centered", "Style: Muted colours"];
    const idx = order.map((s) => p.indexOf(s));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    expect(res.request).toMatchObject({ model: "seedance-2-0-reference-to-video-basic", duration: "5s", aspect_ratio: "16:9", resolution: "480p" });
    expect(res.request.reference_images).toEqual([{ slot: "Image 1", role: "identity", path: "/refs/mara.png" }]);
  });

  it("uses Venice's R2V binding syntax for keyframes and sums video seconds", () => {
    const key = { ...identityRef("/refs/key.png"), slot: "Image 1", role: "keyframe" as const, subject_label: "" };
    const id = { ...identityRef(), slot: "Image 2" };
    const vid = { ...identityRef("/out/shot1.mp4"), slot: "Video 1", role: "motion" as const, reference: { ...identityRef().reference, id: 3, kind: "video" as const, character_id: null, duration_s: 5 } };
    const res = buildPrompt({ shot: shotOf({ workflow: "r2v_edit" }), references: [id, key, vid], characters: [mara], engine: r2v, styleGuideEn: "" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.prompt.startsWith("Start from the frame in Image 1; Refer to Mara in Image 2 to generate the shot. Follow the motion of Video 1.")).toBe(true);
    expect(res.request.reference_video_total_duration).toBe(5);
  });

  it("refuses extend without the r2v_extend workflow and a video reference (R3)", () => {
    const a = buildPrompt({ shot: shotOf({ transition_in: "extend" }), references: [identityRef()], characters: [mara], engine: r2v, styleGuideEn: "" });
    expect(a).toMatchObject({ ok: false, reason: expect.stringContaining("r2v_extend") });
    const b = buildPrompt({ shot: shotOf({ transition_in: "extend", workflow: "r2v_extend" }), references: [identityRef()], characters: [mara], engine: r2v, styleGuideEn: "" });
    expect(b).toMatchObject({ ok: false, reason: expect.stringContaining("video reference") });
  });

  it("refuses an engine that does not run the workflow, and an unknown engine", () => {
    expect(buildPrompt({ shot: shotOf({ workflow: "r2v_reference" }), references: [identityRef()], characters: [mara], engine: t2v, styleGuideEn: "" }).ok).toBe(false);
    expect(buildPrompt({ shot: shotOf(), references: [], characters: [], engine: undefined, styleGuideEn: "" }).ok).toBe(false);
  });

  it("strips sentences about the prompt's own correctness and never adds engine or duration", () => {
    expect(stripMetaStatements("She opens the door. This prompt follows the rules. Rain falls.")).toBe("She opens the door. Rain falls.");
    const res = buildPrompt({ shot: shotOf({ workflow: "t2v", engine: "seedance-2-0-text-to-video-basic", action_physical_en: "A cat jumps onto the table. This shot is correct." }), references: [], characters: [], engine: t2v, styleGuideEn: "According to the rules this is fine. Warm tones." });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.prompt).not.toMatch(/correct|according to the rules/i);
    expect(res.prompt).not.toMatch(/seedance|5s|480p/i);
    expect(res.prompt).toContain("Style: Warm tones.");
  });
});
