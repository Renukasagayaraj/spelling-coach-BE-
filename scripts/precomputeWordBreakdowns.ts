import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildWordPrecomputeInput } from "../app/inputBuilder.js";
import { normalizeWordTeachingPrecomputeChunkReason } from "../app/chunkReason.js";
import {
  buildDirectRuntimeSystemPrompt,
  createDirectSpellingCoachModel,
} from "../app/directModel.js";
import { getConfiguredModelName } from "../app/modelConfig.js";
import { getNewMatchedPatterns } from "../app/newPatternMatcher.js";
import { buildWordBreakdownPrecomputePrompt } from "../app/prompt.js";
import { parseWordBreakdown, type ParsedWordBreakdown } from "../app/schemas.js";

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
  word_breakdown?: {
    display_chunks: string[];
    alternate_display_chunks: string[][];
    chunk_reason: string;
    matched_patterns: ParsedWordBreakdown["matchedPatterns"];
  };
};

type ForeignOriginList = {
  origin: string;
  words: WordEntry[];
};

const REFERENCE_DATA_DIR = join(process.cwd(), "reference_data");
const WORD_FILES = [
  { fileName: "words.generated.json", kind: "catalog" as const },
  { fileName: "words.custom.generated.json", kind: "custom" as const },
  { fileName: "words.foreign.generated.json", kind: "foreign" as const },
];
const SUPPORTED_BUCKETS = ["legacy-opaque"] as const;
type RefreshBucket = (typeof SUPPORTED_BUCKETS)[number];

function getRequestedFileName(): string | null {
  const fileFlagIndex = process.argv.indexOf("--file");
  if (fileFlagIndex === -1) {
    return null;
  }

  const fileName = process.argv[fileFlagIndex + 1]?.trim();
  if (!fileName) {
    throw new Error("Expected a file name after --file.");
  }

  if (!WORD_FILES.some((descriptor) => descriptor.fileName === fileName)) {
    throw new Error(
      `Unsupported --file target: ${fileName}. Expected one of: ${WORD_FILES.map((descriptor) => descriptor.fileName).join(", ")}`,
    );
  }

  return fileName;
}

function getRequestedBucket(): RefreshBucket | null {
  const bucketFlagIndex = process.argv.indexOf("--bucket");
  if (bucketFlagIndex === -1) {
    return null;
  }

  const bucket = process.argv[bucketFlagIndex + 1]?.trim() as RefreshBucket | undefined;
  if (!bucket) {
    throw new Error("Expected a bucket name after --bucket.");
  }

  if (!SUPPORTED_BUCKETS.includes(bucket)) {
    throw new Error(
      `Unsupported --bucket target: ${bucket}. Expected one of: ${SUPPORTED_BUCKETS.join(", ")}`,
    );
  }

  return bucket;
}

function extractAssistantPayload(result: unknown): string {
  if (typeof result === "string") {
    return result.trim();
  }

  if (result && typeof result === "object") {
    const maybeContent = (result as { content?: unknown }).content;
    if (typeof maybeContent === "string") {
      return maybeContent.trim();
    }

    if (Array.isArray(maybeContent)) {
      return maybeContent
        .map((part) => {
          if (typeof part === "string") {
            return part;
          }

          if (
            part &&
            typeof part === "object" &&
            "type" in part &&
            (part as { type?: unknown }).type === "text" &&
            "text" in part
          ) {
            return String((part as { text: unknown }).text);
          }

          return "";
        })
        .join("")
        .trim();
    }
  }

  throw new Error("Model response did not contain assistant text.");
}

function parseStrictJson(payload: string): unknown {
  const trimmed = payload.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    throw new Error("Model output must be a single JSON object.");
  }

  return JSON.parse(trimmed);
}

function toStoredWordBreakdown(
  word: string,
  breakdown: ParsedWordBreakdown,
): WordEntry["word_breakdown"] {
  const normalized = normalizeWordTeachingPrecomputeChunkReason({
    wordTeaching: {
      formTeaching: {
        summary: "",
        patterns: [],
        chunks: [],
        chunkReason: "",
        sayAloudFocus: "",
      },
      conceptTeaching: {
        summary: "",
        meaningFocus: "",
        originFocus: "",
        morphologyFocus: "",
        originLabels: [],
        morphologyLabels: [],
      },
    },
    wordBreakdown: {
      ...breakdown,
      matchedPatterns: [],
    },
    conceptLabels: {
      originLabels: [],
      patternLabels: [],
      morphologyLabels: [],
    },
  }).wordBreakdown;

  return {
    display_chunks: normalized.displayChunks,
    alternate_display_chunks: normalized.alternateDisplayChunks.slice(0, 2),
    chunk_reason: normalized.chunkReason,
    matched_patterns: getNewMatchedPatterns(word),
  };
}

