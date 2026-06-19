import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyPronunciationOverride,
  loadPronunciationOverrides,
} from "../app/pronunciationOverrides.js";
import {
  auditFriendlyPronunciation,
  buildPronunciationReviewBuckets,
  type PronunciationAuditEntry,
  type PronunciationConfidence,
} from "../app/pronunciationConfidence.js";

type StoredPatternMatch = {
  label: string;
  matchedText?: string;
  matchedParts?: string[];
  alternateMatchedParts?: string[][];
};

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
  phoneme_metadata?: {
    source: "g2p-en";
    phonemes: string[];
    sound_aware_patterns: StoredPatternMatch[];
    friendly_chunks?: string[];
    say_aloud_tip?: string;
    pronunciation_confidence?: PronunciationConfidence;
  };
};

const WORD_CATALOG_PATH = join(
  process.cwd(),
  "reference_data",
  "words.generated.json",
);
const REVIEW_OUTPUT_PATH = join(
  process.cwd(),
  "reference_data",
  "pronunciation_review.generated.json",
);

type ReviewOutput = {
  generatedAt: string;
  total: number;
  summary: {
    high: number;
    medium: number;
    low: number;
  };
  buckets: Record<
    string,
    {
      count: number;
      entries: PronunciationAuditEntry[];
    }
  >;
  reviewList: PronunciationAuditEntry[];
};

function sortAuditEntries(
  left: PronunciationAuditEntry,
  right: PronunciationAuditEntry,
): number {
  return left.score - right.score || left.word.localeCompare(right.word);
}

function main(): void {
  const shouldWriteConfidence = process.argv.includes("--write-confidence");
  const overrideByWord = new Map(
    loadPronunciationOverrides().map((override) => [
      override.word.toLowerCase(),
      override,
    ]),
  );
  const words = (JSON.parse(readFileSync(WORD_CATALOG_PATH, "utf8")) as WordEntry[])
    .map(applyPronunciationOverride);
  const audits = words
    .map((entry) => {
      const audit = auditFriendlyPronunciation(entry);
      const explicitConfidence = overrideByWord.get(
        entry.word.toLowerCase(),
      )?.pronunciation_confidence;
      return explicitConfidence ? { ...audit, confidence: explicitConfidence } : audit;
    })
    .sort(sortAuditEntries);
  const bucketEligibleAudits = audits.filter(
    (audit) =>
      overrideByWord.get(audit.word.toLowerCase())?.pronunciation_confidence !==
      "high",
  );
  const buckets = buildPronunciationReviewBuckets(bucketEligibleAudits);

  if (shouldWriteConfidence) {
    const confidenceByWord = new Map(
      audits.map((audit) => [audit.word.toLowerCase(), audit.confidence]),
    );
    const updatedWords = words.map((entry) => ({
      ...entry,
      phoneme_metadata: entry.phoneme_metadata
        ? {
            ...entry.phoneme_metadata,
            pronunciation_confidence:
              confidenceByWord.get(entry.word.toLowerCase()) ??
              entry.phoneme_metadata.pronunciation_confidence,
          }
        : entry.phoneme_metadata,
    }));

    writeFileSync(WORD_CATALOG_PATH, `${JSON.stringify(updatedWords, null, 2)}\n`, "utf8");
  }

  const reviewSet = new Map<string, PronunciationAuditEntry>();
  for (const audit of audits) {
    if (audit.confidence !== "high") {
      reviewSet.set(audit.word.toLowerCase(), audit);
    }
  }

  for (const entries of Object.values(buckets)) {
    for (const audit of entries) {
      reviewSet.set(audit.word.toLowerCase(), audit);
    }
  }

  const output: ReviewOutput = {
    generatedAt: new Date().toISOString(),
    total: audits.length,
    summary: {
      high: audits.filter((audit) => audit.confidence === "high").length,
      medium: audits.filter((audit) => audit.confidence === "medium").length,
      low: audits.filter((audit) => audit.confidence === "low").length,
    },
    buckets: Object.fromEntries(
      Object.entries(buckets).map(([name, entries]) => [
        name,
        {
          count: entries.length,
          entries,
        },
      ]),
    ),
    reviewList: Array.from(reviewSet.values()).sort(sortAuditEntries),
  };

  writeFileSync(REVIEW_OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, "utf8");

  // eslint-disable-next-line no-console
  console.log(
    `Audited ${output.total} words. Review list: ${output.reviewList.length}. ` +
      `high=${output.summary.high}, medium=${output.summary.medium}, low=${output.summary.low}`,
  );
}

main();
