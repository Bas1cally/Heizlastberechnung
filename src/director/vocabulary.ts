import { existsSync, readFileSync } from "node:fs";

/**
 * Film vocabulary the prompt builder and the code checks accept (spec §4):
 * the user maintains `director/vocabulary.json`; these are the defaults it
 * starts from. The builder never substitutes synonyms: a term that is not
 * in the list is not a named camera move or shot size.
 */
export interface Vocabulary { readonly shotSizes: readonly string[]; readonly cameraMoves: readonly string[]; readonly lightingTerms: readonly string[] }

export const DEFAULT_VOCABULARY: Vocabulary = {
  shotSizes: ["extreme wide shot", "wide shot", "full shot", "medium wide shot", "medium shot", "medium close-up", "close-up", "extreme close-up", "over-the-shoulder shot", "two shot", "insert shot", "point-of-view shot"],
  cameraMoves: ["static shot", "locked-off shot", "slow push-in", "push-in", "pull-back", "dolly in", "dolly out", "tracking shot", "pan left", "pan right", "tilt up", "tilt down", "crane up", "crane down", "handheld", "steadicam follow", "orbit", "arc shot", "whip pan", "rack focus", "zoom in", "zoom out"],
  lightingTerms: ["golden hour", "blue hour", "overcast daylight", "hard sunlight", "soft window light", "low-key lighting", "high-key lighting", "rim light", "backlight", "practical lights", "neon", "candlelight", "moonlight", "tungsten", "fluorescent", "silhouette"],
};

export function loadVocabulary(path = "director/vocabulary.json"): Vocabulary {
  if (!existsSync(path)) return DEFAULT_VOCABULARY;
  const j = JSON.parse(readFileSync(path, "utf8")) as Partial<Vocabulary>;
  return { shotSizes: j.shotSizes ?? DEFAULT_VOCABULARY.shotSizes, cameraMoves: j.cameraMoves ?? DEFAULT_VOCABULARY.cameraMoves, lightingTerms: j.lightingTerms ?? DEFAULT_VOCABULARY.lightingTerms };
}

/** Whether `text` names one of the terms (case-insensitive, whole phrase). */
export function namesTerm(text: string, terms: readonly string[]): string | undefined {
  const t = text.toLowerCase();
  return terms.find((term) => t.includes(term.toLowerCase()));
}
