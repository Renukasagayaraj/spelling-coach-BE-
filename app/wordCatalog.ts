import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { applyPronunciationOverride, invalidatePronunciationOverridesCache } from "./pronunciationOverrides.js";
import type {
  PatternMatch,
  WordBreakdown as RuntimeWordBreakdown,
  WordTeachingOnlyPrecompute,
} from "./schemas.js";

const StoredPatternMatchSchema = z
  .object({
    label: z.string(),
    matchedText: z.string().optional(),
    matchedParts: z.array(z.string()).optional(),
    alternateMatchedParts: z.array(z.array(z.string())).optional(),
  })
  .strict();

const StoredWordBreakdownSchema = z
  .object({
    display_chunks: z.array(z.string()),
    alternate_display_chunks: z.array(z.array(z.string())).default([]),
    chunk_reason: z.string(),
    matched_patterns: z.array(StoredPatternMatchSchema).default([]),
  })
  .strict();

const StoredPhonemeMetadataSchema = z
  .object({
    source: z.literal("g2p-en"),
    phonemes: z.array(z.string()).default([]),
    sound_aware_patterns: z.array(StoredPatternMatchSchema).default([]),
    friendly_chunks: z.array(z.string()).default([]),
    say_aloud_tip: z.string().optional(),
    pronunciation_confidence: z.enum(["high", "medium", "low"]).optional(),
  })
  .strict();

const StoredConceptTeachingSchema = z
  .object({
    summary: z.string(),
    meaning_focus: z.string(),
    origin_focus: z.string(),
    morphology_focus: z.string(),
    origin_labels: z.array(z.string()),
    morphology_labels: z.array(z.string()),
    related_forms: z.array(z.string()).default([]),
  })
  .strict();

const StoredWordTeachingSchema = z
  .object({
    concept_teaching: StoredConceptTeachingSchema,
  })
  .strict();

const StoredConceptLabelsSchema = z
  .object({
    origin_labels: z.array(z.string()),
    pattern_labels: z.array(z.string()),
    morphology_labels: z.array(z.string()),
  })
  .strict();

export const WordEntrySchema = z.object({
  word: z.string(),
  level: z.enum(["1", "2", "3", "custom", "foreign"]),
  grade_band: z.string(),
  difficulty: z.string(),
  origin: z.string(),
  definition: z.string(),
  example_sentence: z.string(),
  patterns: z.array(z.string()),
  common_mistakes: z.array(z.string()),
  coach_tip: z.string(),
  part_of_speech: z.string(),
  word_breakdown: StoredWordBreakdownSchema.optional(),
  word_teaching: StoredWordTeachingSchema.optional(),
  concept_labels: StoredConceptLabelsSchema.optional(),
  phoneme_metadata: StoredPhonemeMetadataSchema.optional(),
});

const WordCatalogSchema = z.array(WordEntrySchema);

const CustomWordListSchema = z.object({
  id: z.string(),
  name: z.string(),
  owner_user_id: z.string().default("legacy"),
  words: z.array(WordEntrySchema),
});

const CustomWordListsSchema = z.array(CustomWordListSchema);
const ForeignOriginWordListSchema = z.object({
  origin: z.string(),
  words: z.array(WordEntrySchema),
});
const ForeignOriginWordListsSchema = z.array(ForeignOriginWordListSchema);

export type WordEntry = z.infer<typeof WordEntrySchema>;
export type SupportedLevel = "1" | "2" | "3";
export type WordLevel = z.infer<typeof WordEntrySchema>["level"];
export type CustomWordList = z.infer<typeof CustomWordListSchema>;
export type ForeignOriginWordList = z.infer<typeof ForeignOriginWordListSchema>;
type CustomListRotationState = {
  order: string[];
  nextIndex: number;
  signature: string;
};

let wordCatalogCache: WordEntry[] | null = null;
let customWordListsCache: CustomWordList[] | null = null;
let foreignOriginWordListsCache: ForeignOriginWordList[] | null = null;
let customListRotationCache = new Map<string, CustomListRotationState>();
let foreignOriginRotationCache = new Map<string, CustomListRotationState>();

const DEFAULT_WORD_CATALOG_FILE = "words.generated.json";
const CUSTOM_WORD_LISTS_FILE = "words.custom.generated.json";
const FOREIGN_ORIGIN_WORD_LISTS_FILE = "words.foreign.generated.json";
const REFERENCE_DATA_DIR = join(process.cwd(), "reference_data");

