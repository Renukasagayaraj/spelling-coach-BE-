import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  PatternMatch,
  SpellingCoachOutput,
  WordBreakdown as SchemaWordBreakdown,
  WordTeachingPrecompute,
} from "./schemas.js";
import { getStoredSoundAwarePatterns, getWordByText } from "./wordCatalog.js";

type WordBreakdown = SchemaWordBreakdown;

type BlendCategory =
  | "vowel teams"
  | "consonant blends"
  | "3-letter consonant blends"
  | "digraphs"
  | "r-controlled digraphs"
  | "w-controlled digraphs"
  | "l-controlled digraphs"
  | "silent letter digraphs"
  | "word endings";

type BlendGroup = {
  category: BlendCategory;
  patterns: string[];
};

type MatchCandidate = {
  start: number;
  end: number;
  length: number;
  label: string;
};

const VOWELS = new Set(["a", "e", "i", "o", "u"]);
const PREFIX_PATTERNS = ["re", "un", "dis"] as const;
const SUFFIX_PATTERNS = ["ful", "less", "ness", "ly", "er", "est"] as const;
const INFLECTIONAL_ENDINGS = ["ing", "ed", "es", "s"] as const;
const CONTRACTION_ENDINGS = ["n't", "'ll", "'m", "'s", "'re", "'ve"] as const;
const INITIAL_DIGRAPHS = ["th", "sh", "wh", "ch"] as const;
const FINAL_DIGRAPHS = ["ck", "th", "sh", "ch"] as const;
const VOWEL_DIGRAPHS = ["ea", "oo", "au", "aw", "ow", "ou", "oi", "oy", "ew"] as const;
const SILENT_LETTER_PATTERNS = ["kn", "wr", "gn", "mb", "gh", "ck"] as const;
const R_CONTROLLED_PATTERNS = ["ar", "or", "er", "ir", "ur"] as const;

let blendGroupsCache: BlendGroup[] | null = null;

function parsePatternList(value: string): string[] {
  return value
    .replace(/\.$/, "")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

function loadBlendGroups(): BlendGroup[] {
  if (blendGroupsCache) {
    return blendGroupsCache;
  }

  const content = readFileSync(
    join(process.cwd(), "reference_data", "blends.txt"),
    "utf8",
  );
  const groups: BlendGroup[] = [];

  for (const line of content.split(/\r?\n/).filter(Boolean)) {
    const [rawCategory = "", rawPatterns = ""] = line.split("=");
    if (!rawCategory || !rawPatterns) {
      continue;
    }

    groups.push({
      category: rawCategory.trim().toLowerCase() as BlendCategory,
      patterns: parsePatternList(rawPatterns),
    });
  }

  blendGroupsCache = groups;
  return groups;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
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

function getMergedMatchedPatterns(targetWord: string): PatternMatch[] {
  return uniqueMatches([
    ...getNewMatchedPatterns(targetWord),
    ...getStoredSoundAwarePatterns(targetWord),
  ]);
}

function isVowel(char: string | undefined): boolean {
  if (!char) {
    return false;
  }

  return VOWELS.has(char.toLowerCase());
}

function normalizeWord(word: string): string {
  return word.trim().toLowerCase();
}

function getDoubleConsonantMatches(word: string): PatternMatch[] {
  const matches: PatternMatch[] = [];

  for (let index = 0; index < word.length - 1; index += 1) {
    const current = word[index]!;
    const next = word[index + 1]!;
    if (current !== next) {
      continue;
    }

    if (isVowel(current) || current === "y") {
      continue;
    }

    matches.push({ label: `double consonant ${current}${next}` });
  }

  return uniqueMatches(matches);
}

function countSyllableLikeGroups(word: string): number {
  const normalized = normalizeWord(word).replace(/[^a-z]/g, "");
  if (!normalized) {
    return 0;
  }

  let groups = 0;
  let previousWasVowel = false;

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]!;
    const isCurrentVowel = isVowel(char) || (char === "y" && index > 0);
    if (isCurrentVowel && !previousWasVowel) {
      groups += 1;
    }
    previousWasVowel = isCurrentVowel;
  }

  if (normalized.endsWith("e") && groups > 1 && !normalized.endsWith("le")) {
    groups -= 1;
  }

  return Math.max(groups, 1);
}

function supportsPrefix(word: string, prefix: string): boolean {
  return word.startsWith(prefix) && word.length > prefix.length + 1;
}

function supportsSuffix(word: string, suffix: string): boolean {
  return word.endsWith(suffix) && word.length > suffix.length + 1;
}

function detectCompoundWord(word: string): boolean {
  for (let index = 2; index <= word.length - 2; index += 1) {
    const left = word.slice(0, index);
    const right = word.slice(index);
    if (getWordByText(left) && getWordByText(right)) {
      return true;
    }
  }

  return false;
}

