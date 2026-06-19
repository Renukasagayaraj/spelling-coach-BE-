import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildWordPrecomputeInput } from "../app/inputBuilder.js";
import {
  buildDirectRuntimeSystemPrompt,
  createDirectSpellingCoachModel,
} from "../app/directModel.js";
import { getConfiguredModelName } from "../app/modelConfig.js";
import {
  buildWordTeachingOnlyPrecomputePrompt,
  buildWordTeachingPrecomputePrompt,
} from "../app/prompt.js";
import {
  parseWordTeachingOnlyPrecompute,
  parseWordTeachingPrecompute,
  type WordTeachingOnlyPrecompute,
  type WordTeachingPrecompute,
} from "../app/schemas.js";

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
  word_teaching?: {
    concept_teaching: {
      summary: string;
      meaning_focus: string;
      origin_focus: string;
      morphology_focus: string;
      origin_labels: string[];
      morphology_labels: string[];
      related_forms?: string[];
    };
  };
  concept_labels?: {
    origin_labels: string[];
    pattern_labels: string[];
    morphology_labels: string[];
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

function toStoredConceptTeaching(
  precompute: WordTeachingOnlyPrecompute | WordTeachingPrecompute,
): Pick<WordEntry, "word_teaching" | "concept_labels"> {
  return {
    word_teaching: {
      concept_teaching: {
        summary: precompute.wordTeaching.conceptTeaching.summary,
        meaning_focus: precompute.wordTeaching.conceptTeaching.meaningFocus,
        origin_focus: precompute.wordTeaching.conceptTeaching.originFocus,
        morphology_focus:
          precompute.wordTeaching.conceptTeaching.morphologyFocus,
        origin_labels: precompute.wordTeaching.conceptTeaching.originLabels,
        morphology_labels:
          precompute.wordTeaching.conceptTeaching.morphologyLabels,
        related_forms: precompute.wordTeaching.conceptTeaching.relatedForms,
      },
    },
    concept_labels: {
      origin_labels: precompute.conceptLabels.originLabels,
      pattern_labels: precompute.conceptLabels.patternLabels,
      morphology_labels: precompute.conceptLabels.morphologyLabels,
    },
  };
}

async function precomputeConceptTeaching(
  word: WordEntry,
): Promise<Pick<WordEntry, "word_teaching" | "concept_labels">> {
  const model = await createDirectSpellingCoachModel({
    model: getConfiguredModelName(),
  });
  const input = buildWordPrecomputeInput(word.word);
  const hasStoredBreakdown = Boolean(word.word_breakdown);
  const prompt = hasStoredBreakdown
    ? buildWordTeachingOnlyPrecomputePrompt(input)
    : buildWordTeachingPrecomputePrompt(input);
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

  const parsed = hasStoredBreakdown
    ? parseWordTeachingOnlyPrecompute(
        parseStrictJson(extractAssistantPayload(response)),
      )
    : parseWordTeachingPrecompute(parseStrictJson(extractAssistantPayload(response)));

  return toStoredConceptTeaching(parsed);
}

function hasStoredConceptTeaching(word: WordEntry): boolean {
  return Boolean(word.word_teaching && word.concept_labels);
}

async function enrichCatalogWords(
  words: WordEntry[],
  overwrite: boolean,
): Promise<WordEntry[]> {
  const enriched: WordEntry[] = [];

  for (const word of words) {
    if (hasStoredConceptTeaching(word) && !overwrite) {
      enriched.push(word);
      continue;
    }

    // eslint-disable-next-line no-console
    console.log(`Precomputing concept teaching for ${word.word}`);
    const stored = await precomputeConceptTeaching(word);
    enriched.push({
      ...word,
      ...stored,
    });
  }

  return enriched;
}

async function main(): Promise<void> {
  const overwrite = process.argv.includes("--overwrite");
  const requestedFileName = getRequestedFileName();

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
          words: await enrichCatalogWords(list.words, overwrite),
        });
      }

      writeFileSync(absolutePath, `${JSON.stringify(enrichedLists, null, 2)}\n`, "utf8");
      continue;
    }

    if (descriptor.kind === "custom") {
      const lists = parsed as Array<{
        id: string;
        name: string;
        owner_user_id: string;
        words: WordEntry[];
      }>;
      const enrichedLists = [];

      for (const list of lists) {
        enrichedLists.push({
          ...list,
          words: await enrichCatalogWords(list.words, overwrite),
        });
      }

      writeFileSync(absolutePath, `${JSON.stringify(enrichedLists, null, 2)}\n`, "utf8");
      continue;
    }

    const words = parsed as WordEntry[];
    const enrichedWords = await enrichCatalogWords(words, overwrite);
    writeFileSync(absolutePath, `${JSON.stringify(enrichedWords, null, 2)}\n`, "utf8");
  }
}

void main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exitCode = 1;
});