function normalizeStoredWordBreakdown(
  value: z.infer<typeof StoredWordBreakdownSchema>,
  additionalPatterns: PatternMatch[] = [],
): RuntimeWordBreakdown {
  const filteredPatterns = [...value.matched_patterns, ...additionalPatterns].filter(
    (pattern) =>
      pattern.label !== "VCV structure" && pattern.label !== "VCCV structure",
  );

  return {
    displayChunks: value.display_chunks,
    alternateDisplayChunks: value.alternate_display_chunks,
    chunkReason: value.chunk_reason,
    matchedPatterns: uniquePatternMatches(filteredPatterns),
  };
}

function uniquePatternMatches(values: PatternMatch[]): PatternMatch[] {
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

function normalizeStoredWordTeaching(
  value: z.infer<typeof StoredWordTeachingSchema>,
): WordTeachingOnlyPrecompute["wordTeaching"] {
  return {
    conceptTeaching: {
      summary: value.concept_teaching.summary,
      meaningFocus: value.concept_teaching.meaning_focus,
      originFocus: value.concept_teaching.origin_focus,
      morphologyFocus: value.concept_teaching.morphology_focus,
      originLabels: value.concept_teaching.origin_labels,
      morphologyLabels: value.concept_teaching.morphology_labels,
      relatedForms: value.concept_teaching.related_forms,
    },
  };
}

function normalizeStoredConceptLabels(
  value: z.infer<typeof StoredConceptLabelsSchema>,
): WordTeachingOnlyPrecompute["conceptLabels"] {
  return {
    originLabels: value.origin_labels,
    patternLabels: value.pattern_labels,
    morphologyLabels: value.morphology_labels,
  };
}

function readWordCatalogFile(fileName: string): WordEntry[] {
  const absolutePath = join(REFERENCE_DATA_DIR, fileName);
  if (!existsSync(absolutePath)) {
    return [];
  }

  const content = readFileSync(absolutePath, "utf8");
  return WordCatalogSchema.parse(JSON.parse(content)).map(applyPronunciationOverride);
}

function readCustomWordListsFile(): CustomWordList[] {
  const absolutePath = join(REFERENCE_DATA_DIR, CUSTOM_WORD_LISTS_FILE);
  if (!existsSync(absolutePath)) {
    return [];
  }

  const content = readFileSync(absolutePath, "utf8");
  return CustomWordListsSchema.parse(JSON.parse(content)).map((list) => ({
    ...list,
    words: list.words.map(applyPronunciationOverride),
  }));
}

function readForeignOriginWordListsFile(): ForeignOriginWordList[] {
  const absolutePath = join(REFERENCE_DATA_DIR, FOREIGN_ORIGIN_WORD_LISTS_FILE);
  if (!existsSync(absolutePath)) {
    return [];
  }

  const content = readFileSync(absolutePath, "utf8");
  return ForeignOriginWordListsSchema.parse(JSON.parse(content)).map((list) => ({
    ...list,
    words: list.words.map(applyPronunciationOverride),
  }));
}

export function loadCustomWordLists(): CustomWordList[] {
  if (customWordListsCache) {
    return customWordListsCache;
  }

  customWordListsCache = readCustomWordListsFile();
  return customWordListsCache;
}

export function loadForeignOriginWordLists(): ForeignOriginWordList[] {
  if (foreignOriginWordListsCache) {
    return foreignOriginWordListsCache;
  }

  foreignOriginWordListsCache = readForeignOriginWordListsFile();
  return foreignOriginWordListsCache;
}

export function saveCustomWordLists(lists: CustomWordList[]): void {
  mkdirSync(REFERENCE_DATA_DIR, { recursive: true });
  const parsed = CustomWordListsSchema.parse(lists);
  writeFileSync(
    join(REFERENCE_DATA_DIR, CUSTOM_WORD_LISTS_FILE),
    `${JSON.stringify(parsed, null, 2)}\n`,
    "utf8",
  );
  invalidateWordCatalogCache();
}

export function saveForeignOriginWordLists(
  lists: ForeignOriginWordList[],
): void {
  mkdirSync(REFERENCE_DATA_DIR, { recursive: true });
  const parsed = ForeignOriginWordListsSchema.parse(lists);
  writeFileSync(
    join(REFERENCE_DATA_DIR, FOREIGN_ORIGIN_WORD_LISTS_FILE),
    `${JSON.stringify(parsed, null, 2)}\n`,
    "utf8",
  );
  invalidateWordCatalogCache();
}

export function invalidateWordCatalogCache(): void {
  wordCatalogCache = null;
  customWordListsCache = null;
  foreignOriginWordListsCache = null;
  customListRotationCache = new Map();
  foreignOriginRotationCache = new Map();
  invalidatePronunciationOverridesCache();
}

function shuffle<T>(values: T[]): T[] {
  const shuffled = [...values];

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    const current = shuffled[index];
    shuffled[index] = shuffled[swapIndex]!;
    shuffled[swapIndex] = current!;
  }

  return shuffled;
}

