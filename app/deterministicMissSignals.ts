import { derivePhonemeTeachingFacts } from "./phonemeTeachingFacts.js";
import { hasKnownWordForm, type WordEntry } from "./wordCatalog.js";

const ENDING_RULES = [
  { suffix: "ition", phoneticEndings: ["ishun", "shun"] },
  { suffix: "tion", phoneticEndings: ["shun", "sishun", "chun", "zhun"] },
  { suffix: "sion", phoneticEndings: ["zhun", "shun", "sishun"] },
  { suffix: "cion", phoneticEndings: ["shun", "sishun"] },
  { suffix: "cian", phoneticEndings: ["shun", "sian"] },
  { suffix: "tian", phoneticEndings: ["shun", "tian"] },
  { suffix: "tious", phoneticEndings: ["shus", "chus"] },
  { suffix: "cious", phoneticEndings: ["shus", "chus"] },
  { suffix: "able", phoneticEndings: [] },
  { suffix: "ible", phoneticEndings: [] },
  { suffix: "ance", phoneticEndings: [] },
  { suffix: "ence", phoneticEndings: [] },
  { suffix: "ment", phoneticEndings: [] },
  { suffix: "ous", phoneticEndings: ["us"] },
  { suffix: "ious", phoneticEndings: ["yus", "eeus", "shus"] },
  { suffix: "eous", phoneticEndings: ["yus", "eeus"] },
  { suffix: "ity", phoneticEndings: ["itee"] },
  { suffix: "ary", phoneticEndings: ["ery"] },
  { suffix: "ery", phoneticEndings: ["ary"] },
  { suffix: "ory", phoneticEndings: ["ery"] },
  { suffix: "ate", phoneticEndings: ["it", "ut"] },
  { suffix: "ify", phoneticEndings: ["ifai"] },
  { suffix: "ed", phoneticEndings: ["d", "t", "id"] },
] as const;

type PhonemeTeachingFact = {
  text: string;
  label: string;
  reason: string;
  sounds_like?: string;
};

export function normalizeWordForm(value: string): string {
  return value.toLowerCase().replace(/[^a-z]/g, "");
}

export function parseSimpleSubstitution(
  value: string,
): { actual: string; expected: string } | null {
  const match = value.trim().match(/^([a-z])\s+for\s+([a-z])$/i);
  if (!match) {
    return null;
  }

  return {
    actual: match[1].toLowerCase(),
    expected: match[2].toLowerCase(),
  };
}

function commonPrefixLength(left: string, right: string): number {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function commonSuffixLength(left: string, right: string): number {
  let index = 0;
  while (
    index < left.length &&
    index < right.length &&
    left[left.length - 1 - index] === right[right.length - 1 - index]
  ) {
    index += 1;
  }
  return index;
}

function longestCommonSubsequenceLength(left: string, right: string): number {
  if (!left || !right) {
    return 0;
  }

  const dp = Array.from({ length: left.length + 1 }, () =>
    Array<number>(right.length + 1).fill(0),
  );

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      if (left[leftIndex - 1] === right[rightIndex - 1]) {
        dp[leftIndex]![rightIndex] = (dp[leftIndex - 1]![rightIndex - 1] ?? 0) + 1;
      } else {
        dp[leftIndex]![rightIndex] = Math.max(
          dp[leftIndex - 1]![rightIndex] ?? 0,
          dp[leftIndex]![rightIndex - 1] ?? 0,
        );
      }
    }
  }

  return dp[left.length]![right.length] ?? 0;
}

function collectNgrams(value: string, size: number): string[] {
  if (value.length < size) {
    return value ? [value] : [];
  }

  const result: string[] = [];
  for (let index = 0; index <= value.length - size; index += 1) {
    result.push(value.slice(index, index + size));
  }
  return result;
}

function ngramDiceRatio(left: string, right: string, size: number): number {
  const leftNgrams = collectNgrams(left, size);
  const rightNgrams = collectNgrams(right, size);

  if (leftNgrams.length === 0 && rightNgrams.length === 0) {
    return 0;
  }

  const rightCounts = new Map<string, number>();
  for (const gram of rightNgrams) {
    rightCounts.set(gram, (rightCounts.get(gram) ?? 0) + 1);
  }

  let overlap = 0;
  for (const gram of leftNgrams) {
    const remaining = rightCounts.get(gram) ?? 0;
    if (remaining > 0) {
      overlap += 1;
      rightCounts.set(gram, remaining - 1);
    }
  }

  return (2 * overlap) / (leftNgrams.length + rightNgrams.length);
}

