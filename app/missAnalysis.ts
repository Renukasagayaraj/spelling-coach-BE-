import type { SpellingCoachInput, SpellingCoachOutput } from "./schemas.js";
import {
  normalizeWordForm,
  parseSimpleSubstitution,
} from "./deterministicMissSignals.js";

type DeterministicErrorType =
  | "far_from_target"
  | "missing_letter"
  | "extra_letter"
  | "letter_substitution"
  | "letter_transposition"
  | "double_letter_error"
  | "phonetic_spelling"
  | "vowel_confusion"
  | "ending_confusion"
  | "chunk_mismatch"
  | "consonant_cluster_error"
  | "silent_letter_error"
  | "pattern_rule_mismatch";

type SecondaryErrorType =
  | DeterministicErrorType
  | "likely_rushed"
  | "wrong_word_interpretation";

type DeterministicCandidate = {
  type: DeterministicErrorType;
  evidence: string;
  priority: number;
  coverage: number;
};

const DETERMINISTIC_PRIORITY: Record<DeterministicErrorType, number> = {
  far_from_target: 130,
  ending_confusion: 120,
  double_letter_error: 115,
  silent_letter_error: 112,
  phonetic_spelling: 109,
  vowel_confusion: 108,
  consonant_cluster_error: 104,
  letter_transposition: 100,
  chunk_mismatch: 103,
  pattern_rule_mismatch: 98,
  extra_letter: 99,
  missing_letter: 99,
  letter_substitution: 40,
};

const MAX_RANKED_SECONDARY_ERROR_TYPES = 2;
const STRUCTURAL_ERROR_TYPES = new Set<DeterministicErrorType>([
  "ending_confusion",
  "pattern_rule_mismatch",
  "chunk_mismatch",
]);
const ENDING_OVERLAP_SECONDARY_PREFERENCE: DeterministicErrorType[] = [
  "phonetic_spelling",
  "vowel_confusion",
  "extra_letter",
  "pattern_rule_mismatch",
  "letter_transposition",
];

function isDeterministicErrorType(
  value: string | null,
): value is DeterministicErrorType {
  return value !== null && value in DETERMINISTIC_PRIORITY;
}

function isSecondaryErrorType(value: string | null): value is SecondaryErrorType {
  return (
    value === "likely_rushed" ||
    value === "wrong_word_interpretation" ||
    isDeterministicErrorType(value)
  );
}

function genericEvidenceChain(
  output: SpellingCoachOutput,
  fallbackEvidence: string,
): string {
  const primaryType = output.missAnalysis.primaryErrorType;
  const primaryEvidence =
    primaryType !== null
      ? output.missAnalysis.errorTypeEvidence[primaryType]
      : undefined;

  return (
    primaryEvidence ??
    output.missAnalysis.errorTypeEvidence.letter_substitution ??
    output.missAnalysis.errorTypeEvidence.missing_letter ??
    output.missAnalysis.errorTypeEvidence.extra_letter ??
    fallbackEvidence
  );
}

function addCandidate(
  candidates: Map<DeterministicErrorType, DeterministicCandidate>,
  candidate: DeterministicCandidate,
): void {
  const existing = candidates.get(candidate.type);
  if (
    !existing ||
    candidate.priority > existing.priority ||
    (candidate.priority === existing.priority &&
      candidate.coverage > existing.coverage)
  ) {
    candidates.set(candidate.type, candidate);
  }
}

function getSubstitutionPairs(input: SpellingCoachInput) {
  return (
    input.missSignals.vowelSubstitutionPairs ??
    input.missSignals.substitutedLetters
      .map(parseSimpleSubstitution)
      .filter(
        (value): value is { actual: string; expected: string } => value !== null,
      )
  );
}

function isVowelChar(value: string): boolean {
  return /^[aeiou]$/i.test(value);
}

function isTwoVowelTranspose(value: string): boolean {
  return value.length === 2 && [...value].every(isVowelChar);
}

function maxSubstitutionSpanLength(substitutedLetters: string[]): number {
  let maxLength = 0;
  for (const substitution of substitutedLetters) {
    const parsed = substitution.match(/^([a-z]+)\s+for\s+([a-z]+)$/i);
    if (!parsed) {
      return Number.POSITIVE_INFINITY;
    }

    maxLength = Math.max(maxLength, parsed[1]!.length, parsed[2]!.length);
  }

  return maxLength;
}

