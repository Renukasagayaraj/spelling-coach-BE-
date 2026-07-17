import { getSoundAwareMatchedPatterns } from "./soundAwarePatterns.js";

export type StoredTeachingFact = {
  text: string;
  label: string;
  reason: string;
  source: "phoneme-validated" | "derived-rule";
  sounds_like?: string;
};

const ENDING_TRICKY_PARTS: Array<{
  suffix: string;
  soundsLike: string;
  label: string;
  reason: string;
  phonemeTails: string[][];
}> = [
  {
    suffix: "tion",
    soundsLike: "shun",
    label: "tion says shun",
    reason: "The ending sounds like shun even though it is spelled tion.",
    phonemeTails: [["SH", "AH", "N"], ["CH", "AH", "N"]],
  },
  {
    suffix: "sion",
    soundsLike: "zhun",
    label: "sion says zhun/shun",
    reason: "The ending sounds like zhun or shun even though it is spelled sion.",
    phonemeTails: [["ZH", "AH", "N"], ["SH", "AH", "N"]],
  },
  {
    suffix: "cian",
    soundsLike: "shun",
    label: "cian says shun",
    reason: "The ending sounds like shun even though it is spelled cian.",
    phonemeTails: [["SH", "AH", "N"]],
  },
  {
    suffix: "tian",
    soundsLike: "shun",
    label: "tian says shun",
    reason: "The ending sounds like shun even though it is spelled tian.",
    phonemeTails: [["SH", "AH", "N"]],
  },
  {
    suffix: "tious",
    soundsLike: "shus",
    label: "tious says shus",
    reason: "The ending sounds like shus even though it is spelled tious.",
    phonemeTails: [["SH", "AH", "S"], ["CH", "AH", "S"]],
  },
  {
    suffix: "cious",
    soundsLike: "shus",
    label: "cious says shus",
    reason: "The ending sounds like shus even though it is spelled cious.",
    phonemeTails: [["SH", "AH", "S"], ["CH", "AH", "S"]],
  },
];

function normalizePhoneme(phoneme: string): string {
  return phoneme.replace(/[0-9]/g, "").trim().toUpperCase();
}

function hasNormalizedPhoneme(phonemes: string[], phoneme: string): boolean {
  return phonemes.some((value) => normalizePhoneme(value) === phoneme);
}

function hasAdjacentNormalizedPhonemes(
  phonemes: string[],
  left: string,
  right: string,
): boolean {
  for (let index = 0; index < phonemes.length - 1; index += 1) {
    if (
      normalizePhoneme(phonemes[index]!) === left &&
      normalizePhoneme(phonemes[index + 1]!) === right
    ) {
      return true;
    }
  }

  return false;
}

function endsWithNormalizedPhonemes(
  phonemes: string[],
  tail: string[],
): boolean {
  if (phonemes.length < tail.length) {
    return false;
  }

  const normalized = phonemes.map(normalizePhoneme);
  return tail.every(
    (value, index) => normalized[normalized.length - tail.length + index] === value,
  );
}

function getExpectedLongVowelPhonemes(vowel: string): string[] {
  switch (vowel) {
    case "a":
      return ["EY"];
    case "i":
      return ["AY"];
    case "o":
      return ["OW"];
    case "u":
      return ["UW"];
    default:
      return [];
  }
}

function buildSilentENote(word: string, phonemes: string[]): StoredTeachingFact | null {
  const match = word.match(/([aeiou])[^aeiouy]+e$/i);
  if (!match) {
    return null;
  }

  const vowel = match[1]!.toLowerCase();
  const expected = getExpectedLongVowelPhonemes(vowel);
  if (expected.length === 0) {
    return null;
  }

  const saysName =
    expected.some((phoneme) => hasNormalizedPhoneme(phonemes, phoneme)) ||
    hasAdjacentNormalizedPhonemes(phonemes, "Y", "UW");

  return {
    text: "e",
    label: "final e pattern",
    reason: saysName
      ? `The final e helps the ${vowel} say its name.`
      : `The final e is there, but the ${vowel} does not say its name.`,
    source: "derived-rule",
  };
}

function uniqueFacts(values: StoredTeachingFact[]): StoredTeachingFact[] {
  const seen = new Set<string>();
  const result: StoredTeachingFact[] = [];

  for (const value of values) {
    const key = JSON.stringify(value);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(value);
  }

  return result;
}

function buildSilentLetterFacts(
  patterns: Array<{ label: string }>,
): StoredTeachingFact[] {
  return patterns
    .map((pattern) => {
      const match = pattern.label.match(/^silent ([a-z]+) \(phoneme-validated\)$/i);
      if (!match) {
        return null;
      }

      const grapheme = match[1]!.toLowerCase();
      return {
        text: grapheme,
        label: `silent ${grapheme}`,
        reason: `The ${grapheme} is written but not pronounced.`,
        source: "phoneme-validated" as const,
      };
    })
    .filter((value): value is StoredTeachingFact => value !== null);
}

