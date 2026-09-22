import { describe, expect, it } from "vitest";
import { codeChecks } from "../../../src/director/code-checks.js";
import { engines, identityRef, mara, shotOf, vocabulary } from "./helpers.js";

const r2v = engines.get("seedance-2-0-reference-to-video-basic");
const failing = (out: ReturnType<typeof codeChecks>) => out.filter((c) => !c.ok).map((c) => `${c.rule}:${c.severity}`);

describe("code checks", () => {
  it("passes a complete card", () => {
    const out = codeChecks({ shot: shotOf(), references: [identityRef()], characters: [mara], engine: r2v, vocabulary, promptFinal: "Refer to Mara in Image 1. Medium close-up. Slow push-in. Mara drinks." });
    expect(failing(out)).toEqual([]);
  });
  it("R1: a named character without an identity reference blocks", () => {
    expect(failing(codeChecks({ shot: shotOf(), references: [], characters: [mara], engine: r2v, vocabulary, promptFinal: "" }))).toContain("R1:block");
  });
  it("R2: a keyframe must sit in Image 1 with an identity in Image 2 under R2V", () => {
    const key = { ...identityRef("/refs/start.png"), slot: "Image 2", role: "keyframe" as const };
    const bad = codeChecks({ shot: shotOf({ workflow: "i2v", engine: "seedance-2-0-image-to-video-basic" }), references: [identityRef(), key], characters: [mara], engine: engines.get("seedance-2-0-image-to-video-basic"), vocabulary, promptFinal: "" });
    expect(failing(bad)).toContain("R2:block");
    const good = codeChecks({ shot: shotOf(), references: [{ ...key, slot: "Image 1" }, { ...identityRef(), slot: "Image 2" }], characters: [mara], engine: r2v, vocabulary, promptFinal: "" });
    expect(failing(good)).not.toContain("R2:block");
  });
  it("R3: extend needs a video reference; a grabbed frame as keyframe blocks", () => {
    expect(failing(codeChecks({ shot: shotOf({ transition_in: "extend", workflow: "r2v_extend" }), references: [identityRef()], characters: [mara], engine: r2v, vocabulary, promptFinal: "" }))).toContain("R3:block");
    const grab = { ...identityRef("/frames/shot1/frame-last.png"), slot: "Image 1", role: "keyframe" as const };
    expect(failing(codeChecks({ shot: shotOf(), references: [grab, { ...identityRef(), slot: "Image 2" }], characters: [mara], engine: r2v, vocabulary, promptFinal: "" }))).toContain("R3:block");
  });
  it("R5: shot size and camera move must come from the vocabulary, on the card and in the prompt", () => {
    expect(failing(codeChecks({ shot: shotOf({ camera_move: "the camera moves a bit" }), references: [identityRef()], characters: [mara], engine: r2v, vocabulary, promptFinal: "" }))).toContain("R5:block");
    const out = codeChecks({ shot: shotOf(), references: [identityRef()], characters: [mara], engine: r2v, vocabulary, promptFinal: "Mara drinks." });
    expect(out.filter((c) => c.rule === "R5" && !c.ok)).toHaveLength(1);
  });
  it("ENGINE: duration, resolution and reference counts against engines.json", () => {
    expect(failing(codeChecks({ shot: shotOf({ duration_s: 7 }), references: [identityRef()], characters: [mara], engine: r2v, vocabulary, promptFinal: "" }))).toContain("ENGINE:block");
    expect(failing(codeChecks({ shot: shotOf(), references: [identityRef()], characters: [mara], engine: undefined, vocabulary, promptFinal: "" }))).toContain("ENGINE:block");
  });
  it("R9 and R10 warn only", () => {
    const out = codeChecks({ shot: shotOf({ resolution: "1080p" }), references: [identityRef()], characters: [mara], engine: r2v, vocabulary, promptFinal: "Medium close-up. Slow push-in. Seedance renders this in 5s." });
    expect(failing(out)).toEqual(expect.arrayContaining(["R9:warn", "R10:warn"]));
    expect(failing(out).some((f) => f.endsWith(":block"))).toBe(false);
  });
});