function extractClusterFragment(pattern: string): string | null {
  const normalized = pattern.trim().toLowerCase();
  const clusterMatch = normalized.match(/^([a-z]{2,})-cluster$/);
  if (clusterMatch) {
    return clusterMatch[1]!;
  }

  const tokenMatch = normalized.match(
    /^(?:3-letter\s+blend|blend|digraph|initial digraph|final digraph)\s+([a-z]{2,})$/,
  );
  if (tokenMatch) {
    return tokenMatch[1]!;
  }

  return null;
}

function findConsonantClusterFact(input: SpellingCoachInput): {
  fragment: string;
  reason: string;
  coverage: number;
} | null {
  const target = normalizeWordForm(input.targetWord);
  const attempt = normalizeWordForm(input.childAttempt);

  for (const pattern of input.structuralHints.detectedPatterns) {
    const fragment = extractClusterFragment(pattern);
    if (!fragment || !target.includes(fragment)) {
      continue;
    }

    const collapsedFragment = fragment.length > 1 ? fragment.slice(1) : fragment;
    const reducedFragment = fragment.slice(0, -1);
    const reversedFragment = fragment.split("").reverse().join("");

    if (
      !attempt.includes(fragment) &&
      (attempt.includes(collapsedFragment) ||
        attempt.includes(reducedFragment) ||
        attempt.includes(reversedFragment))
    ) {
      return {
        fragment,
        reason: `The consonant cluster '${fragment}' was changed in the attempt.`,
        coverage: fragment.length,
      };
    }
  }

  return null;
}

function findChunkVowelShift(input: SpellingCoachInput): boolean {
  const fact = input.missSignals.chunkMismatchFacts?.[0];
  if (!fact) {
    return false;
  }

  const expectedVowels = [...fact.expectedChunk].filter(isVowelChar);
  const observedVowels = [...fact.observedFragment].filter(isVowelChar);
  if (expectedVowels.length === 0 || observedVowels.length === 0) {
    return false;
  }

  return (
    expectedVowels.length === observedVowels.length &&
    expectedVowels.some((value, index) => observedVowels[index] !== value)
  );
}

function hasPureVowelOnlyLocalMiss(input: SpellingCoachInput): boolean {
  const vowelPairs = getSubstitutionPairs(input).filter(
    ({ actual, expected }) =>
      /^[aeiou]+$/i.test(actual) && /^[aeiou]+$/i.test(expected),
  );
  const vowelTranspositions = input.missSignals.transposedLetters.filter(
    isTwoVowelTranspose,
  );

  if (input.missSignals.missingLetters.length > 0) {
    return false;
  }

  if (input.missSignals.extraLetters.length > 0) {
    return false;
  }

  if (
    input.missSignals.substitutedLetters.length > 0 &&
    vowelPairs.length !== input.missSignals.substitutedLetters.length
  ) {
    return false;
  }

  if (
    input.missSignals.transposedLetters.length > 0 &&
    vowelTranspositions.length !== input.missSignals.transposedLetters.length
  ) {
    return false;
  }

  return vowelPairs.length > 0 || vowelTranspositions.length > 0;
}

function hasPureExtraDoubleOverlap(input: SpellingCoachInput): boolean {
  const mismatch = input.missSignals.doubleLetterMismatch;
  if (!mismatch?.detected) {
    return false;
  }

  if (input.missSignals.extraLetters.length === 0) {
    return false;
  }

  return input.missSignals.extraLetters.every((letter) =>
    mismatch.extraDouble.includes(letter),
  );
}

function hasSimplePhoneticRewrite(input: SpellingCoachInput): boolean {
  const target = normalizeWordForm(input.targetWord);
  const attempt = normalizeWordForm(input.childAttempt);

  return (
    (target.startsWith("f") && attempt.startsWith("ph")) ||
    (target.includes("f") && attempt.includes("ph") && !target.includes("ph"))
  );
}

