import { z } from "zod";
import {
  type SpellingCoachInput,
  type SpellingCoachOutput,
} from "./schemas.js";
import { getReferenceHints } from "./referenceData.js";
import {
  getStoredWordBreakdown,
  getWordByText,
  type SupportedLevel,
  type WordEntry,
} from "./wordCatalog.js";

export const CoachingRequestSchema = z
  .object({
    targetWord: z.string(),
    childAttempt: z.string(),
    childProfile: z.object({
      childId: z.string(),
      age: z.number().int().nonnegative(),
      grade: z.string(),
      spellingLevel: z.string(),
    }),
    supportsUsed: z
      .object({
        definitionViewed: z.boolean().optional(),
        exampleViewed: z.boolean().optional(),
        originViewed: z.boolean().optional(),
      })
      .optional(),
    sessionContext: z
      .object({
        mode: z.string().default("practice"),
        previousAttemptsOnThisWord: z.number().int().nonnegative().default(0),
        previousMissPatterns: z.array(z.string()).default([]),
        recentlyPracticedWords: z.array(z.string()).default([]),
      })
      .default({
        mode: "practice",
        previousAttemptsOnThisWord: 0,
        previousMissPatterns: [],
        recentlyPracticedWords: [],
      }),
  })
  .strict();

export type CoachingRequest = z.infer<typeof CoachingRequestSchema>;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function maskWordInExampleSentence(
  exampleSentence: string,
  targetWord: string,
): string {
  if (!exampleSentence || !targetWord) {
    return exampleSentence;
  }

  const pattern = new RegExp(escapeRegExp(targetWord), "gi");
  return exampleSentence.replace(pattern, "*****");
}

export function maskWordInPublicText(
  text: string,
  targetWord: string,
): string {
  if (!text || !targetWord) {
    return text;
  }

  const pattern = new RegExp(escapeRegExp(targetWord), "gi");
  return text.replace(pattern, "*****");
}

export function buildWordResponse(word: WordEntry) {
  return {
    word: word.word,
    level: word.level,
    gradeBand: word.grade_band,
    difficulty: word.difficulty,
    origin: word.origin,
    definition: maskWordInPublicText(word.definition, word.word),
    exampleSentence: maskWordInPublicText(
      word.example_sentence,
      word.word,
    ),
    partOfSpeech: word.part_of_speech,
    pronunciation: "",
    patterns: word.patterns,
  };
}

function levenshteinMatrix(left: string, right: string): number[][] {
  const rows = left.length + 1;
  const cols = right.length + 1;
  const matrix = Array.from({ length: rows }, () => Array<number>(cols).fill(0));

  for (let row = 0; row < rows; row += 1) {
    matrix[row][0] = row;
  }

  for (let col = 0; col < cols; col += 1) {
    matrix[0][col] = col;
  }

  for (let row = 1; row < rows; row += 1) {
    for (let col = 1; col < cols; col += 1) {
      const cost = left[row - 1] === right[col - 1] ? 0 : 1;
      matrix[row][col] = Math.min(
        matrix[row - 1][col] + 1,
        matrix[row][col - 1] + 1,
        matrix[row - 1][col - 1] + cost,
      );
    }
  }

  return matrix;
}

function diffWords(targetWord: string, childAttempt: string) {
  const target = targetWord.toLowerCase();
  const attempt = childAttempt.toLowerCase();
  const matrix = levenshteinMatrix(target, attempt);
  const missingLetters: string[] = [];
  const extraLetters: string[] = [];
  const substitutedLetters: string[] = [];
  const transposedLetters: string[] = [];

  let row = target.length;
  let col = attempt.length;

  while (row > 0 || col > 0) {
    if (
      row > 0 &&
      col > 0 &&
      target[row - 1] === attempt[col - 1]
    ) {
      row -= 1;
      col -= 1;
      continue;
    }

    if (
      row > 1 &&
      col > 1 &&
      target[row - 1] === attempt[col - 2] &&
      target[row - 2] === attempt[col - 1]
    ) {
      transposedLetters.push(`${attempt[col - 2]}${attempt[col - 1]}`);
      row -= 2;
      col -= 2;
      continue;
    }

    const current = matrix[row][col];
    if (
      row > 0 &&
      col > 0 &&
      matrix[row - 1][col - 1] + 1 === current
    ) {
      substitutedLetters.push(`${attempt[col - 1]} for ${target[row - 1]}`);
      row -= 1;
      col -= 1;
      continue;
    }

    if (row > 0 && matrix[row - 1][col] + 1 === current) {
      missingLetters.push(target[row - 1]);
      row -= 1;
      continue;
    }

    if (col > 0 && matrix[row][col - 1] + 1 === current) {
      extraLetters.push(attempt[col - 1]);
      col -= 1;
      continue;
    }

    break;
  }

  return {
    editDistance: matrix[target.length][attempt.length],
    missingLetters: missingLetters.reverse(),
    extraLetters: extraLetters.reverse(),
    substitutedLetters: substitutedLetters.reverse(),
    transposedLetters: transposedLetters.reverse(),
  };
}

