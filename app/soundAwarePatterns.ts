import type { PatternMatch } from "./schemas.js";

const VOWEL_PHONEMES = new Set([
  "AA",
  "AE",
  "AH",
  "AO",
  "AW",
  "AY",
  "EH",
  "ER",
  "EY",
  "IH",
  "IY",
  "OW",
  "OY",
  "UH",
  "UW",
]);

function normalizePhonemes(phonemes: string[]): string[] {
  return phonemes
    .map((phoneme) => phoneme.replace(/[0-9]/g, "").trim().toUpperCase())
    .filter(Boolean);
}

function hasPhoneme(phonemes: string[], phoneme: string): boolean {
  return phonemes.includes(phoneme);
}

function hasAdjacentPhonemes(phonemes: string[], left: string, right: string): boolean {
  for (let index = 0; index < phonemes.length - 1; index += 1) {
    if (phonemes[index] === left && phonemes[index + 1] === right) {
      return true;
    }
  }

  return false;
}

function countVowelPhonemes(phonemes: string[]): number {
  return phonemes.filter((phoneme) => VOWEL_PHONEMES.has(phoneme)).length;
}

function uniqueMatches(values: PatternMatch[]): PatternMatch[] {
  const seen = new Set<string>();
  const result: PatternMatch[] = [];

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

function hasAnyPhoneme(phonemes: string[], candidates: string[]): boolean {
  return candidates.some((candidate) => hasPhoneme(phonemes, candidate));
}

function detectSilentLetterPatterns(
  word: string,
  phonemes: string[],
): PatternMatch[] {
  const matches: PatternMatch[] = [];

  if ((word.includes("mb") || word.includes("bt")) && !hasPhoneme(phonemes, "B")) {
    matches.push({ label: "silent b (phoneme-validated)" });
  }

  if (/sc(?=[iey])/.test(word) && hasPhoneme(phonemes, "S") && !hasPhoneme(phonemes, "K")) {
    matches.push({ label: "silent c (phoneme-validated)" });
  }

  if (word.includes("gn") && !hasAnyPhoneme(phonemes, ["G", "JH"])) {
    matches.push({ label: "silent g (phoneme-validated)" });
  }

  if (
    word.includes("gh") &&
    !hasAnyPhoneme(phonemes, ["G", "F"])
  ) {
    matches.push({ label: "silent gh (phoneme-validated)" });
  }

  if (
    ((word.startsWith("wh") && hasPhoneme(phonemes, "W")) ||
      (word.startsWith("rh") && hasPhoneme(phonemes, "R")) ||
      (/^h(?:on|ou|ei)/.test(word) && !hasPhoneme(phonemes, "HH"))) &&
    !hasPhoneme(phonemes, "HH")
  ) {
    matches.push({ label: "silent h (phoneme-validated)" });
  }

  if (word.startsWith("kn") && !hasPhoneme(phonemes, "K")) {
    matches.push({ label: "silent k (phoneme-validated)" });
  }

  if (
    (/(alf|alk|alm|ould)/.test(word) || word === "half") &&
    !hasPhoneme(phonemes, "L")
  ) {
    matches.push({ label: "silent l (phoneme-validated)" });
  }

  if (word.endsWith("mn") && !hasPhoneme(phonemes, "N")) {
    matches.push({ label: "silent n (phoneme-validated)" });
  }

  if (
    (word.includes("stle") || word.includes("ften")) &&
    !hasPhoneme(phonemes, "T")
  ) {
    matches.push({ label: "silent t (phoneme-validated)" });
  }

  if (
    ((word.startsWith("wr") || word.includes("answ")) && !hasPhoneme(phonemes, "W"))
  ) {
    matches.push({ label: "silent w (phoneme-validated)" });
  }

  return matches;
}

export function getSoundAwareMatchedPatterns(
  targetWord: string,
  rawPhonemes: string[],
): PatternMatch[] {
  const word = targetWord.trim().toLowerCase();
  if (!word) {
    return [];
  }

  const phonemes = normalizePhonemes(rawPhonemes);
  if (phonemes.length === 0) {
    return [];
  }

  const matches: PatternMatch[] = [];
  const syllableCount = countVowelPhonemes(phonemes);

  matches.push(...detectSilentLetterPatterns(word, phonemes));
  const hasSilentC = matches.some(
    (match) => match.label === "silent c (phoneme-validated)",
  );

  if (
    !hasSilentC &&
    !/cious$/.test(word) &&
    /[c](?=[eiy])/.test(word) &&
    hasPhoneme(phonemes, "S")
  ) {
    matches.push({ label: "soft c (phoneme-validated)" });
  }

  if (/[g](?=[eiy])/.test(word) && hasPhoneme(phonemes, "JH")) {
    matches.push({ label: "soft g (phoneme-validated)" });
  }

  if (word.includes("ea")) {
    if (hasPhoneme(phonemes, "IY")) {
      matches.push({ label: "ea says long e (phoneme-validated)" });
    } else if (hasAdjacentPhonemes(phonemes, "EH", "R")) {
      matches.push({ label: "ea says air (phoneme-validated)" });
    } else if (hasPhoneme(phonemes, "EH")) {
      matches.push({ label: "ea says short e (phoneme-validated)" });
    }
  }

  if (word.includes("igh") && hasPhoneme(phonemes, "AY")) {
    matches.push({ label: "igh says long i (phoneme-validated)" });
  }

  if ((word.includes("oi") || word.includes("oy")) && hasPhoneme(phonemes, "OY")) {
    matches.push({ label: "oi/oy says oi (phoneme-validated)" });
  }

  if (word.includes("ou") && hasPhoneme(phonemes, "AW")) {
    matches.push({ label: "ou says ow (phoneme-validated)" });
  }

  if (word.includes("ow") && hasPhoneme(phonemes, "AW")) {
    matches.push({ label: "ow says ow (phoneme-validated)" });
  }

  if (word.endsWith("y")) {
    if (syllableCount <= 1 && hasPhoneme(phonemes, "AY")) {
      matches.push({ label: "final y says long i (phoneme-validated)" });
    } else if (syllableCount >= 2 && hasPhoneme(phonemes, "IY")) {
      matches.push({ label: "final y says long e (phoneme-validated)" });
    }
  }

  const yIndex = word.indexOf("y");
  if (
    yIndex > 0 &&
    yIndex < word.length - 1 &&
    hasPhoneme(phonemes, "IH")
  ) {
    matches.push({ label: "middle y says short i (phoneme-validated)" });
  }

  return uniqueMatches(matches);
}
