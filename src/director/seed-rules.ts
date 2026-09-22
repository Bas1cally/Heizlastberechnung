import type { CheckType, Severity } from "./types.js";

/** Seed rules of VENICE_DIRECTOR_SPEC §3. `check` lists who checks; Jev gets `text_en`. */
export interface SeedRule { code: string; text_de: string; text_en: string; severity: Severity; check: CheckType[] }

export const SEED_RULES: readonly SeedRule[] = [
  { code: "R1", severity: "block", check: ["code", "jev"], text_de: "Jede im Shot genannte Figur hat eine Bildreferenz mit Rollenzuweisung, auch die Hauptfigur (Identitätsreferenz).", text_en: "Every character named in the shot has an image reference with an assigned role, the main character included (identity reference)." },
  { code: "R2", severity: "block", check: ["code"], text_de: "Shots mit Startbild laufen nie als reines I2V, sondern als R2V: Keyframe als Image 1, Identität als Image 2.", text_en: "Shots with a start image never run as plain I2V but as R2V: keyframe as Image 1, identity as Image 2." },
  { code: "R3", severity: "block", check: ["code"], text_de: "Übergang zwischen Clips nur Hard Cut oder Extend. Keine Fortsetzung über Frame-Grab als Startbild.", text_en: "Transitions between clips are hard cut or extend only. No continuation via a grabbed frame used as a start image." },
  { code: "R4", severity: "block", check: ["jev"], text_de: "Jede Aktion muss physisch im Bild stattfinden und vollendet werden (Ursache vor Wirkung).", text_en: "Every action must happen physically within the frame and be completed (cause before effect)." },
  { code: "R5", severity: "block", check: ["code", "jev"], text_de: "Jeder Prompt enthält eine benannte Kamerabewegung und Einstellungsgröße im Film-Vokabular.", text_en: "Every prompt names a camera movement and a shot size in film vocabulary." },
  { code: "R6", severity: "block", check: ["review"], text_de: "Keyframes werden vor der Generierung geprüft; Änderungsbedarf blockiert den Job.", text_en: "Keyframes are checked before generation; a needed change blocks the job." },
  { code: "R7", severity: "block", check: ["vision", "review"], text_de: "Gesicht der Figur bleibt in allen Stills identisch; Frisur darf abweichen.", text_en: "The character's face stays identical in every still; the hairstyle may differ." },
  { code: "R8", severity: "block", check: ["review"], text_de: "Ein Shot gilt erst als abgenommen, wenn Output neben Referenz liegt und dieselbe Person zu sehen ist.", text_en: "A shot is accepted only once the output sits next to the reference and shows the same person." },
  { code: "R9", severity: "warn", check: ["code"], text_de: "Standard-Pipeline: 480p generieren, Upscale extern (Hook). Höhere Auflösung nur mit explizitem Grund.", text_en: "Standard pipeline: generate at 480p, upscale externally (hook). Higher resolution only with an explicit reason." },
  { code: "R10", severity: "warn", check: ["code"], text_de: "Engine und Clip-Dauer werden pro Shot festgelegt und stehen in der Karte, nicht im Prompt.", text_en: "Engine and clip duration are set per shot and live on the card, not in the prompt." },
];