export function buildWrongWordInterpretationHints(
  targetWord: string,
  childAttempt: string,
) {
  const targetNormalized = normalizeWordForm(targetWord);
  const attemptNormalized = normalizeWordForm(childAttempt);
  const lcsLength = longestCommonSubsequenceLength(
    targetNormalized,
    attemptNormalized,
  );
  const denominator = Math.max(targetNormalized.length, attemptNormalized.length, 1);
  const lcsRatio = lcsLength / denominator;
  const sharedPrefix = commonPrefixLength(targetNormalized, attemptNormalized);
  const sharedSuffix = commonSuffixLength(targetNormalized, attemptNormalized);
  const bigramOverlapRatio = ngramDiceRatio(targetNormalized, attemptNormalized, 2);
  const trigramOverlapRatio = ngramDiceRatio(targetNormalized, attemptNormalized, 3);

  return {
    targetNormalized,
    attemptNormalized,
    sharedPrefixLength: sharedPrefix,
    sharedSuffixLength: sharedSuffix,
    longestCommonSubsequenceLength: lcsLength,
    longestCommonSubsequenceRatio: Number(lcsRatio.toFixed(3)),
    bigramOverlapRatio: Number(bigramOverlapRatio.toFixed(3)),
    trigramOverlapRatio: Number(trigramOverlapRatio.toFixed(3)),
    substantialStructuralOverlap:
      lcsRatio >= 0.75 ||
      bigramOverlapRatio >= 0.6 ||
      trigramOverlapRatio >= 0.5 ||
      sharedPrefix >= 4 ||
      sharedSuffix >= 4,
  };
}

export function getDeterministicWrongWordInterpretationFlag(
  targetWord: string,
  childAttempt: string,
  editDistance: number,
  transposedLetters: string[],
): boolean {
  const normalizedAttempt = normalizeWordForm(childAttempt);
  const hints = buildWrongWordInterpretationHints(targetWord, childAttempt);
  if (!hints.targetNormalized || !hints.attemptNormalized) {
    return false;
  }

  if (hints.targetNormalized === hints.attemptNormalized) {
    return false;
  }

  if (!hints.substantialStructuralOverlap) {
    return false;
  }

  if (editDistance <= 1 && transposedLetters.length === 0) {
    return false;
  }

  return hasKnownWordForm(normalizedAttempt);
}

function didAttemptLoseFragment(
  targetWord: string,
  childAttempt: string,
  fragment: string,
): boolean {
  const target = normalizeWordForm(targetWord);
  const attempt = normalizeWordForm(childAttempt);
  const normalizedFragment = normalizeWordForm(fragment);

  if (!normalizedFragment || !target.includes(normalizedFragment)) {
    return false;
  }

  return !attempt.includes(normalizedFragment);
}

function looksPhoneticForEnding(
  childAttempt: string,
  rule: (typeof ENDING_RULES)[number],
): boolean {
  const attempt = childAttempt.toLowerCase();
  return rule.phoneticEndings.some((ending) => attempt.endsWith(ending));
}

function levenshteinDistance(left: string, right: string): number {
  const rows = left.length + 1;
  const cols = right.length + 1;
  const matrix = Array.from({ length: rows }, () => Array<number>(cols).fill(0));

  for (let row = 0; row < rows; row += 1) {
    matrix[row]![0] = row;
  }

  for (let col = 0; col < cols; col += 1) {
    matrix[0]![col] = col;
  }

  for (let row = 1; row < rows; row += 1) {
    for (let col = 1; col < cols; col += 1) {
      const cost = left[row - 1] === right[col - 1] ? 0 : 1;
      matrix[row]![col] = Math.min(
        (matrix[row - 1]![col] ?? 0) + 1,
        (matrix[row]![col - 1] ?? 0) + 1,
        (matrix[row - 1]![col - 1] ?? 0) + cost,
      );
    }
  }

  return matrix[left.length]![right.length] ?? 0;
}