function collectDeterministicCandidates(
  input: SpellingCoachInput,
  output: SpellingCoachOutput,
): DeterministicCandidate[] {
  const candidates = new Map<DeterministicErrorType, DeterministicCandidate>();

  if (input.missSignals.editDistance >= 6) {
    addCandidate(candidates, {
      type: "far_from_target",
      evidence:
        output.missAnalysis.errorTypeEvidence.far_from_target ??
        "The spelling changed several parts of the word, so it drifted far from the target word.",
      priority: DETERMINISTIC_PRIORITY.far_from_target,
      coverage: input.missSignals.editDistance,
    });
  }

  const endingFact = input.missSignals.endingConfusionFacts?.[0] ?? null;
  if (endingFact) {
    addCandidate(candidates, {
      type: "ending_confusion",
      evidence:
        output.missAnalysis.errorTypeEvidence.ending_confusion ??
        genericEvidenceChain(
          output,
          `The word ending '${endingFact.suffix}' was spelled incorrectly.`,
        ),
      priority: DETERMINISTIC_PRIORITY.ending_confusion,
      coverage: Math.max(endingFact.suffix.length, endingFact.attemptedEnding.length),
    });

    addCandidate(candidates, {
      type: "pattern_rule_mismatch",
      evidence:
        output.missAnalysis.errorTypeEvidence.pattern_rule_mismatch ??
        `The ending does not match the expected suffix pattern '${endingFact.suffix}'.`,
      priority: DETERMINISTIC_PRIORITY.pattern_rule_mismatch,
      coverage: endingFact.suffix.length,
    });

    if (endingFact.phoneticRewrite) {
      addCandidate(candidates, {
        type: "phonetic_spelling",
        evidence:
          output.missAnalysis.errorTypeEvidence.phonetic_spelling ??
          "The ending was rewritten more by sound than by its usual spelling.",
        priority: DETERMINISTIC_PRIORITY.phonetic_spelling,
        coverage: Math.max(endingFact.suffix.length, endingFact.attemptedEnding.length),
      });
    }
  }

  if (
    (input.missSignals.doubleLetterMismatch?.detected &&
      (input.missSignals.doubleLetterMismatch.missingFromDouble.length > 0 ||
        input.missSignals.doubleLetterMismatch.extraDouble.length > 0)) ||
    (input.missSignals.repeatedLetterIssue &&
      input.missSignals.substitutedLetters.length === 0 &&
      input.missSignals.transposedLetters.length === 0 &&
      (input.missSignals.missingLetters.length > 0 ||
        input.missSignals.extraLetters.length > 0))
  ) {
    addCandidate(candidates, {
      type: "double_letter_error",
      evidence:
        output.missAnalysis.errorTypeEvidence.double_letter_error ??
        genericEvidenceChain(
          output,
          "The spelling has a double-letter problem in this part of the word.",
        ),
      priority: DETERMINISTIC_PRIORITY.double_letter_error,
      coverage: 2,
    });
  }

  const silentFact = input.missSignals.silentLetterFactsTouched?.[0] ?? null;
  if (silentFact) {
    addCandidate(candidates, {
      type: "silent_letter_error",
      evidence:
        output.missAnalysis.errorTypeEvidence.silent_letter_error ??
        silentFact.reason,
      priority: DETERMINISTIC_PRIORITY.silent_letter_error,
      coverage: silentFact.text.length,
    });
  }

  const vowelPairs = getSubstitutionPairs(input).filter(
    ({ actual, expected }) =>
      /^[aeiou]+$/i.test(actual) && /^[aeiou]+$/i.test(expected),
  );
  const vowelTranspositions = input.missSignals.transposedLetters.filter(
    isTwoVowelTranspose,
  );
  if (
    vowelPairs.length > 0 ||
    vowelTranspositions.length > 0 ||
    findChunkVowelShift(input)
  ) {
    addCandidate(candidates, {
      type: "vowel_confusion",
      evidence:
        output.missAnalysis.errorTypeEvidence.vowel_confusion ??
        genericEvidenceChain(
          output,
          "The spelling uses the wrong vowel in this part of the word.",
        ),
      priority: DETERMINISTIC_PRIORITY.vowel_confusion,
      coverage:
        vowelPairs.reduce(
          (total, pair) =>
            total + Math.max(pair.actual.length, pair.expected.length),
          0,
        ) + vowelTranspositions.length * 2,
    });
  }

  const clusterFact = findConsonantClusterFact(input);
  if (clusterFact) {
    addCandidate(candidates, {
      type: "consonant_cluster_error",
      evidence:
        output.missAnalysis.errorTypeEvidence.consonant_cluster_error ??
        clusterFact.reason,
      priority: DETERMINISTIC_PRIORITY.consonant_cluster_error,
      coverage: clusterFact.coverage,
    });
  }

  if (
    input.missSignals.editDistance >= 2 &&
    input.missSignals.transposedLetters.some(
      (value) => value.length === 2 && !isTwoVowelTranspose(value),
    ) &&
    input.missSignals.substitutedLetters.length === 0
  ) {
    addCandidate(candidates, {
      type: "letter_transposition",
      evidence:
        output.missAnalysis.errorTypeEvidence.letter_transposition ??
        genericEvidenceChain(
          output,
          "The spelling uses the right letters but in the wrong order.",
        ),
      priority: DETERMINISTIC_PRIORITY.letter_transposition,
      coverage: Math.max(
        ...input.missSignals.transposedLetters
          .filter((value) => value.length === 2 && !isTwoVowelTranspose(value))
          .map((value) => value.length),
      ),
    });
  }

  const phoneticFact =
    input.missSignals.trickyPartFactsTouched?.find((fact) => fact.phoneticRewrite) ??
    input.missSignals.chunkMismatchFacts?.find((fact) => fact.phoneticRewrite) ??
    null;
  if (phoneticFact || hasSimplePhoneticRewrite(input)) {
    addCandidate(candidates, {
      type: "phonetic_spelling",
      evidence:
        output.missAnalysis.errorTypeEvidence.phonetic_spelling ??
        (phoneticFact && "reason" in phoneticFact
          ? phoneticFact.reason
          : hasSimplePhoneticRewrite(input)
            ? "The spelling uses a sound-based rewrite in this part of the word."
            : "The chunk was rewritten more by sound than by its expected spelling."),
      priority: DETERMINISTIC_PRIORITY.phonetic_spelling,
      coverage:
        phoneticFact
          ? "text" in phoneticFact
            ? phoneticFact.text.length
            : phoneticFact.expectedChunk.length
          : 2,
    });
  }

  const patternFact = input.missSignals.trickyPartFactsTouched?.[0] ?? null;
  if (patternFact) {
    addCandidate(candidates, {
      type: "pattern_rule_mismatch",
      evidence:
        output.missAnalysis.errorTypeEvidence.pattern_rule_mismatch ??
        patternFact.reason,
      priority: DETERMINISTIC_PRIORITY.pattern_rule_mismatch,
      coverage: patternFact.text.length,
    });
  }

  const chunkFact = input.missSignals.chunkMismatchFacts?.[0] ?? null;
  if (chunkFact && !endingFact) {
    addCandidate(candidates, {
      type: "chunk_mismatch",
      evidence:
        output.missAnalysis.errorTypeEvidence.chunk_mismatch ??
        genericEvidenceChain(
          output,
          `The expected chunk '${chunkFact.expectedChunk}' was changed to '${chunkFact.observedFragment || "(missing)"}'.`,
        ),
      priority: DETERMINISTIC_PRIORITY.chunk_mismatch,
      coverage: Math.max(
        chunkFact.expectedChunk.length,
        chunkFact.observedFragment.length,
      ),
    });
  }

  if (
    input.missSignals.missingLetters.length >= 1 &&
    input.missSignals.missingLetters.length <= 2 &&
    true
  ) {
    addCandidate(candidates, {
      type: "missing_letter",
      evidence:
        output.missAnalysis.errorTypeEvidence.missing_letter ??
        "A letter is missing from the spelling attempt.",
      priority: DETERMINISTIC_PRIORITY.missing_letter,
      coverage: input.missSignals.missingLetters.length,
    });
  }

  if (
    input.missSignals.extraLetters.length >= 1 &&
    input.missSignals.extraLetters.length <= 2 &&
    !hasSimplePhoneticRewrite(input) &&
    !hasPureExtraDoubleOverlap(input)
  ) {
    addCandidate(candidates, {
      type: "extra_letter",
      evidence:
        output.missAnalysis.errorTypeEvidence.extra_letter ??
        "An extra letter was added in the spelling attempt.",
      priority: DETERMINISTIC_PRIORITY.extra_letter,
      coverage: input.missSignals.extraLetters.length,
    });
  }

  if (
    input.missSignals.substitutedLetters.length > 0 &&
    maxSubstitutionSpanLength(input.missSignals.substitutedLetters) <= 2
  ) {
    addCandidate(candidates, {
      type: "letter_substitution",
      evidence:
        output.missAnalysis.errorTypeEvidence.letter_substitution ??
        genericEvidenceChain(
          output,
          "The spelling uses the wrong letters in this part of the word.",
        ),
      priority: DETERMINISTIC_PRIORITY.letter_substitution,
      coverage: Math.min(input.missSignals.substitutedLetters.length, 2),
    });
  }

  return [...candidates.values()].sort((left, right) => {
    if (right.priority !== left.priority) {
      return right.priority - left.priority;
    }

    if (right.coverage !== left.coverage) {
      return right.coverage - left.coverage;
    }

    return left.type.localeCompare(right.type);
  });
}