function buildPatternTrickyParts(
  word: string,
  patterns: Array<{ label: string }>,
): StoredTeachingFact[] {
  const trickyParts: StoredTeachingFact[] = [];

  for (const pattern of patterns) {
    switch (pattern.label) {
      case "soft c (phoneme-validated)":
        trickyParts.push({
          text: "c",
          label: "soft c",
          sounds_like: "s",
          reason: "The c is spelled with c but sounds like s here.",
          source: "phoneme-validated",
        });
        break;
      case "soft g (phoneme-validated)":
        trickyParts.push({
          text: "g",
          label: "soft g",
          sounds_like: "j",
          reason: "The g is spelled with g but sounds like j here.",
          source: "phoneme-validated",
        });
        break;
      case "ea says long e (phoneme-validated)":
        trickyParts.push({
          text: "ea",
          label: "ea says long e",
          sounds_like: "ee",
          reason: "The ea is spelled ea but sounds like long e here.",
          source: "phoneme-validated",
        });
        break;
      case "ea says air (phoneme-validated)":
        trickyParts.push({
          text: "ea",
          label: "ea says air",
          sounds_like: "air",
          reason: "The ea is spelled ea but sounds like air here.",
          source: "phoneme-validated",
        });
        break;
      case "ea says short e (phoneme-validated)":
        trickyParts.push({
          text: "ea",
          label: "ea says short e",
          sounds_like: "e",
          reason: "The ea is spelled ea but sounds like short e here.",
          source: "phoneme-validated",
        });
        break;
      case "igh says long i (phoneme-validated)":
        trickyParts.push({
          text: "igh",
          label: "igh says long i",
          sounds_like: "eye",
          reason: "The igh is spelled igh but sounds like long i here.",
          source: "phoneme-validated",
        });
        break;
      case "oi/oy says oi (phoneme-validated)":
        trickyParts.push({
          text: word.includes("oi") ? "oi" : "oy",
          label: "oi/oy says oi",
          sounds_like: "oi",
          reason: "This vowel team is spelled with oi/oy but sounds like oi here.",
          source: "phoneme-validated",
        });
        break;
      case "ou says ow (phoneme-validated)":
        trickyParts.push({
          text: "ou",
          label: "ou says ow",
          sounds_like: "ow",
          reason: "The ou is spelled ou but sounds like ow here.",
          source: "phoneme-validated",
        });
        break;
      case "ow says ow (phoneme-validated)":
        trickyParts.push({
          text: "ow",
          label: "ow says ow",
          sounds_like: "ow",
          reason: "The ow is spelled ow but sounds like ow here.",
          source: "phoneme-validated",
        });
        break;
      case "final y says long i (phoneme-validated)":
        trickyParts.push({
          text: "y",
          label: "final y says long i",
          sounds_like: "eye",
          reason: "The final y is spelled with y but sounds like long i here.",
          source: "phoneme-validated",
        });
        break;
      case "final y says long e (phoneme-validated)":
        trickyParts.push({
          text: "y",
          label: "final y says long e",
          sounds_like: "ee",
          reason: "The final y is spelled with y but sounds like long e here.",
          source: "phoneme-validated",
        });
        break;
      case "middle y says short i (phoneme-validated)":
        trickyParts.push({
          text: "y",
          label: "middle y says short i",
          sounds_like: "i",
          reason: "The y is spelled with y but sounds like short i here.",
          source: "phoneme-validated",
        });
        break;
      default:
        break;
    }
  }

  return trickyParts;
}

function buildDirectSoundMismatchFacts(
  word: string,
  phonemes: string[],
): StoredTeachingFact[] {
  const facts: StoredTeachingFact[] = [];

  if (word.includes("ph") && hasNormalizedPhoneme(phonemes, "F")) {
    facts.push({
      text: "ph",
      label: "ph says f",
      sounds_like: "f",
      reason: "The ph is spelled ph but sounds like f here.",
      source: "derived-rule",
    });
  }

  if (word.includes("gh") && hasNormalizedPhoneme(phonemes, "F")) {
    facts.push({
      text: "gh",
      label: "gh says f",
      sounds_like: "f",
      reason: "The gh is spelled gh but sounds like f here.",
      source: "derived-rule",
    });
  }

  for (const ending of ENDING_TRICKY_PARTS) {
    if (!word.endsWith(ending.suffix)) {
      continue;
    }

    if (!ending.phonemeTails.some((tail) => endsWithNormalizedPhonemes(phonemes, tail))) {
      continue;
    }

    facts.push({
      text: ending.suffix,
      label: ending.label,
      sounds_like: ending.soundsLike,
      reason: ending.reason,
      source: "derived-rule",
    });
  }

  const silentEFact = buildSilentENote(word, phonemes);
  if (silentEFact) {
    facts.push(silentEFact);
  }

  return facts;
}

export function derivePhonemeTeachingFacts(
  targetWord: string,
  rawPhonemes: string[],
): {
  silentLetters: StoredTeachingFact[];
  trickyParts: StoredTeachingFact[];
} {
  const word = targetWord.trim().toLowerCase();
  if (!word || rawPhonemes.length === 0) {
    return {
      silentLetters: [],
      trickyParts: [],
    };
  }

  const patterns = getSoundAwareMatchedPatterns(word, rawPhonemes);
  const silentLetters = uniqueFacts(buildSilentLetterFacts(patterns));
  const trickyParts = uniqueFacts([
    ...silentLetters,
    ...buildPatternTrickyParts(word, patterns),
    ...buildDirectSoundMismatchFacts(word, rawPhonemes),
  ]);

  return {
    silentLetters,
    trickyParts,
  };
}