function detectEndingConfusionFacts(targetWord: string, childAttempt: string) {
  const target = targetWord.toLowerCase();
  const attempt = childAttempt.toLowerCase();

  if (target.endsWith("ies") && attempt === `${target.slice(0, -3)}y`) {
    return [
      {
        suffix: "ies",
        attemptedEnding: "y",
        phoneticRewrite: false,
      },
    ];
  }

  if (target.endsWith("es") && attempt === target.slice(0, -2)) {
    return [
      {
        suffix: "es",
        attemptedEnding: "",
        phoneticRewrite: false,
      },
    ];
  }

  if (target.endsWith("s") && attempt === target.slice(0, -1)) {
    return [
      {
        suffix: "s",
        attemptedEnding: "",
        phoneticRewrite: false,
      },
    ];
  }

  for (const rule of ENDING_RULES) {
    if (!target.endsWith(rule.suffix)) {
      continue;
    }

    if (attempt.endsWith(rule.suffix)) {
      continue;
    }

    const stem = target.slice(0, -rule.suffix.length);
    const sharedPrefix = commonPrefixLength(stem, attempt);
    if (sharedPrefix < Math.max(stem.length - 1, 1)) {
      continue;
    }

    return [
      {
        suffix: rule.suffix,
        attemptedEnding: attempt.slice(Math.max(sharedPrefix, 0)),
        phoneticRewrite: looksPhoneticForEnding(childAttempt, rule),
      },
    ];
  }

  for (const rule of ENDING_RULES) {
    if (attempt === `${target}${rule.suffix}`) {
      return [
        {
          suffix: rule.suffix,
          attemptedEnding: rule.suffix,
          phoneticRewrite: looksPhoneticForEnding(childAttempt, rule),
        },
      ];
    }
  }

  const normalizedTarget = normalizeWordForm(targetWord);
  const normalizedAttempt = normalizeWordForm(childAttempt);
  const sharedPrefix = commonPrefixLength(normalizedTarget, normalizedAttempt);
  const remainingTarget = normalizedTarget.slice(sharedPrefix);
  const remainingAttempt = normalizedAttempt.slice(sharedPrefix);

  if (
    sharedPrefix > 0 &&
    remainingTarget.length > 0 &&
    remainingTarget.length <= 5 &&
    remainingAttempt.length <= 5
  ) {
    return [
      {
        suffix: remainingTarget,
        attemptedEnding: remainingAttempt,
        phoneticRewrite: isKnownPhoneticEndingRewrite(
          remainingTarget,
          remainingAttempt,
        ),
      },
    ];
  }

  const targetEnding4 = normalizedTarget.slice(-4);
  const attemptEnding4 = normalizedAttempt.slice(-4);
  if (
    targetEnding4 &&
    attemptEnding4 &&
    targetEnding4 !== attemptEnding4 &&
    (sharedPrefix >= 2 || buildWrongWordInterpretationHints(targetWord, childAttempt).substantialStructuralOverlap)
  ) {
    return [
      {
        suffix: targetEnding4,
        attemptedEnding: attemptEnding4,
        phoneticRewrite: isKnownPhoneticEndingRewrite(
          targetEnding4,
          attemptEnding4,
        ),
      },
    ];
  }

  return [];
}

function isKnownPhoneticEndingRewrite(
  suffix: string,
  attemptedEnding: string,
): boolean {
  const normalizedSuffix = normalizeWordForm(suffix);
  const normalizedAttempt = normalizeWordForm(attemptedEnding);
  if (!normalizedSuffix || !normalizedAttempt) {
    return false;
  }

  const rewriteFamilies: Array<{
    suffixes: string[];
    attempts: string[];
  }> = [
    { suffixes: ["tion"], attempts: ["shun"] },
    { suffixes: ["sion"], attempts: ["shun", "zhun"] },
    { suffixes: ["cian"], attempts: ["shun"] },
    { suffixes: ["tial", "cial"], attempts: ["shul"] },
    { suffixes: ["ture"], attempts: ["cher", "chur"] },
    { suffixes: ["sure"], attempts: ["zher", "zhur"] },
  ];

  return rewriteFamilies.some(
    (family) =>
      family.suffixes.includes(normalizedSuffix) &&
      family.attempts.includes(normalizedAttempt),
  );
}

function collectEndingChunkCandidates(word: WordEntry): string[] {
  const candidates = new Set<string>();
  const addCandidate = (value: string | undefined) => {
    const normalized = normalizeWordForm(value ?? "");
    if (normalized.length >= 3 && normalized.length <= 5) {
      candidates.add(normalized);
    }
  };

  const displayChunks = word.word_breakdown?.display_chunks ?? [];
  addCandidate(displayChunks.at(-1));

  for (const chunkGroup of word.word_breakdown?.alternate_display_chunks ?? []) {
    addCandidate(chunkGroup.at(-1));
  }

  return [...candidates];
}

