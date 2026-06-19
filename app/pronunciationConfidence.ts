export type PronunciationConfidence = "high" | "medium" | "low";

export type PronunciationAuditEntry = {
  word: string;
  level: string;
  score: number;
  confidence: PronunciationConfidence;
  flags: string[];
  tip: string;
  chunks: string[];
  phonemes: string[];
};

type WordLike = {
  word: string;
  level: string;
  phoneme_metadata?: {
    phonemes?: string[];
    friendly_chunks?: string[];
    say_aloud_tip?: string;
  };
};

export type PronunciationReviewBuckets = {
  awkward_glide_spellings: PronunciationAuditEntry[];
  all_caps_single_lump: PronunciationAuditEntry[];
  over_segmented_long_words: PronunciationAuditEntry[];
  suspicious_oy_without_oi_oy: PronunciationAuditEntry[];
  suspicious_eye_spellings: PronunciationAuditEntry[];
};

export type PronunciationReviewBucketName =
  keyof PronunciationReviewBuckets;

function normalizeWord(value: string): string {
  return String(value || "").toLowerCase().replace(/[^a-z]/g, "");
}

function normalizePronunciation(value: string): string {
  return String(value || "").toLowerCase().replace(/[^a-z]/g, "");
}

function levenshtein(left: string, right: string): number {
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
        matrix[row - 1]![col]! + 1,
        matrix[row]![col - 1]! + 1,
        matrix[row - 1]![col - 1]! + cost,
      );
    }
  }

  return matrix[rows - 1]![cols - 1]!;
}

function hasVowel(value: string): boolean {
  return /[aeiouy]/i.test(value);
}

function countVowelPhonemes(phonemes: string[]): number {
  return phonemes.filter((phoneme) =>
    /^(AA|AE|AH|AO|AW|AY|EH|ER|EY|IH|IY|OW|OY|UH|UW)/.test(
      String(phoneme).replace(/[0-9]/g, ""),
    ),
  ).length;
}

function buildAuditEntry(
  entry: WordLike,
  score: number,
  flags: string[],
  reviewBuckets: PronunciationReviewBucketName[] = [],
): PronunciationAuditEntry {
  const phonemes = entry.phoneme_metadata?.phonemes ?? [];
  const chunks = entry.phoneme_metadata?.friendly_chunks ?? [];
  const tip = entry.phoneme_metadata?.say_aloud_tip ?? "";

  let confidence: PronunciationConfidence = "high";
  if (score < 70) {
    confidence = "medium";
  }
  if (score < 45) {
    confidence = "low";
  }
  if (reviewBuckets.length > 0) {
    confidence = "low";
  }

  return {
    word: entry.word,
    level: entry.level,
    score,
    confidence,
    flags: Array.from(new Set(flags)),
    tip,
    chunks,
    phonemes,
  };
}

export function getPronunciationReviewBucketNames(
  entry: Pick<PronunciationAuditEntry, "word" | "tip">,
): PronunciationReviewBucketName[] {
  const tipBody = entry.tip
    .replace(/^Say it slowly:\s*/i, "")
    .replace(/^Sounds like:\s*/i, "");
  const normalizedWord = normalizeWord(entry.word);
  const buckets: PronunciationReviewBucketName[] = [];

  if (/(weye|zeye|reye|tey|twey|teye|weyel|tsey)/i.test(tipBody)) {
    buckets.push("awkward_glide_spellings");
  }

  if (/^Sounds like:\s*[A-Z]{5,}$/.test(entry.tip)) {
    buckets.push("all_caps_single_lump");
  }

  if ((tipBody.match(/-/g) || []).length >= 6) {
    buckets.push("over_segmented_long_words");
  }

  if (/oy/i.test(tipBody) && !/(oi|oy)/.test(normalizedWord)) {
    buckets.push("suspicious_oy_without_oi_oy");
  }

  if (/(teye|weye|reye|zeye)/i.test(tipBody)) {
    buckets.push("suspicious_eye_spellings");
  }

  return Array.from(new Set(buckets));
}