function detectLikelyChunks(word: WordEntry): string[] {
  const storedBreakdown = getStoredWordBreakdown(word.word);
  if (storedBreakdown?.displayChunks.length) {
    return storedBreakdown.displayChunks;
  }

  const hints = getReferenceHints({
    targetWord: word.word,
    childAttempt: word.word,
    childProfile: {
      childId: "system",
      age: 0,
      grade: "system",
      spellingLevel: word.level,
    },
    wordMetadata: {
      definition: word.definition,
      origin: word.origin,
      partOfSpeech: word.part_of_speech,
      exampleSentence: word.example_sentence,
    },
    missSignals: {
      isCorrect: true,
      nearMiss: false,
      missingLetters: [],
      extraLetters: [],
      substitutedLetters: [],
      transposedLetters: [],
      repeatedLetterIssue: false,
      likelyRushed: false,
      editDistance: 0,
    },
    structuralHints: {
      syllables: [],
      likelyChunks: [],
      detectedPatterns: [],
    },
    sessionContext: {
      mode: "practice",
      previousAttemptsOnThisWord: 0,
      previousMissPatterns: [],
      recentlyPracticedWords: [],
    },
  });

  const prefix = hints.find((hint) => hint.role === "prefix")?.matchedForm ?? "";
  const suffix =
    hints.find((hint) => hint.role === "suffix_family")?.matchedForm ?? "";
  const chunks: string[] = [];

  if (prefix && word.word.toLowerCase().startsWith(prefix)) {
    chunks.push(word.word.slice(0, prefix.length));
  }

  const remainingAfterPrefix = chunks.length > 0 ? word.word.slice(chunks[0].length) : word.word;
  if (
    suffix &&
    remainingAfterPrefix.toLowerCase().endsWith(suffix) &&
    remainingAfterPrefix.length > suffix.length
  ) {
    const middle = remainingAfterPrefix.slice(
      0,
      remainingAfterPrefix.length - suffix.length,
    );
    if (middle) {
      chunks.push(middle);
    }
    chunks.push(
      remainingAfterPrefix.slice(remainingAfterPrefix.length - suffix.length),
    );
  } else if (chunks.length === 0 && word.patterns.length > 0) {
    chunks.push(word.patterns[0], word.word.slice(word.patterns[0].length));
  } else if (chunks.length > 0 && remainingAfterPrefix) {
    chunks.push(remainingAfterPrefix);
  }

  return chunks.filter(Boolean);
}

function detectLikelyPrefix(word: WordEntry): string | undefined {
  return getReferenceHints({
    targetWord: word.word,
    childAttempt: word.word,
    childProfile: {
      childId: "system",
      age: 0,
      grade: "system",
      spellingLevel: "system",
    },
    wordMetadata: {
      definition: word.definition,
      origin: word.origin,
      partOfSpeech: word.part_of_speech,
      exampleSentence: word.example_sentence,
    },
    missSignals: {
      isCorrect: true,
      nearMiss: false,
      missingLetters: [],
      extraLetters: [],
      substitutedLetters: [],
      transposedLetters: [],
      repeatedLetterIssue: false,
      likelyRushed: false,
      editDistance: 0,
    },
    structuralHints: {
      syllables: [],
      likelyChunks: [],
      detectedPatterns: [],
    },
    sessionContext: {
      mode: "practice",
      previousAttemptsOnThisWord: 0,
      previousMissPatterns: [],
      recentlyPracticedWords: [],
    },
  }).find((hint) => hint.role === "prefix")?.matchedForm;
}

function detectLikelySuffix(word: WordEntry): string | undefined {
  return getReferenceHints({
    targetWord: word.word,
    childAttempt: word.word,
    childProfile: {
      childId: "system",
      age: 0,
      grade: "system",
      spellingLevel: "system",
    },
    wordMetadata: {
      definition: word.definition,
      origin: word.origin,
      partOfSpeech: word.part_of_speech,
      exampleSentence: word.example_sentence,
    },
    missSignals: {
      isCorrect: true,
      nearMiss: false,
      missingLetters: [],
      extraLetters: [],
      substitutedLetters: [],
      transposedLetters: [],
      repeatedLetterIssue: false,
      likelyRushed: false,
      editDistance: 0,
    },
    structuralHints: {
      syllables: [],
      likelyChunks: [],
      detectedPatterns: [],
    },
    sessionContext: {
      mode: "practice",
      previousAttemptsOnThisWord: 0,
      previousMissPatterns: [],
      recentlyPracticedWords: [],
    },
  }).find((hint) => hint.role === "suffix_family")?.matchedForm;
}