function isCuratedEndingFact(
  suffix: string,
): boolean {
  return [
    "ies",
    "es",
    "s",
    "ition",
    "tion",
    "sion",
    "cion",
    "cian",
    "tian",
    "tious",
    "cious",
    "able",
    "ible",
    "ance",
    "ence",
    "ment",
    "ous",
    "ious",
    "eous",
    "ity",
    "ary",
    "ery",
    "ory",
    "ate",
    "ify",
    "ed",
  ].includes(suffix);
}

function shouldUseEndingFact(input: SpellingCoachInput): boolean {
  const facts = input.missSignals.endingConfusionFacts ?? [];
  if (facts.length === 0) {
    return false;
  }

  const target = normalizeWordForm(input.targetWord);
  const attempt = normalizeWordForm(input.childAttempt);
  let sharedPrefix = 0;
  while (
    sharedPrefix < target.length &&
    sharedPrefix < attempt.length &&
    target[sharedPrefix] === attempt[sharedPrefix]
  ) {
    sharedPrefix += 1;
  }

  return facts.some((fact) => {
    if (isCuratedEndingFact(fact.suffix)) {
      return true;
    }

    if (sharedPrefix >= Math.max(target.length - 5, 1)) {
      return true;
    }

    if (fact.suffix.length >= 4 && fact.attemptedEnding.length >= 4) {
      return true;
    }

    if (
      fact.suffix.length >= 4 &&
      fact.attemptedEnding.length >= 3 &&
      input.missSignals.wrongWordInterpretationHints?.substantialStructuralOverlap
    ) {
      return true;
    }

    return false;
  });
}