export function auditFriendlyPronunciation(
  entry: WordLike,
): PronunciationAuditEntry {
  const phonemes = entry.phoneme_metadata?.phonemes ?? [];
  const chunks = entry.phoneme_metadata?.friendly_chunks ?? [];
  const tip = entry.phoneme_metadata?.say_aloud_tip ?? "";

  let score = 100;
  const flags: string[] = [];

  if (phonemes.length === 0) {
    score -= 60;
    flags.push("missing phonemes");
  }

  if (chunks.length === 0) {
    score -= 50;
    flags.push("missing friendly_chunks");
  }

  if (!tip.trim()) {
    score -= 40;
    flags.push("missing say_aloud_tip");
  }

  const word = normalizeWord(entry.word);
  const tipBody = tip
    .replace(/^Say it slowly:\s*/i, "")
    .replace(/^Sounds like:\s*/i, "");
  const normalizedTip = normalizePronunciation(tipBody);

  for (const chunk of chunks) {
    if (chunk.length >= 8) {
      score -= 12;
      flags.push(`overlong chunk:${chunk}`);
    }

    if (chunk.length >= 5 && !hasVowel(chunk)) {
      score -= 15;
      flags.push(`consonant-heavy chunk:${chunk}`);
    }

    if (/(.)\1\1/i.test(chunk)) {
      score -= 10;
      flags.push(`triple letter run:${chunk}`);
    }

    if (/[aeiouy]{4,}/i.test(chunk)) {
      score -= 12;
      flags.push(`long vowel run:${chunk}`);
    }

    if (/[^A-Za-z-]/.test(chunk)) {
      score -= 8;
      flags.push(`non-letter chars:${chunk}`);
    }

    if (
      /[A-Z].*[A-Z].*[a-z]/.test(chunk) ||
      /[a-z].*[A-Z].*[a-z]/.test(chunk)
    ) {
      score -= 6;
      flags.push(`awkward stress casing:${chunk}`);
    }
  }

  if (chunks.length >= 5 && entry.word.length <= 8) {
    score -= 10;
    flags.push("too many chunks for short word");
  }

  if (chunks.length === 1 && entry.word.length >= 9) {
    score -= 8;
    flags.push("single chunk for long word");
  }

  const editDistance = levenshtein(word, normalizedTip);
  const maxLength = Math.max(word.length, normalizedTip.length, 1);
  const spellingSimilarity = 1 - editDistance / maxLength;
  const irregularLike =
    /(ough|eigh|tion|sion|cious|tious|ph|gh|kn|wr|mb|mn|ps|pn|rh|eu|oi|ou|ow|ea|ie|ei|gui|gue|que|xyl|sci)/.test(
      word,
    );
  if (irregularLike && spellingSimilarity > 0.82) {
    score -= 18;
    flags.push(
      `too close to spelling for irregular word (${spellingSimilarity.toFixed(2)})`,
    );
  }

  if (/oy/i.test(tipBody) && !/(oi|oy)/.test(word)) {
    score -= 14;
    flags.push("oy sound without oi/oy spelling");
  }

  if (
    /(weye|zeye|reye|tey|twey|teye|weyel|tsey|widz|wikp|weyeld|wuhn-der-keyend)/i.test(
      tipBody,
    )
  ) {
    score -= 25;
    flags.push("known awkward respelling pattern");
  }

  if (/^Sounds like:\s*[A-Z]{5,}$/.test(tip)) {
    score -= 12;
    flags.push("all-caps single lump");
  }

  if (/^Say it slowly:\s*[^-]+$/i.test(tip) && entry.word.length >= 8) {
    score -= 8;
    flags.push("long word without chunking in tip");
  }

  if (/([A-Za-z]+-){5,}/.test(tipBody)) {
    score -= 10;
    flags.push("over-segmented tip");
  }

  const vowelPhonemeCount = countVowelPhonemes(phonemes);
  if (Math.abs(chunks.length - vowelPhonemeCount) >= 3) {
    score -= 8;
    flags.push("chunk/phoneme syllable mismatch");
  }

  if (normalizedTip.length <= Math.max(2, Math.floor(word.length / 3))) {
    score -= 10;
    flags.push("tip too compressed");
  }

  const reviewBuckets = getPronunciationReviewBucketNames({
    word: entry.word,
    tip,
  });

  return buildAuditEntry(entry, score, flags, reviewBuckets);
}

export function buildPronunciationReviewBuckets(
  entries: PronunciationAuditEntry[],
): PronunciationReviewBuckets {
  const buckets: PronunciationReviewBuckets = {
    awkward_glide_spellings: [],
    all_caps_single_lump: [],
    over_segmented_long_words: [],
    suspicious_oy_without_oi_oy: [],
    suspicious_eye_spellings: [],
  };

  for (const entry of entries) {
    for (const bucketName of getPronunciationReviewBucketNames(entry)) {
      buckets[bucketName].push(entry);
    }
  }

  return buckets;
}