export function buildSpellingCoachInput(
  request: CoachingRequest,
): SpellingCoachInput {
  const parsedRequest = CoachingRequestSchema.parse(request);
  const word = getWordByText(parsedRequest.targetWord);

  if (!word) {
    throw new Error(`Unknown target word: ${parsedRequest.targetWord}`);
  }

  const diff = diffWords(word.word, parsedRequest.childAttempt);
  const isCorrect =
    word.word.toLowerCase() === parsedRequest.childAttempt.toLowerCase();
  const storedBreakdown = getStoredWordBreakdown(word.word);

  return {
    targetWord: word.word,
    childAttempt: parsedRequest.childAttempt,
    childProfile: parsedRequest.childProfile,
    wordMetadata: {
      definition: word.definition,
      origin: word.origin,
      partOfSpeech: word.part_of_speech,
      exampleSentence: word.example_sentence,
    },
    missSignals: {
      isCorrect,
      nearMiss: !isCorrect && diff.editDistance <= 2,
      missingLetters: diff.missingLetters,
      extraLetters: diff.extraLetters,
      substitutedLetters: diff.substitutedLetters,
      transposedLetters: diff.transposedLetters,
      repeatedLetterIssue: /(.)\1/.test(parsedRequest.childAttempt),
      likelyRushed:
        !isCorrect &&
        diff.editDistance <= 2 &&
        (diff.missingLetters.length > 0 || diff.transposedLetters.length > 0),
      editDistance: diff.editDistance,
    },
    structuralHints: {
      syllables: [],
      likelyChunks: storedBreakdown?.displayChunks ?? detectLikelyChunks(word),
      detectedPatterns: [...word.patterns],
      likelyPrefix: detectLikelyPrefix(word),
      likelySuffix: detectLikelySuffix(word),
    },
    sessionContext: parsedRequest.sessionContext,
  };
}

export function buildWordPrecomputeInput(targetWord: string): SpellingCoachInput {
  const word = getWordByText(targetWord);

  if (!word) {
    throw new Error(`Unknown target word: ${targetWord}`);
  }

  const storedBreakdown = getStoredWordBreakdown(word.word);

  return {
    targetWord: word.word,
    childAttempt: word.word,
    childProfile: {
      childId: "system",
      age: 0,
      grade: "system",
      spellingLevel: "system",
    },
    wordMetadata: {
      definition: word.definition,
      origin: word.origin,
      partOfSpeech: word.part_of_speech,
      exampleSentence: word.example_sentence,
    },
    missSignals: {
      isCorrect: true,
      nearMiss: false,
      missingLetters: [],
      extraLetters: [],
      substitutedLetters: [],
      transposedLetters: [],
      repeatedLetterIssue: false,
      likelyRushed: false,
      editDistance: 0,
    },
    structuralHints: {
      syllables: [],
      likelyChunks: storedBreakdown?.displayChunks ?? detectLikelyChunks(word),
      detectedPatterns: [...word.patterns],
      likelyPrefix: detectLikelyPrefix(word),
      likelySuffix: detectLikelySuffix(word),
    },
    sessionContext: {
      mode: "practice",
      previousAttemptsOnThisWord: 0,
      previousMissPatterns: [],
      recentlyPracticedWords: [],
    },
  };
}

export const LevelQuerySchema = z.object({
  level: z.preprocess(
    (value) => {
      if (value === null || value === undefined) {
        return undefined;
      }

      const normalized = String(value).trim();
      if (!normalized || normalized === "NaN" || normalized === "undefined" || normalized === "null") {
        return undefined;
      }

      return normalized;
    },
    z.enum(["1", "2", "3"]).optional(),
  ),
  customListId: z.string().optional(),
  foreignOrigin: z.preprocess(
    (value) => {
      if (value === null || value === undefined) {
        return undefined;
      }

      const normalized = String(value).trim();
      if (!normalized || normalized === "undefined" || normalized === "null") {
        return undefined;
      }

      return normalized;
    },
    z.string().optional(),
  ),
  exclude: z
    .string()
    .optional()
    .transform((value) =>
      value ? value.split(",").map((item) => item.trim()).filter(Boolean) : [],
    ),
}).superRefine((value, context) => {
  if (!value.level && !value.customListId && !value.foreignOrigin) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Either level, customListId, or foreignOrigin is required.",
      path: ["level"],
    });
  }
});

export type LevelQuery = {
  level?: SupportedLevel;
  customListId?: string;
  foreignOrigin?: string;
  exclude?: string[];
};