function shouldKeepSecondaryCandidate(
  primaryType: DeterministicErrorType,
  candidateType: DeterministicErrorType,
): boolean {
  if (candidateType === primaryType) {
    return false;
  }

  if (candidateType === "far_from_target") {
    return false;
  }

  if (candidateType === "letter_substitution") {
    return false;
  }

  if (candidateType === "chunk_mismatch") {
    return false;
  }

  return true;
}

function isPotentialEndingOverlapSecondary(
  candidateType: DeterministicErrorType,
): boolean {
  return ENDING_OVERLAP_SECONDARY_PREFERENCE.includes(candidateType);
}

function getEndingSuffix(input: SpellingCoachInput): string | null {
  return input.missSignals.endingConfusionFacts?.[0]?.suffix ?? null;
}

function hasNonEndingChunkMismatchRelativeToEnding(
  input: SpellingCoachInput,
): boolean {
  const endingSuffix = getEndingSuffix(input);
  const chunkFact = input.missSignals.chunkMismatchFacts?.[0];
  if (!endingSuffix || !chunkFact) {
    return false;
  }

  const expectedChunk = normalizeWordForm(chunkFact.expectedChunk);
  const suffix = normalizeWordForm(endingSuffix);
  if (!expectedChunk || !suffix) {
    return false;
  }

  return !expectedChunk.includes(suffix) && !suffix.includes(expectedChunk);
}

function isNonEndingSecondaryCandidate(
  input: SpellingCoachInput,
  candidateType: DeterministicErrorType,
): boolean {
  if (
    candidateType === "double_letter_error" ||
    candidateType === "consonant_cluster_error" ||
    candidateType === "silent_letter_error"
  ) {
    return true;
  }

  if (
    candidateType === "missing_letter" &&
    hasNonEndingChunkMismatchRelativeToEnding(input)
  ) {
    return true;
  }

  return false;
}

function rankEndingOverlapSecondary(
  candidate: DeterministicCandidate,
): number {
  const index = ENDING_OVERLAP_SECONDARY_PREFERENCE.indexOf(candidate.type);
  return index === -1 ? Number.POSITIVE_INFINITY : index;
}