function detectEndingChunkConfusionFacts(
  word: WordEntry,
  childAttempt: string,
) {
  const target = normalizeWordForm(word.word);
  const attempt = normalizeWordForm(childAttempt);
  if (!target || !attempt || target === attempt) {
    return [];
  }

  const hints = buildWrongWordInterpretationHints(word.word, childAttempt);
  const endingChunks = collectEndingChunkCandidates(word);
  const facts: Array<{
    suffix: string;
    attemptedEnding: string;
    phoneticRewrite: boolean;
  }> = [];

  for (const suffix of endingChunks) {
    if (!target.endsWith(suffix) || attempt.endsWith(suffix)) {
      continue;
    }

    let bestCandidate:
      | {
          attemptedEnding: string;
          distance: number;
        }
      | null = null;

    const minTailLength = Math.max(1, suffix.length - 1);
    const maxTailLength = Math.min(attempt.length, suffix.length + 2);

    for (
      let tailLength = minTailLength;
      tailLength <= maxTailLength;
      tailLength += 1
    ) {
      const attemptedEnding = attempt.slice(-tailLength);
      if (!attemptedEnding || attemptedEnding === suffix) {
        continue;
      }

      const distance = levenshteinDistance(suffix, attemptedEnding);
      const maxDistance = Math.max(2, Math.floor(suffix.length / 2));
      if (distance > maxDistance) {
        continue;
      }

      if (
        !bestCandidate ||
        distance < bestCandidate.distance ||
        (distance === bestCandidate.distance &&
          attemptedEnding.length > bestCandidate.attemptedEnding.length)
      ) {
        bestCandidate = {
          attemptedEnding,
          distance,
        };
      }
    }

    if (!bestCandidate) {
      continue;
    }

    if (
      !hints.substantialStructuralOverlap &&
      commonPrefixLength(target, attempt) < 1 &&
      commonSuffixLength(target, attempt) < 1
    ) {
      continue;
    }

    facts.push({
      suffix,
      attemptedEnding: bestCandidate.attemptedEnding,
      phoneticRewrite: isKnownPhoneticEndingRewrite(
        suffix,
        bestCandidate.attemptedEnding,
      ),
    });
  }

  return facts;
}

function detectDoubleLetterMismatch(targetWord: string, childAttempt: string) {
  const target = normalizeWordForm(targetWord);
  const attempt = normalizeWordForm(childAttempt);
  const missingFromDouble = new Set<string>();
  const extraDouble = new Set<string>();
  const affectedLetters = new Set<string>();

  for (let index = 0; index < target.length - 1; index += 1) {
    const letter = target[index];
    if (!letter || target[index + 1] !== letter) {
      continue;
    }

    const collapsedTarget = target.slice(0, index + 1) + target.slice(index + 2);
    if (
      collapsedTarget === attempt ||
      levenshteinDistance(collapsedTarget, attempt) < levenshteinDistance(target, attempt)
    ) {
      missingFromDouble.add(letter);
      affectedLetters.add(letter);
    }
  }

  for (let index = 0; index < attempt.length - 1; index += 1) {
    const letter = attempt[index];
    if (!letter || attempt[index + 1] !== letter) {
      continue;
    }

    const collapsedAttempt = attempt.slice(0, index + 1) + attempt.slice(index + 2);
    if (
      collapsedAttempt === target ||
      levenshteinDistance(target, collapsedAttempt) < levenshteinDistance(target, attempt)
    ) {
      extraDouble.add(letter);
      affectedLetters.add(letter);
    }
  }

  return {
    detected: missingFromDouble.size > 0 || extraDouble.size > 0,
    missingFromDouble: [...missingFromDouble],
    extraDouble: [...extraDouble],
    affectedLetters: [...affectedLetters],
  };
}

function getWordTeachingFacts(word: WordEntry): {
  silentLetters: PhonemeTeachingFact[];
  trickyParts: PhonemeTeachingFact[];
} {
  if (word.phoneme_metadata?.phonemes?.length) {
    const derivedFacts = derivePhonemeTeachingFacts(
      word.word,
      word.phoneme_metadata.phonemes,
    );
    return {
      silentLetters:
        word.phoneme_metadata.silent_letters?.length
          ? word.phoneme_metadata.silent_letters
          : derivedFacts.silentLetters,
      trickyParts:
        word.phoneme_metadata.tricky_parts?.length
          ? word.phoneme_metadata.tricky_parts
          : derivedFacts.trickyParts,
    };
  }

  return { silentLetters: [], trickyParts: [] };
}