function detectYAsVowel(word: string): boolean {
  for (let index = 1; index < word.length; index += 1) {
    const char = word[index]!;
    if (char !== "y") {
      continue;
    }

    const previous = word[index - 1];
    const next = word[index + 1];
    if (!isVowel(previous) && !isVowel(next)) {
      return true;
    }

    if (index === word.length - 1 && !isVowel(previous)) {
      return true;
    }
  }

  return false;
}

function findFirstVccvSpan(word: string): string | null {
  for (let index = 1; index < word.length - 2; index += 1) {
    if (
      isVowel(word[index - 1]) &&
      !isVowel(word[index]) &&
      word[index] !== "y" &&
      !isVowel(word[index + 1]) &&
      word[index + 1] !== "y" &&
      (isVowel(word[index + 2]) || word[index + 2] === "y")
    ) {
      return word.slice(index - 1, index + 3);
    }
  }

  return null;
}

function deriveTwoSyllableParts(word: string): string[] | null {
  const vccv = findFirstVccvSpan(word);
  if (vccv) {
    const start = word.indexOf(vccv);
    const splitIndex = start + 2;
    return [word.slice(0, splitIndex), word.slice(splitIndex)].filter(Boolean);
  }

  const midpoint = Math.floor(word.length / 2);
  return [word.slice(0, midpoint), word.slice(midpoint)].filter(Boolean);
}

function deriveAlternateTwoSyllableParts(
  word: string,
  primaryParts: string[],
): string[][] {
  const candidates: string[][] = [];

  const vccv = findFirstVccvSpan(word);
  if (vccv) {
    const start = word.indexOf(vccv);
    const splitIndex = start + 3;
    const candidate = [word.slice(0, splitIndex), word.slice(splitIndex)].filter(Boolean);
    if (candidate.length === 2) {
      candidates.push(candidate);
    }
  }

  const uniqueCandidates: string[][] = [];
  const seen = new Set<string>([JSON.stringify(primaryParts)]);
  for (const candidate of candidates) {
    const key = JSON.stringify(candidate);
    if (candidate.length !== 2 || seen.has(key)) {
      continue;
    }
    seen.add(key);
    uniqueCandidates.push(candidate);
    if (uniqueCandidates.length === 2) {
      break;
    }
  }

  return uniqueCandidates;
}

function overlaps(left: MatchCandidate, right: MatchCandidate): boolean {
  return left.start < right.end && right.start < left.end;
}

function formatBlendLabel(category: BlendCategory, pattern: string): string {
  switch (category) {
    case "vowel teams":
      return `vowel pattern ${pattern}`;
    case "consonant blends":
      return `blend ${pattern}`;
    case "3-letter consonant blends":
      return `3-letter blend ${pattern}`;
    case "digraphs":
      if (INITIAL_DIGRAPHS.includes(pattern as (typeof INITIAL_DIGRAPHS)[number])) {
        return `digraph ${pattern}`;
      }
      return `digraph ${pattern}`;
    case "r-controlled digraphs":
      return `r-controlled vowel ${pattern}`;
    case "w-controlled digraphs":
      return `w-controlled vowel ${pattern}`;
    case "l-controlled digraphs":
      return `l-controlled pattern ${pattern}`;
    case "silent letter digraphs":
      return `digraph ${pattern}`;
    case "word endings":
      return `word ending -${pattern}`;
  }
}

function getBlendBasedMatches(word: string): PatternMatch[] {
  const matched: MatchCandidate[] = [];

  for (const group of loadBlendGroups()) {
    for (const pattern of group.patterns) {
      if (group.category === "word endings") {
        if (word.endsWith(pattern)) {
          matched.push({
            label: formatBlendLabel(group.category, pattern),
            start: word.length - pattern.length,
            end: word.length,
            length: pattern.length,
          });
        }
        continue;
      }

      let startIndex = word.indexOf(pattern);
      while (startIndex !== -1) {
        matched.push({
          label: formatBlendLabel(group.category, pattern),
          start: startIndex,
          end: startIndex + pattern.length,
          length: pattern.length,
        });
        startIndex = word.indexOf(pattern, startIndex + 1);
      }
    }
  }

  matched.sort((left, right) => {
    if (right.length !== left.length) {
      return right.length - left.length;
    }

    return left.start - right.start;
  });

  const kept: MatchCandidate[] = [];
  for (const candidate of matched) {
    if (kept.some((existing) => overlaps(existing, candidate))) {
      continue;
    }

    kept.push(candidate);
  }

  kept.sort((left, right) => left.start - right.start);
  return uniqueMatches(kept.map((match) => ({ label: match.label })));
}