function hasLegacyStructureLabels(word: WordEntry): boolean {
  const matches = word.word_breakdown?.matched_patterns ?? [];
  return matches.some(
    (match) =>
      match.label === "VCV structure" || match.label === "VCCV structure",
  );
}

function isLegacyOpaqueBreakdownCandidate(word: WordEntry): boolean {
  if (word.level !== "3") {
    return false;
  }

  const breakdown = word.word_breakdown;
  if (!breakdown) {
    return false;
  }

  if (!hasLegacyStructureLabels(word)) {
    return false;
  }

  if (breakdown.alternate_display_chunks.length > 0) {
    return false;
  }

  const longestChunkLength = Math.max(
    0,
    ...breakdown.display_chunks.map((chunk) => chunk.length),
  );

  return breakdown.display_chunks.length <= 2 && longestChunkLength >= 6;
}

function shouldRefreshWord(
  word: WordEntry,
  overwrite: boolean,
  bucket: RefreshBucket | null,
): boolean {
  if (bucket === "legacy-opaque") {
    return isLegacyOpaqueBreakdownCandidate(word);
  }

  return overwrite || !word.word_breakdown;
}

async function precomputeWordBreakdown(word: WordEntry): Promise<WordEntry["word_breakdown"]> {
  const model = await createDirectSpellingCoachModel({
    model: getConfiguredModelName(),
  });
  const input = buildWordPrecomputeInput(word.word);
  const prompt = buildWordBreakdownPrecomputePrompt(input);
  const response = await model.invoke([
    {
      role: "system",
      content: buildDirectRuntimeSystemPrompt(),
    },
    {
      role: "user",
      content: prompt,
    },
  ]);

  const parsed = parseWordBreakdown(parseStrictJson(extractAssistantPayload(response)));
  return toStoredWordBreakdown(word.word, parsed);
}

async function enrichCatalogWords(
  words: WordEntry[],
  overwrite: boolean,
  bucket: RefreshBucket | null,
): Promise<WordEntry[]> {
  const enriched: WordEntry[] = [];

  for (const word of words) {
    if (!shouldRefreshWord(word, overwrite, bucket)) {
      enriched.push(word);
      continue;
    }

    // eslint-disable-next-line no-console
    console.log(`Precomputing word breakdown for ${word.word}`);
    enriched.push({
      ...word,
      word_breakdown: await precomputeWordBreakdown(word),
    });
  }

  return enriched;
}

async function main(): Promise<void> {
  const overwrite = process.argv.includes("--overwrite");
  const requestedFileName = getRequestedFileName();
  const requestedBucket = getRequestedBucket();

  for (const descriptor of WORD_FILES) {
    if (requestedFileName && descriptor.fileName !== requestedFileName) {
      continue;
    }

    const absolutePath = join(REFERENCE_DATA_DIR, descriptor.fileName);
    const content = readFileSync(absolutePath, "utf8");
    const parsed = JSON.parse(content);

    if (descriptor.kind === "foreign") {
      const lists = parsed as ForeignOriginList[];
      const enrichedLists: ForeignOriginList[] = [];

      for (const list of lists) {
        enrichedLists.push({
          ...list,
          words: await enrichCatalogWords(list.words, overwrite, requestedBucket),
        });
      }

      writeFileSync(absolutePath, `${JSON.stringify(enrichedLists, null, 2)}\n`, "utf8");
      continue;
    }

    if (descriptor.kind === "custom") {
      const lists = parsed as Array<{ id: string; name: string; owner_user_id: string; words: WordEntry[] }>;
      const enrichedLists = [];

      for (const list of lists) {
        enrichedLists.push({
          ...list,
          words: await enrichCatalogWords(list.words, overwrite, requestedBucket),
        });
      }

      writeFileSync(absolutePath, `${JSON.stringify(enrichedLists, null, 2)}\n`, "utf8");
      continue;
    }

    const words = parsed as WordEntry[];
    const enrichedWords = await enrichCatalogWords(
      words,
      overwrite,
      requestedBucket,
    );
    writeFileSync(absolutePath, `${JSON.stringify(enrichedWords, null, 2)}\n`, "utf8");
  }
}

void main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exitCode = 1;
});