function chooseSecondaryCandidates(
  input: SpellingCoachInput,
  primary: DeterministicCandidate,
  candidates: DeterministicCandidate[],
): DeterministicCandidate[] {
  const eligible = candidates.filter((candidate) =>
    shouldKeepSecondaryCandidate(primary.type, candidate.type),
  );

  if (primary.type !== "ending_confusion") {
    return eligible.slice(0, MAX_RANKED_SECONDARY_ERROR_TYPES);
  }

  const nonEnding = eligible.filter((candidate) =>
    isNonEndingSecondaryCandidate(input, candidate.type),
  );
  const strongNonEnding = nonEnding.filter(
    (candidate) => candidate.type !== "missing_letter",
  );
  const flexibleNonEnding = nonEnding.filter(
    (candidate) => candidate.type === "missing_letter",
  );
  const overlap = eligible
    .filter((candidate) => isPotentialEndingOverlapSecondary(candidate.type))
    .sort((left, right) => {
      const rankDiff =
        rankEndingOverlapSecondary(left) - rankEndingOverlapSecondary(right);
      if (rankDiff !== 0) {
        return rankDiff;
      }

      if (right.priority !== left.priority) {
        return right.priority - left.priority;
      }

      return right.coverage - left.coverage;
    });
  const remaining = eligible.filter(
    (candidate) =>
      !nonEnding.some((value) => value.type === candidate.type) &&
      !overlap.some((value) => value.type === candidate.type),
  );

  const selected: DeterministicCandidate[] = [];
  const preferredOverlap =
    overlap.find((candidate) => candidate.type === "phonetic_spelling") ??
    overlap.find((candidate) => candidate.type === "vowel_confusion") ??
    null;

  for (const candidate of strongNonEnding) {
    if (selected.some((value) => value.type === candidate.type)) {
      continue;
    }
    if (
      preferredOverlap &&
      selected.length >= MAX_RANKED_SECONDARY_ERROR_TYPES - 1
    ) {
      break;
    }
    selected.push(candidate);
    if (selected.length >= MAX_RANKED_SECONDARY_ERROR_TYPES) {
      return selected;
    }
  }

  if (
    preferredOverlap &&
    selected.length < MAX_RANKED_SECONDARY_ERROR_TYPES &&
    !selected.some((value) => value.type === preferredOverlap.type)
  ) {
    selected.push(preferredOverlap);
  } else if (
    overlap.length > 0 &&
    selected.length < MAX_RANKED_SECONDARY_ERROR_TYPES
  ) {
    const bestOverlap = overlap.find(
      (candidate) => !selected.some((value) => value.type === candidate.type),
    );
    if (bestOverlap) {
      selected.push(bestOverlap);
    }
  }

  for (const candidate of flexibleNonEnding) {
    if (selected.some((value) => value.type === candidate.type)) {
      continue;
    }
    if (selected.length >= MAX_RANKED_SECONDARY_ERROR_TYPES) {
      return selected;
    }
    selected.push(candidate);
  }

  for (const candidate of remaining) {
    if (selected.some((value) => value.type === candidate.type)) {
      continue;
    }
    if (selected.length >= MAX_RANKED_SECONDARY_ERROR_TYPES) {
      break;
    }
    selected.push(candidate);
  }

  return selected;
}

function countActiveRawMissGroups(input: SpellingCoachInput): number {
  const activeGroups = [
    input.missSignals.substitutedLetters.length > 0,
    input.missSignals.editDistance >= 2 &&
      input.missSignals.transposedLetters.length > 0,
    input.missSignals.missingLetters.length > 0,
    input.missSignals.extraLetters.length > 0,
  ].filter(Boolean).length;

  return activeGroups;
}

function isPureDoubleLetterMiss(input: SpellingCoachInput): boolean {
  const doubleMismatch = input.missSignals.doubleLetterMismatch;
  if (!doubleMismatch?.detected) {
    return false;
  }

  if (
    input.missSignals.substitutedLetters.length > 0 ||
    input.missSignals.transposedLetters.length > 0
  ) {
    return false;
  }

  const missingCount = input.missSignals.missingLetters.length;
  const extraCount = input.missSignals.extraLetters.length;
  return (
    (missingCount > 0 && extraCount === 0) || (extraCount > 0 && missingCount === 0)
  );
}

function shouldPreferSpecificLocalPrimaryOverEnding(
  input: SpellingCoachInput,
  candidates: DeterministicCandidate[],
): boolean {
  const hasEndingConfusion = candidates.some(
    (candidate) => candidate.type === "ending_confusion",
  );
  if (!hasEndingConfusion) {
    return false;
  }

  const localCandidates = candidates.filter(
    (candidate) => !STRUCTURAL_ERROR_TYPES.has(candidate.type),
  );
  if (localCandidates.length === 0) {
    return false;
  }

  if (isPureDoubleLetterMiss(input)) {
    return true;
  }

  if (hasPureVowelOnlyLocalMiss(input)) {
    return true;
  }

  const activeGroups = countActiveRawMissGroups(input);
  if (activeGroups !== 1) {
    return false;
  }

  if (
    input.missSignals.substitutedLetters.length > 0 &&
    maxSubstitutionSpanLength(input.missSignals.substitutedLetters) > 2
  ) {
    return false;
  }

  if (
    input.missSignals.missingLetters.length > 2 ||
    input.missSignals.extraLetters.length > 2
  ) {
    return false;
  }

  return true;
}