function getImageBasedMatches(word: string): PatternMatch[] {
  const matches: PatternMatch[] = [...getDoubleConsonantMatches(word)];

  for (const pattern of INITIAL_DIGRAPHS) {
    if (word.startsWith(pattern)) {
      matches.push({ label: `initial digraph ${pattern}` });
    }
  }

  for (const pattern of FINAL_DIGRAPHS) {
    if (word.endsWith(pattern)) {
      matches.push({ label: `final digraph ${pattern}` });
    }
  }

  for (const pattern of SILENT_LETTER_PATTERNS) {
    if (pattern === "mb") {
      if (word.endsWith(pattern)) {
        matches.push({ label: `digraph ${pattern}` });
      }
      continue;
    }

    if (pattern === "gh") {
      if (word.startsWith(pattern) || word.endsWith(pattern)) {
        matches.push({ label: `digraph ${pattern}` });
      }
      continue;
    }

    if (word.startsWith(pattern)) {
      matches.push({ label: `digraph ${pattern}` });
    }
  }

  for (const pattern of R_CONTROLLED_PATTERNS) {
    if (word.includes(pattern)) {
      matches.push({ label: `r-controlled vowel ${pattern}` });
    }
  }

  for (const pattern of VOWEL_DIGRAPHS) {
    if (word.includes(pattern)) {
      matches.push({ label: `vowel pattern ${pattern}` });
    }
  }

  for (const prefix of PREFIX_PATTERNS) {
    if (supportsPrefix(word, prefix)) {
      matches.push({ label: `prefix ${prefix}-` });
    }
  }

  for (const suffix of SUFFIX_PATTERNS) {
    if (supportsSuffix(word, suffix)) {
      matches.push({ label: `suffix -${suffix}` });
    }
  }

  for (const ending of INFLECTIONAL_ENDINGS) {
    if (supportsSuffix(word, ending)) {
      matches.push({ label: `ending -${ending}` });
    }
  }

  if (supportsSuffix(word, "le")) {
    matches.push({ label: "ending -le" });
  }

  if (word.endsWith("s") && word.length > 2) {
    matches.push({ label: "ending -s" });
    const singular = word.slice(0, -1);
    if (getWordByText(singular)) {
      matches.push({ label: "plural with -s" });
    }
  }

  if (word.endsWith("es") && word.length > 3) {
    matches.push({ label: "ending -es" });
    const singular = word.slice(0, -2);
    const singularWithE = word.slice(0, -1);
    if (getWordByText(singular) || getWordByText(singularWithE)) {
      matches.push({ label: "plural with -es" });
    }
  }

  for (const contractionEnding of CONTRACTION_ENDINGS) {
    if (word.endsWith(contractionEnding)) {
      if (contractionEnding === "n't") {
        matches.push({ label: "contraction with not" });
      } else if (contractionEnding === "'ll") {
        matches.push({ label: "contraction with will" });
      } else if (contractionEnding === "'m") {
        matches.push({ label: "contraction with am" });
      } else if (contractionEnding === "'s") {
        matches.push({ label: "contraction with is" });
      } else if (contractionEnding === "'re") {
        matches.push({ label: "contraction with are" });
      } else if (contractionEnding === "'ve") {
        matches.push({ label: "contraction with have" });
      } else if (contractionEnding === "'s" && word === "let's") {
        matches.push({ label: "contraction with us" });
      }
    }
  }

  if (countSyllableLikeGroups(word) === 2) {
    const matchedParts = deriveTwoSyllableParts(word) ?? undefined;
    matches.push({
      label: "two syllables",
      matchedParts,
      alternateMatchedParts:
        matchedParts && deriveAlternateTwoSyllableParts(word, matchedParts).length > 0
          ? deriveAlternateTwoSyllableParts(word, matchedParts)
          : undefined,
    });
  }

  if (detectCompoundWord(word)) {
    matches.push({ label: "compound word" });
  }

  if (detectYAsVowel(word)) {
    matches.push({ label: "y as vowel" });
  }

  return uniqueMatches(matches);
}

export function isNewDeterministicPatternMatcherEnabled(): boolean {
  return process.env.SPELLING_COACH_NEW_PATTERN_MATCHER !== "off";
}

export function getNewMatchedPatterns(targetWord: string): PatternMatch[] {
  const word = normalizeWord(targetWord);
  if (!word) {
    return [];
  }

  const merged = [...getBlendBasedMatches(word), ...getImageBasedMatches(word)];
  return uniqueMatches(merged);
}

function withMatchedPatterns(
  wordBreakdown: WordBreakdown,
  targetWord: string,
): WordBreakdown {
  if (!isNewDeterministicPatternMatcherEnabled()) {
    return {
      ...wordBreakdown,
      matchedPatterns: [],
    };
  }

  return {
    ...wordBreakdown,
    matchedPatterns: getMergedMatchedPatterns(targetWord),
  };
}

export function applyNewPatternsToPrecompute(
  targetWord: string,
  precompute: WordTeachingPrecompute,
): WordTeachingPrecompute {
  return {
    ...precompute,
    wordBreakdown: withMatchedPatterns(
      precompute.wordBreakdown as WordBreakdown,
      targetWord,
    ),
  };
}

export function applyNewPatternsToOutput(
  targetWord: string,
  output: SpellingCoachOutput,
): SpellingCoachOutput {
  return {
    ...output,
    wordBreakdown: withMatchedPatterns(
      output.wordBreakdown as WordBreakdown,
      targetWord,
    ),
  };
}
