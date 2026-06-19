import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildWordPrecomputeInput } from "../app/inputBuilder.js";
import {
  buildDirectRuntimeSystemPrompt,
  createDirectSpellingCoachModel,
  type DirectModelLike,
} from "../app/directModel.js";
import { getConfiguredModelName } from "../app/modelConfig.js";
import { buildRelatedFormsOnlyPrecomputePrompt } from "../app/prompt.js";
import {
  parseRelatedFormsOnlyPrecompute,
  type RelatedFormsOnlyPrecompute,
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
};

type ForeignOriginList = {
  origin: string;
  words: WordEntry[];
};

const REFERENCE_DATA_DIR = join(process.cwd(), "reference_data");
const WORD_FILES = [
  { fileName: "words.generated.json", kind: "catalog" as const },
  { fileName: "words.foreign.generated.json", kind: "foreign" as const },
];
const MAX_ATTEMPTS_PER_WORD = 3;
const CHECKPOINT_EVERY = 10;

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

function shouldProcess(word: WordEntry, overwrite: boolean): boolean {
  if (
    word.level !== "2" &&
    word.level !== "3" &&
    word.level !== "foreign"
  ) {
    return false;
  }

  if (!word.word_teaching?.concept_teaching) {
    return false;
  }

  if (overwrite) {
    return true;
  }

  return !Array.isArray(word.word_teaching.concept_teaching.related_forms);
}

function writeJsonFile(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function isRecoverableModelError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message.includes("Model output must be a single JSON object.") ||
    error.message.includes("Unexpected token") ||
    error.message.includes("JSON")
  );
}

function isRecoverableConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const stackText = error.stack ?? "";
  return (
    error.message.includes("Request timed out") ||
    error.message.includes("Connection error") ||
    error.message.includes("fetch failed") ||
    stackText.includes("ENOTFOUND") ||
    stackText.includes("ECONNRESET") ||
    stackText.includes("ETIMEDOUT")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildRetryPrompt(basePrompt: string, attempt: number): string {
  if (attempt <= 1) {
    return basePrompt;
  }

  return [
    basePrompt,
    "IMPORTANT: Return exactly one JSON object.",
    "Do not include Markdown fences.",
    "Do not include any explanation before or after the JSON.",
  ].join("\n\n");
}

async function precomputeRelatedForms(
  model: DirectModelLike,
  word: WordEntry,
): Promise<RelatedFormsOnlyPrecompute> {
  const input = buildWordPrecomputeInput(word.word);
  const basePrompt = buildRelatedFormsOnlyPrecomputePrompt(input);
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_WORD; attempt += 1) {
    try {
      const response = await model.invoke([
        {
          role: "system",
          content: buildDirectRuntimeSystemPrompt(),
        },
        {
          role: "user",
          content: buildRetryPrompt(basePrompt, attempt),
        },
      ]);

      return parseRelatedFormsOnlyPrecompute(
        parseStrictJson(extractAssistantPayload(response)),
      );
    } catch (error) {
      lastError = error;
      const recoverable =
        isRecoverableModelError(error) || isRecoverableConnectionError(error);

      if (!recoverable || attempt === MAX_ATTEMPTS_PER_WORD) {
        break;
      }

      // eslint-disable-next-line no-console
      console.warn(
        `Retrying related forms for ${word.word} (attempt ${attempt + 1}/${MAX_ATTEMPTS_PER_WORD}) after: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      await sleep(750 * attempt);
    }
  }

  throw lastError;
}

async function main(): Promise<void> {
  const overwrite = process.argv.includes("--overwrite");
  const requestedFileName = getRequestedFileName();
  const model = await createDirectSpellingCoachModel({
    model: getConfiguredModelName(),
  });

  for (const descriptor of WORD_FILES) {
    if (requestedFileName && descriptor.fileName !== requestedFileName) {
      continue;
    }

    const absolutePath = join(REFERENCE_DATA_DIR, descriptor.fileName);
    const content = readFileSync(absolutePath, "utf8");
    let processed = 0;
    let changedSinceCheckpoint = 0;

    if (descriptor.kind === "foreign") {
      const lists = JSON.parse(content) as ForeignOriginList[];

      for (const list of lists) {
        for (const [index, word] of list.words.entries()) {
          if (!shouldProcess(word, overwrite)) {
            continue;
          }

          try {
            // eslint-disable-next-line no-console
            console.log(`Precomputing related forms for ${word.word}`);
            const result = await precomputeRelatedForms(model, word);
            list.words[index] = {
              ...word,
              word_teaching: {
                ...word.word_teaching!,
                concept_teaching: {
                  ...word.word_teaching!.concept_teaching,
                  related_forms: result.relatedForms.filter(
                    (candidate) =>
                      candidate.toLowerCase() !== word.word.toLowerCase(),
                  ),
                },
              },
            };
            processed += 1;
            changedSinceCheckpoint += 1;

            if (changedSinceCheckpoint >= CHECKPOINT_EVERY) {
              writeJsonFile(absolutePath, lists);
              // eslint-disable-next-line no-console
              console.log(
                `Checkpointed related forms after ${processed} processed words in ${descriptor.fileName}.`,
              );
              changedSinceCheckpoint = 0;
            }
          } catch (error) {
            if (changedSinceCheckpoint > 0) {
              writeJsonFile(absolutePath, lists);
              // eslint-disable-next-line no-console
              console.log(
                `Checkpointed partial related-forms progress before exiting on ${word.word} in ${descriptor.fileName}.`,
              );
            }
            throw error;
          }
        }
      }

      writeJsonFile(absolutePath, lists);
      continue;
    }

    const words = JSON.parse(content) as WordEntry[];

    for (const [index, word] of words.entries()) {
      if (!shouldProcess(word, overwrite)) {
        continue;
      }

      try {
        // eslint-disable-next-line no-console
        console.log(`Precomputing related forms for ${word.word}`);
        const result = await precomputeRelatedForms(model, word);
        words[index] = {
          ...word,
          word_teaching: {
            ...word.word_teaching!,
            concept_teaching: {
              ...word.word_teaching!.concept_teaching,
              related_forms: result.relatedForms.filter(
                (candidate) => candidate.toLowerCase() !== word.word.toLowerCase(),
              ),
            },
          },
        };
        processed += 1;
        changedSinceCheckpoint += 1;

        if (changedSinceCheckpoint >= CHECKPOINT_EVERY) {
          writeJsonFile(absolutePath, words);
          // eslint-disable-next-line no-console
          console.log(
            `Checkpointed related forms after ${processed} processed words in ${descriptor.fileName}.`,
          );
          changedSinceCheckpoint = 0;
        }
      } catch (error) {
        if (changedSinceCheckpoint > 0) {
          writeJsonFile(absolutePath, words);
          // eslint-disable-next-line no-console
          console.log(
            `Checkpointed partial related-forms progress before exiting on ${word.word} in ${descriptor.fileName}.`,
          );
        }
        throw error;
      }
    }

    writeJsonFile(absolutePath, words);
  }
}

void main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exitCode = 1;
});
