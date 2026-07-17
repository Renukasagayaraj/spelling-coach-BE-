import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  buildStoredSayAloudTip,
  deriveFriendlyPronunciationChunks,
} from "../app/friendlyPronunciation.js";
import { derivePhonemeTeachingFacts } from "../app/phonemeTeachingFacts.js";
import { auditFriendlyPronunciation } from "../app/pronunciationConfidence.js";
import { getSoundAwareMatchedPatterns } from "../app/soundAwarePatterns.js";
import { loadCustomWordLists, saveCustomWordLists } from "../app/wordCatalog.js";

const TARGET_LIST_NAMES = new Set(["G2P Eval Level 1", "G2P Eval Level 3"]);

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
  const allLists = loadCustomWordLists();
  const targetLists = allLists.filter((list) => TARGET_LIST_NAMES.has(list.name));

  if (targetLists.length === 0) {
    throw new Error("Could not find the G2P evaluation custom lists.");
  }

  const uniqueWords = Array.from(
    new Set(
      targetLists.flatMap((list) =>
        list.words.map((entry) => entry.word.trim()).filter(Boolean),
      ),
    ),
  );

  if (uniqueWords.length === 0) {
    throw new Error("No words found in the targeted G2P evaluation lists.");
  }

  // eslint-disable-next-line no-console
  console.log(
    `Computing g2p-en metadata for ${uniqueWords.length} unique words across ${targetLists.length} lists.`,
  );

  const phonemesByWord = runG2pEn(uniqueWords);
  const updatedLists = allLists.map((list) => {
    if (!TARGET_LIST_NAMES.has(list.name)) {
      return list;
    }

    return {
      ...list,
      words: list.words.map((entry) => {
        const phonemes = phonemesByWord[entry.word.trim().toLowerCase()] ?? [];
        const friendlyChunks = deriveFriendlyPronunciationChunks(phonemes);
        const soundAwarePatterns = getSoundAwareMatchedPatterns(entry.word, phonemes);
        const teachingFacts = derivePhonemeTeachingFacts(entry.word, phonemes);
        const sayAloudTip = buildStoredSayAloudTip(
          entry.word,
          phonemes,
          friendlyChunks,
        ) ?? undefined;
        const pronunciationConfidence = auditFriendlyPronunciation({
          ...entry,
          phoneme_metadata: {
            source: "g2p-en",
            phonemes,
            sound_aware_patterns: [],
            silent_letters: teachingFacts.silentLetters,
            tricky_parts: teachingFacts.trickyParts,
            friendly_chunks: friendlyChunks,
            say_aloud_tip: sayAloudTip,
          },
        }).confidence;

        // eslint-disable-next-line no-console
        console.log(`Computed phonemes for ${entry.word}: ${phonemes.join(" ")}`);

        return {
          ...entry,
          phoneme_metadata: {
            source: "g2p-en" as const,
            phonemes,
            sound_aware_patterns: soundAwarePatterns,
            silent_letters: teachingFacts.silentLetters,
            tricky_parts: teachingFacts.trickyParts,
            friendly_chunks: friendlyChunks,
            say_aloud_tip: sayAloudTip,
            pronunciation_confidence: pronunciationConfidence,
          },
        };
      }),
    };
  });

  saveCustomWordLists(updatedLists);
}

void main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exitCode = 1;
});
