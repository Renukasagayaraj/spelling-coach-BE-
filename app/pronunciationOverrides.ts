import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const PronunciationOverrideSchema = z
  .object({
    word: z.string(),
    phonemes: z.array(z.string()).optional(),
    friendly_chunks: z.array(z.string()).optional(),
    say_aloud_tip: z.string().optional(),
    pronunciation_confidence: z.enum(["high", "medium", "low"]).optional(),
  })
  .strict();

const PronunciationOverridesSchema = z.array(PronunciationOverrideSchema);

export type PronunciationOverride = z.infer<typeof PronunciationOverrideSchema>;

const OVERRIDES_PATH = join(
  process.cwd(),
  "reference_data",
  "pronunciation_overrides.json",
);

let overridesCache: PronunciationOverride[] | null = null;

export function loadPronunciationOverrides(): PronunciationOverride[] {
  if (overridesCache) {
    return overridesCache;
  }

  if (!existsSync(OVERRIDES_PATH)) {
    overridesCache = [];
    return overridesCache;
  }

  const content = readFileSync(OVERRIDES_PATH, "utf8");
  overridesCache = PronunciationOverridesSchema.parse(JSON.parse(content));
  return overridesCache;
}

export function invalidatePronunciationOverridesCache(): void {
  overridesCache = null;
}

export function applyPronunciationOverride<T extends {
  word: string;
  phoneme_metadata?: {
    source: "g2p-en";
    phonemes: string[];
    sound_aware_patterns: unknown[];
    friendly_chunks?: string[];
    say_aloud_tip?: string;
    pronunciation_confidence?: "high" | "medium" | "low";
  };
}>(entry: T): T {
  const override = loadPronunciationOverrides().find(
    (candidate) => candidate.word.toLowerCase() === entry.word.toLowerCase(),
  );

  if (!override || !entry.phoneme_metadata) {
    return entry;
  }

  return {
    ...entry,
    phoneme_metadata: {
      ...entry.phoneme_metadata,
      phonemes: override.phonemes ?? entry.phoneme_metadata.phonemes,
      friendly_chunks:
        override.friendly_chunks ?? entry.phoneme_metadata.friendly_chunks,
      say_aloud_tip:
        override.say_aloud_tip ?? entry.phoneme_metadata.say_aloud_tip,
      pronunciation_confidence:
        override.pronunciation_confidence ??
        entry.phoneme_metadata.pronunciation_confidence,
    },
  };
}