function getCustomListSignature(words: WordEntry[]): string {
  return words.map((entry) => entry.word.toLowerCase()).join("|");
}

function pickNextCustomListWord(
  listId: string,
  words: WordEntry[],
  excludedWords: Set<string>,
): WordEntry {
  if (words.length === 0) {
    throw new Error(`No words available for custom list ${listId}.`);
  }

  const signature = getCustomListSignature(words);
  const existing = customListRotationCache.get(listId);
  const activeState =
    existing && existing.signature === signature
      ? existing
      : {
        order: shuffle(words.map((entry) => entry.word.toLowerCase())),
        nextIndex: 0,
        signature,
      };

  customListRotationCache.set(listId, activeState);

  for (let attempts = 0; attempts < activeState.order.length; attempts += 1) {
    const wordKey = activeState.order[activeState.nextIndex];
    activeState.nextIndex = (activeState.nextIndex + 1) % activeState.order.length;
    if (!wordKey || excludedWords.has(wordKey)) {
      continue;
    }

    const match = words.find((entry) => entry.word.toLowerCase() === wordKey);
    if (match) {
      return match;
    }
  }

  const fallback = words.find(
    (entry) => !excludedWords.has(entry.word.toLowerCase()),
  );
  return fallback ?? words[0]!;
}

function pickNextForeignOriginWord(
  origin: string,
  words: WordEntry[],
  excludedWords: Set<string>,
): WordEntry {
  if (words.length === 0) {
    throw new Error(`No words available for foreign origin ${origin}.`);
  }

  const signature = getCustomListSignature(words);
  const key = origin.trim().toLowerCase();
  const existing = foreignOriginRotationCache.get(key);
  const activeState =
    existing && existing.signature === signature
      ? existing
      : {
        order: shuffle(words.map((entry) => entry.word.toLowerCase())),
        nextIndex: 0,
        signature,
      };

  foreignOriginRotationCache.set(key, activeState);

  for (let attempts = 0; attempts < activeState.order.length; attempts += 1) {
    const wordKey = activeState.order[activeState.nextIndex];
    activeState.nextIndex = (activeState.nextIndex + 1) % activeState.order.length;
    if (!wordKey || excludedWords.has(wordKey)) {
      continue;
    }

    const match = words.find((entry) => entry.word.toLowerCase() === wordKey);
    if (match) {
      return match;
    }
  }

  const fallback = words.find(
    (entry) => !excludedWords.has(entry.word.toLowerCase()),
  );
  return fallback ?? words[0]!;
}

export function loadWordCatalog(): WordEntry[] {
  if (wordCatalogCache) {
    return wordCatalogCache;
  }

  const baseCatalog = readWordCatalogFile(DEFAULT_WORD_CATALOG_FILE);
  const mergedCatalog = new Map<string, WordEntry>();

  for (const entry of baseCatalog) {
    mergedCatalog.set(entry.word.toLowerCase(), entry);
  }

  for (const list of loadCustomWordLists()) {
    for (const entry of list.words) {
      mergedCatalog.set(entry.word.toLowerCase(), entry);
    }
  }

  for (const list of loadForeignOriginWordLists()) {
    for (const entry of list.words) {
      mergedCatalog.set(entry.word.toLowerCase(), entry);
    }
  }

  wordCatalogCache = Array.from(mergedCatalog.values());
  return wordCatalogCache;
}

export function getStoredWordBreakdown(
  targetWord: string,
): RuntimeWordBreakdown | null {
  const word = getWordByText(targetWord);
  if (!word?.word_breakdown) {
    return null;
  }

  return normalizeStoredWordBreakdown(
    word.word_breakdown,
    word.phoneme_metadata?.sound_aware_patterns ?? [],
  );
}