function looksPhoneticForTrickyPart(
  childAttempt: string,
  targetWord: string,
  fact: { sounds_like?: string },
): boolean {
  const normalizedSound = normalizeWordForm(fact.sounds_like ?? "");
  if (!normalizedSound) {
    return false;
  }

  const attempt = normalizeWordForm(childAttempt);
  const target = normalizeWordForm(targetWord);
  return attempt.includes(normalizedSound) && !target.includes(normalizedSound);
}

function isVowelLetter(value: string): boolean {
  return /^[aeiou]$/i.test(value);
}

function detectChunkMismatchFacts(
  chunks: string[],
  childAttempt: string,
  friendlyChunks: string[],
) {
  const normalizedChunks = chunks
    .map((chunk) => normalizeWordForm(chunk))
    .filter((chunk) => chunk.length >= 2);
  const attempt = normalizeWordForm(childAttempt);
  const friendlyPronunciation = normalizeWordForm(friendlyChunks.join(""));
  const result: Array<{
    expectedChunk: string;
    observedFragment: string;
    phoneticRewrite: boolean;
  }> = [];

  let cursor = 0;
  for (const chunk of normalizedChunks) {
    if (!chunk) {
      continue;
    }

    if (attempt.startsWith(chunk, cursor)) {
      cursor += chunk.length;
      continue;
    }

    const nextChunk = normalizedChunks
      .slice(normalizedChunks.indexOf(chunk) + 1)
      .find((value) => value.length >= 2);
    const nextIndex = nextChunk ? attempt.indexOf(nextChunk, cursor) : -1;
    const observedFragment =
      nextIndex >= cursor
        ? attempt.slice(cursor, nextIndex)
        : attempt.slice(cursor);

    if (!observedFragment && chunk.length < 3) {
      continue;
    }

    const phoneticRewrite =
      observedFragment.length >= 4 &&
      friendlyPronunciation.includes(observedFragment) &&
      !chunk.includes(observedFragment);

    result.push({
      expectedChunk: chunk,
      observedFragment,
      phoneticRewrite,
    });
    break;
  }

  return result;
}

export function buildDeterministicMissSignalFacts(word: WordEntry, childAttempt: string, diff: {
  editDistance: number;
  substitutedLetters: string[];
  transposedLetters: string[];
}) {
  const vowelSubstitutionPairs = diff.substitutedLetters
    .map(parseSimpleSubstitution)
    .filter((value): value is { actual: string; expected: string } => value !== null)
    .filter(
      ({ actual, expected }) => isVowelLetter(actual) && isVowelLetter(expected),
    );
  const doubleLetterMismatch = detectDoubleLetterMismatch(word.word, childAttempt);
  const chunkMismatchFacts = detectChunkMismatchFacts(
    word.word_breakdown?.display_chunks ?? [],
    childAttempt,
    word.phoneme_metadata?.friendly_chunks ?? [],
  );
  const endingConfusionFacts = [
    ...detectEndingConfusionFacts(word.word, childAttempt),
    ...detectEndingChunkConfusionFacts(word, childAttempt),
  ];
  const { silentLetters, trickyParts } = getWordTeachingFacts(word);
  const silentLetterFactsTouched = silentLetters.filter((fact) =>
    didAttemptLoseFragment(word.word, childAttempt, fact.text),
  );
  const trickyPartFactsTouched = trickyParts
    .filter((fact) => !/^silent\b/i.test(fact.label))
    .filter((fact) => didAttemptLoseFragment(word.word, childAttempt, fact.text))
    .map((fact) => ({
      ...fact,
      phoneticRewrite: looksPhoneticForTrickyPart(childAttempt, word.word, fact),
    }));
  const wrongWordInterpretationHints = buildWrongWordInterpretationHints(
    word.word,
    childAttempt,
  );

  return {
    repeatedLetterIssue: doubleLetterMismatch.detected,
    vowelSubstitutionPairs,
    doubleLetterMismatch,
    chunkMismatchFacts,
    endingConfusionFacts,
    silentLetterFactsTouched,
    trickyPartFactsTouched,
    wrongWordInterpretationHints,
    deterministicLikelyWrongWordInterpretation:
      getDeterministicWrongWordInterpretationFlag(
        word.word,
        childAttempt,
        diff.editDistance,
        diff.transposedLetters,
      ),
  };
}
