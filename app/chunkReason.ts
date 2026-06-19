import type { SpellingCoachOutput, WordTeachingPrecompute } from "./schemas.js";

const GENERIC_CHUNK_REASON_PATTERNS = [
  /easy to say and remember/i,
  /simple parts that match natural sound groups/i,
  /natural sound groups/i,
  /two simple parts/i,
  /breaking the word into/i,
];

function isGenericChunkReason(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) {
    return true;
  }

  return GENERIC_CHUNK_REASON_PATTERNS.some((pattern) => pattern.test(normalized));
}

function buildChunkReason(
  chunks: string[],
  patterns: string[],
): string {
  const filteredChunks = chunks.map((chunk) => chunk.trim()).filter(Boolean);
  const filteredPatterns = patterns.map((pattern) => pattern.trim()).filter(Boolean);

  if (filteredChunks.length >= 2) {
    return `The word breaks as ${filteredChunks.join(" + ")}.`;
  }

  if (filteredPatterns.length > 0) {
    return `The chunk matches the pattern ${filteredPatterns[0]}.`;
  }

  if (filteredChunks.length === 1) {
    return `Use the chunk ${filteredChunks[0]}.`;
  }

  return "";
}

export function normalizeWordTeachingPrecomputeChunkReason(
  precompute: WordTeachingPrecompute,
): WordTeachingPrecompute {
  if (!isGenericChunkReason(precompute.wordBreakdown.chunkReason)) {
    return precompute;
  }

  return {
    ...precompute,
    wordBreakdown: {
      ...precompute.wordBreakdown,
      chunkReason: buildChunkReason(
        precompute.wordBreakdown.displayChunks,
        (precompute.wordBreakdown.matchedPatterns ?? []).map(
          (pattern) => pattern.label,
        ),
      ),
    },
  };
}

export function normalizeSpellingCoachOutputChunkReason(
  output: SpellingCoachOutput,
): SpellingCoachOutput {
  if (!isGenericChunkReason(output.wordBreakdown.chunkReason)) {
    return output;
  }

  return {
    ...output,
    wordBreakdown: {
      ...output.wordBreakdown,
      chunkReason: buildChunkReason(
        output.wordBreakdown.displayChunks,
        (output.wordBreakdown.matchedPatterns ?? []).map(
          (pattern) => pattern.label,
        ),
      ),
    },
  };
}