function choosePrimaryCandidate(
  input: SpellingCoachInput,
  candidates: DeterministicCandidate[],
): DeterministicCandidate {
  if (!shouldPreferSpecificLocalPrimaryOverEnding(input, candidates)) {
    return candidates[0]!;
  }

  const localPrimary = candidates.find(
    (candidate) => !STRUCTURAL_ERROR_TYPES.has(candidate.type),
  );
  return localPrimary ?? candidates[0]!;
}

export function normalizeMissAnalysisErrorTypes(
  input: SpellingCoachInput,
  output: SpellingCoachOutput,
): SpellingCoachOutput {
  const candidates = collectDeterministicCandidates(
    {
      ...input,
      missSignals: {
        ...input.missSignals,
        endingConfusionFacts: shouldUseEndingFact(input)
          ? input.missSignals.endingConfusionFacts
          : [],
      },
    },
    output,
  );
  const specificCandidates = candidates.filter(
    (candidate) =>
      candidate.type !== "chunk_mismatch" && candidate.type !== "letter_substitution",
  );
  const filteredCandidates =
    specificCandidates.length > 0
      ? candidates.filter(
          (candidate) =>
            candidate.type !== "chunk_mismatch" &&
            candidate.type !== "letter_substitution",
        )
      : candidates;
  if (filteredCandidates.length === 0) {
    output.missAnalysis.secondaryErrorTypes =
      output.missAnalysis.secondaryErrorTypes.filter(
        (value, index, values) =>
          value !== output.missAnalysis.primaryErrorType &&
          values.indexOf(value) === index,
      );
    return output;
  }

  const primary = choosePrimaryCandidate(input, filteredCandidates);
  const selectedSecondaryCandidates = chooseSecondaryCandidates(
    input,
    primary,
    filteredCandidates,
  );
  const selectedSecondaryTypes = new Set<DeterministicErrorType>(
    selectedSecondaryCandidates.map((candidate) => candidate.type),
  );

  const preservedExistingSecondaries = output.missAnalysis.secondaryErrorTypes.filter(
    (value) =>
      value !== primary.type &&
      value !== "wrong_word_interpretation" &&
      !selectedSecondaryTypes.has(value as DeterministicErrorType) &&
      !isDeterministicErrorType(value),
  );

  const secondaryErrorTypes: SecondaryErrorType[] = [
    ...selectedSecondaryCandidates.map((candidate) => candidate.type),
  ];
  for (const value of preservedExistingSecondaries) {
    if (secondaryErrorTypes.length >= MAX_RANKED_SECONDARY_ERROR_TYPES) {
      break;
    }

    if (isSecondaryErrorType(value)) {
      secondaryErrorTypes.push(value);
    }
  }

  if (
    output.missAnalysis.likelyWrongWordInterpretation &&
    primary.type !== "wrong_word_interpretation" &&
    !secondaryErrorTypes.includes("wrong_word_interpretation")
  ) {
    secondaryErrorTypes.push("wrong_word_interpretation");
  }

  const nextEvidence: Record<string, string> = {};
  nextEvidence[primary.type] = primary.evidence;

  for (const secondaryType of secondaryErrorTypes) {
    const candidate = filteredCandidates.find((value) => value.type === secondaryType);
    nextEvidence[secondaryType] =
      candidate?.evidence ??
      output.missAnalysis.errorTypeEvidence[secondaryType] ??
      "";
  }

  if (secondaryErrorTypes.includes("wrong_word_interpretation")) {
    nextEvidence.wrong_word_interpretation =
      output.missAnalysis.errorTypeEvidence.wrong_word_interpretation ??
      "The attempt reads as another real English word.";
  }

  output.missAnalysis.primaryErrorType = primary.type;
  output.missAnalysis.secondaryErrorTypes = secondaryErrorTypes;
  output.missAnalysis.errorTypeEvidence = nextEvidence;

  return output;
}

