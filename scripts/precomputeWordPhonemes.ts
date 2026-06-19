import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildStoredSayAloudTip,
  deriveFriendlyPronunciationChunks,
} from "../app/friendlyPronunciation.js";
import { auditFriendlyPronunciation } from "../app/pronunciationConfidence.js";
import { getSoundAwareMatchedPatterns } from "../app/soundAwarePatterns.js";

type StoredPatternMatch = {
  label: string;
  matchedText?: string;
  matchedParts?: string[];
  alternateMatchedParts?: string[][];
};

type WordEntry = {
  word: string;
  level: string;
  grade_band: string;
  difficulty: string;
  origin: string;
  definition: string;
  example_sentence: string;
  patterns: string[];
  common_mistakes: string[];
  coach_tip: string;
  part_of_speech: string;
  word_breakdown?: unknown;
  phoneme_metadata?: {
    source: "g2p-en";
    phonemes: string[];
    sound_aware_patterns: StoredPatternMatch[];
    friendly_chunks?: string[];
    say_aloud_tip?: string;
    pronunciation_confidence?: "high" | "medium" | "low";
  };
};

const WORD_CATALOG_PATH = join(
  process.cwd(),
  "reference_data",
  "words.generated.json",
);

function resolvePythonBinary(): string {
  const explicit = process.env.SPELLING_COACH_G2P_PYTHON?.trim();
  if (explicit) {
    return explicit;
  }

  const localVenvPython = join(process.cwd(), ".venv-g2p", "bin", "python3");
  if (existsSync(localVenvPython)) {
    return localVenvPython;
  }

  return "python3";
}

function runG2pEn(words: string[]): Record<string, string[]> {
  const helperPath = join(process.cwd(), "scripts", "g2pEnLookup.py");
  const result = spawnSync(resolvePythonBinary(), [helperPath], {
    cwd: process.cwd(),
    encoding: "utf8",
    input: JSON.stringify(words),
  });

  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "g2p-en helper failed.");
  }

  return JSON.parse(result.stdout) as Record<string, string[]>;
}

async function main(): Promise<void> {
  const overwrite = process.argv.includes("--overwrite");
  const words = JSON.parse(readFileSync(WORD_CATALOG_PATH, "utf8")) as WordEntry[];

  const targets = words.filter(
    (entry) =>
      overwrite ||
      !entry.phoneme_metadata?.phonemes?.length ||
      !entry.phoneme_metadata?.say_aloud_tip?.trim() ||
      !entry.phoneme_metadata?.friendly_chunks?.length,
  );

  if (targets.length === 0) {
    // eslint-disable-next-line no-console
    console.log("All main word-bank entries already have phoneme metadata and say-aloud tips.");
    return;
  }

  // eslint-disable-next-line no-console
  console.log(`Computing g2p-en metadata for ${targets.length} main word-bank words.`);

  const phonemesByWord = runG2pEn(targets.map((entry) => entry.word.trim()));
  const updatedWords = words.map((entry) => {
    const shouldRefresh =
      overwrite ||
      !entry.phoneme_metadata?.phonemes?.length ||
      !entry.phoneme_metadata?.say_aloud_tip?.trim() ||
      !entry.phoneme_metadata?.friendly_chunks?.length;

    if (!shouldRefresh) {
      return entry;
    }

    const phonemes = phonemesByWord[entry.word.trim().toLowerCase()] ?? [];
    const friendlyChunks = deriveFriendlyPronunciationChunks(phonemes);
    const sayAloudTip = buildStoredSayAloudTip(
      entry.word,
      phonemes,
      friendlyChunks,
    );
    const pronunciationConfidence = auditFriendlyPronunciation({
      ...entry,
      phoneme_metadata: {
        source: "g2p-en",
        phonemes,
        sound_aware_patterns: [],
        friendly_chunks: friendlyChunks,
        say_aloud_tip: sayAloudTip ?? undefined,
      },
    }).confidence;

    // eslint-disable-next-line no-console
    console.log(`Computed phonemes for ${entry.word}: ${phonemes.join(" ")}`);

    return {
      ...entry,
      phoneme_metadata: {
        source: "g2p-en" as const,
        phonemes,
        sound_aware_patterns: getSoundAwareMatchedPatterns(entry.word, phonemes),
        friendly_chunks: friendlyChunks,
        say_aloud_tip: sayAloudTip ?? undefined,
        pronunciation_confidence: pronunciationConfidence,
      },
    };
  });

  writeFileSync(WORD_CATALOG_PATH, `${JSON.stringify(updatedWords, null, 2)}\n`, "utf8");
}

void main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exitCode = 1;
});