export function getStoredWordTeachingOnlyPrecompute(
  targetWord: string,
): WordTeachingOnlyPrecompute | null {
  const word = getWordByText(targetWord);
  if (!word?.word_teaching || !word.concept_labels) {
    return null;
  }

  return {
    wordTeaching: normalizeStoredWordTeaching(word.word_teaching),
    conceptLabels: normalizeStoredConceptLabels(word.concept_labels),
  };
}

export function getStoredSoundAwarePatterns(targetWord: string): PatternMatch[] {
  return getWordByText(targetWord)?.phoneme_metadata?.sound_aware_patterns ?? [];
}

export function listCustomWordLists(): Array<{
  id: string;
  name: string;
  wordCount: number;
}> {
  return loadCustomWordLists().map((list) => ({
    id: list.id,
    name: list.name,
    wordCount: list.words.length,
  }));
}

export function listCustomWordListsForUser(userId: string): Array<{
  id: string;
  name: string;
  wordCount: number;
}> {
  const normalizedUserId = userId.trim();
  return loadCustomWordLists()
    .filter((list) => list.owner_user_id === normalizedUserId)
    .map((list) => ({
      id: list.id,
      name: list.name,
      wordCount: list.words.length,
    }));
}

export function listForeignOrigins(): Array<{
  origin: string;
  wordCount: number;
}> {
  return loadForeignOriginWordLists().map((list) => ({
    origin: list.origin,
    wordCount: list.words.length,
  }));
}

export function getCustomWordListById(
  listId: string,
  ownerUserId?: string,
): CustomWordList | undefined {
  const normalizedOwner = ownerUserId?.trim();
  return loadCustomWordLists().find((list) => {
    if (list.id !== listId) {
      return false;
    }

    if (!normalizedOwner) {
      return true;
    }

    return list.owner_user_id === normalizedOwner;
  });
}

export function getForeignOriginWordListByOrigin(
  origin: string,
): ForeignOriginWordList | undefined {
  const normalizedOrigin = origin.trim().toLowerCase();
  return loadForeignOriginWordLists().find(
    (list) => list.origin.trim().toLowerCase() === normalizedOrigin,
  );
}

export function createCustomWordList(
  name: string,
  words: WordEntry[],
  ownerUserId = "legacy",
): CustomWordList {
  return {
    id: randomUUID(),
    name,
    owner_user_id: ownerUserId,
    words,
  };
}

export function createForeignOriginWordList(
  origin: string,
  words: WordEntry[],
): ForeignOriginWordList {
  return {
    origin,
    words,
  };
}

export function getWordsByLevel(level: SupportedLevel): WordEntry[] {
  return readWordCatalogFile(DEFAULT_WORD_CATALOG_FILE).filter(
    (entry) => entry.level === level,
  );
}

export function getBaseWordByText(word: string): WordEntry | undefined {
  const normalizedWord = word.toLowerCase();
  return readWordCatalogFile(DEFAULT_WORD_CATALOG_FILE).find(
    (entry) => entry.word.toLowerCase() === normalizedWord,
  );
}

export function getWordByText(word: string): WordEntry | undefined {
  const normalizedWord = word.toLowerCase();
  return loadWordCatalog().find(
    (entry) => entry.word.toLowerCase() === normalizedWord,
  );
}

export function pickNextWord(
  level: SupportedLevel | undefined,
  excludedWords: string[] = [],
  customListId?: string,
  foreignOrigin?: string,
  ownerUserId?: string,
  customWordsFallback?: WordEntry[],
): WordEntry {
  const excluded = new Set(excludedWords.map((word) => word.toLowerCase()));
  if (foreignOrigin) {
    const foreignWords =
      getForeignOriginWordListByOrigin(foreignOrigin)?.words ?? [];
    return pickNextForeignOriginWord(foreignOrigin, foreignWords, excluded);
  }

  const customListWords = customWordsFallback ?? (customListId
    ? getCustomWordListById(customListId, ownerUserId)?.words ?? []
    : []);
  if (customListId) {
    return pickNextCustomListWord(customListId, customListWords, excluded);
  }

  const poolSource = level ? getWordsByLevel(level) : [];
  const candidates = poolSource.filter(
    (entry) => !excluded.has(entry.word.toLowerCase()),
  );

  const pool = candidates.length > 0 ? candidates : poolSource;
  if (pool.length === 0) {
    throw new Error(
      customListId
        ? `No words available for custom list ${customListId}.`
        : `No words available for level ${level}.`,
    );
  }

  const index = Math.floor(Math.random() * pool.length);
  return pool[index];
}