function sanitizeMissAnalysisText(text: string): string {
  if (!text) {
    return text;
  }

  let sanitized = text.trim();

  const phraseReplacements: Array<[RegExp, string]> = [
    [/^the child substituted\b/i, "The spelling substituted"],
    [/^the child added\b/i, "The spelling adds"],
    [/^the child wrote\b/i, "The spelling uses"],
    [/^the child replaced\b/i, "The spelling replaces"],
    [/^child substituted\b/i, "The spelling substituted"],
    [/^child added\b/i, "The spelling adds"],
    [/^child wrote\b/i, "The spelling uses"],
    [/^child replaced\b/i, "The spelling replaces"],
    [/\bthe child\b/gi, "the spelling"],
    [/\bchild\b/gi, "spelling"],
    [/\bstudent\b/gi, "spelling"],
    [/\blearner\b/gi, "spelling"],
  ];

  for (const [pattern, replacement] of phraseReplacements) {
    sanitized = sanitized.replace(pattern, replacement);
  }

  sanitized = sanitized.replace(
    /\bthe raw signals?\s+(?:show|shows|indicate|indicates)\b[:\s]*/gi,
    "",
  );
  sanitized = sanitized.replace(
    /\braw signals?\s+(?:show|shows|indicate|indicates)\b[:\s]*/gi,
    "",
  );
  sanitized = sanitized.replace(/\bthe raw signals?\b/gi, "The spelling details");
  sanitized = sanitized.replace(/\braw signals?\b/gi, "spelling details");
  sanitized = sanitized.replace(/\brawSignals\.[A-Za-z0-9_]+\b[^.]*\.?/gi, "");
  sanitized = sanitized.replace(
    /\b(?:substitutedLetters|extraLetters|repeatedLetterIssue|likelyChunks|detectedPatterns)\b[^.]*\.?/gi,
    "",
  );
  sanitized = sanitized.replace(
    /\bas shown by (?:the )?[A-Za-z][A-Za-z0-9_]*(?: signal| signals| fact| facts)?\b[^.]*\.?/gi,
    "",
  );
  sanitized = sanitized.replace(
    /\bas shown by\b[^.]*\b(?:signal|signals|fact|facts)\b[^.]*\.?/gi,
    "",
  );
  sanitized = sanitized.replace(
    /\b(?:the )?[A-Za-z][A-Za-z0-9_]*(?: signal| signals| fact| facts)\b/gi,
    "",
  );
  sanitized = sanitized.replace(
    /\bthe edit distance is \d+\b[^.]*\.?/gi,
    "The spelling is very close.",
  );
  sanitized = sanitized.replace(
    /\bedit distance is \d+\b[^.]*\.?/gi,
    "The spelling is very close.",
  );
  sanitized = sanitized.replace(
    /\b(?:the )?[A-Za-z][A-Za-z0-9_]*(?:Pairs|Facts|Letters|Chunks|Patterns|Signals|Signal|Facts|Fact)\b/gi,
    "",
  );
  sanitized = sanitized.replace(
    /\b(?:missingLetters|chunkMismatchFacts|likelyRushed|vowelSubstitutionPairs|transposedLetters)\b[^.]*\.?/gi,
    "",
  );
  sanitized = sanitized.replace(
    /\b(?:showing|indicating)\b\s+(?:the )?[A-Za-z][A-Za-z0-9_]*(?: is)?\b[^.]*\.?/gi,
    "",
  );
  sanitized = sanitized.replace(/\b(?:true|false)\b/gi, "");
  sanitized = sanitized.replace(/\b(?:signal|signals|fact|facts)\b/gi, "");
  sanitized = sanitized.replace(/\s{2,}/g, " ");
  sanitized = sanitized.replace(/\s+([.,;:!?])/g, "$1");
  sanitized = sanitized.replace(/^\s*[:,-]\s*/g, "");
  sanitized = sanitized.replace(/\.\s*\./g, ".");
  sanitized = sanitized.replace(/\.\s*(?:,|;|:)/g, ".");
  sanitized = sanitized.replace(/\b(and|or)\s*\.$/gi, ".");
  sanitized = sanitized.trim();

  if (!sanitized) {
    return "";
  }

  return sanitized.charAt(0).toUpperCase() + sanitized.slice(1);
}

export function sanitizeMissAnalysis(
  output: SpellingCoachOutput,
): SpellingCoachOutput {
  output.missAnalysis.summary = sanitizeMissAnalysisText(
    output.missAnalysis.summary,
  );
  output.missAnalysis.primaryErrorFocus = sanitizeMissAnalysisText(
    output.missAnalysis.primaryErrorFocus,
  );

  output.missAnalysis.errorTypeEvidence = Object.fromEntries(
    Object.entries(output.missAnalysis.errorTypeEvidence).map(([key, value]) => [
      key,
      sanitizeMissAnalysisText(value),
    ]),
  );

  output.coachingText.fullExplanation = sanitizeMissAnalysisText(
    output.coachingText.fullExplanation,
  );
  output.coachingText.memoryTip = sanitizeMissAnalysisText(
    output.coachingText.memoryTip,
  );

  return output;
}
