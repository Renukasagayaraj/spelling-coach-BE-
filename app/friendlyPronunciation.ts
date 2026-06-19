import { getWordByText } from "./wordCatalog.js";
import { getSoundAwareMatchedPatterns } from "./soundAwarePatterns.js";

type SyllablePart = {
  text: string;
  stressed: boolean;
};

const VOWELS = new Set([
  "AA",
  "AE",
  "AH",
  "AO",
  "AW",
  "AY",
  "EH",
  "ER",
  "EY",
  "IH",
  "IY",
  "OW",
  "OY",
  "UH",
  "UW",
]);

const COMMON_ONSETS = new Set([
  "BL",
  "BR",
  "CH",
  "CL",
  "CR",
  "DR",
  "FL",
  "FR",
  "GL",
  "GR",
  "KL",
  "KR",
  "PH",
  "PL",
  "PR",
  "SC",
  "SH",
  "SK",
  "SL",
  "SM",
  "SN",
  "SP",
  "ST",
  "SW",
  "TH",
  "THR",
  "TR",
  "TW",
  "WH",
]);

const CONSONANT_MAP: Record<string, string> = {
  B: "b",
  CH: "ch",
  D: "d",
  DH: "th",
  F: "f",
  G: "g",
  HH: "h",
  JH: "j",
  K: "k",
  L: "l",
  M: "m",
  N: "n",
  NG: "ng",
  P: "p",
  R: "r",
  S: "s",
  SH: "sh",
  T: "t",
  TH: "th",
  V: "v",
  W: "w",
  Y: "y",
  Z: "z",
  ZH: "zh",
};

const CONSONANT_CLUSTER_PATTERN =
  /([bcdfghjklmnpqrstvwxyz]{1,5})eye([bcdfghjklmnpqrstvwxyz]{0,5})/g;

function normalize(phoneme: string): { base: string; stress: string } {
  const match = phoneme.trim().toUpperCase().match(/^([A-Z]+)([0-2]?)$/);
  if (!match) {
    return { base: phoneme.trim().toUpperCase(), stress: "" };
  }

  return { base: match[1]!, stress: match[2] ?? "" };
}

function isVowelPhoneme(phoneme: string): boolean {
  return VOWELS.has(normalize(phoneme).base);
}

function mapVowel(base: string, stress: string): string {
  switch (base) {
    case "AA":
      return "ah";
    case "AE":
      return "a";
    case "AH":
      return stress === "0" ? "uh" : "uh";
    case "AO":
      return "aw";
    case "AW":
      return "ow";
    case "AY":
      return "eye";
    case "EH":
      return "e";
    case "ER":
      return stress === "0" ? "er" : "er";
    case "EY":
      return "ay";
    case "IH":
      return "i";
    case "IY":
      return "ee";
    case "OW":
      return "oh";
    case "OY":
      return "oy";
    case "UH":
      return "u";
    case "UW":
      return "oo";
    default:
      return base.toLowerCase();
  }
}

function mapConsonant(base: string): string {
  return CONSONANT_MAP[base] ?? base.toLowerCase();
}

function splitBetweenVowels(consonants: string[]): number {
  if (consonants.length <= 1) {
    return 0;
  }

  if (consonants.length === 2) {
    return COMMON_ONSETS.has(consonants.join("")) ? 0 : 1;
  }

  const triple = consonants.join("");
  if (COMMON_ONSETS.has(triple)) {
    return 0;
  }

  const tail = consonants.slice(1).join("");
  if (COMMON_ONSETS.has(tail)) {
    return 1;
  }

  return consonants.length - 1;
}

function syllabify(phonemes: string[]): Array<{ phonemes: string[]; stressed: boolean }> {
  const normalized = phonemes.map(normalize);
  const vowelIndexes = normalized
    .map((item, index) => ({ ...item, index }))
    .filter((item) => VOWELS.has(item.base));

  if (vowelIndexes.length === 0) {
    return [];
  }

  const syllables: Array<{ phonemes: string[]; stressed: boolean }> = [];
  let start = 0;

  for (let vowelPosition = 0; vowelPosition < vowelIndexes.length; vowelPosition += 1) {
    const currentVowel = vowelIndexes[vowelPosition]!;
    const nextVowel = vowelIndexes[vowelPosition + 1];

    if (!nextVowel) {
      syllables.push({
        phonemes: normalized.slice(start).map((item) => `${item.base}${item.stress}`),
        stressed: currentVowel.stress === "1",
      });
      break;
    }

    const between = normalized.slice(currentVowel.index + 1, nextVowel.index);
    const splitOffset = splitBetweenVowels(between.map((item) => item.base));
    const end = currentVowel.index + 1 + splitOffset;

    syllables.push({
      phonemes: normalized.slice(start, end).map((item) => `${item.base}${item.stress}`),
      stressed: currentVowel.stress === "1",
    });
    start = end;
  }

  return syllables;
}

function renderSyllable(phonemes: string[]): string {
  return phonemes
    .map((phoneme) => {
      const { base, stress } = normalize(phoneme);
      return isVowelPhoneme(phoneme)
        ? mapVowel(base, stress)
        : mapConsonant(base);
    })
    .join("");
}

function simplifyRenderedChunk(text: string): string {
  return text
    .toLowerCase()
    .replace(CONSONANT_CLUSTER_PATTERN, (_match, onset, coda) => {
      return `${onset}y${coda}`;
    });
}

export function deriveFriendlyPronunciation(phonemes: string[]): string | null {
  const chunks = deriveFriendlyPronunciationChunks(phonemes);
  if (chunks.length === 0) {
    return null;
  }

  return chunks.join("-");
}

export function deriveFriendlyPronunciationChunks(phonemes: string[]): string[] {
  if (phonemes.length === 0) {
    return [];
  }

  const syllables = syllabify(phonemes);
  if (syllables.length === 0) {
    return [];
  }

  const parts: SyllablePart[] = syllables.map((syllable) => ({
    text: simplifyRenderedChunk(renderSyllable(syllable.phonemes)),
    stressed: syllable.stressed,
  }));

  if (parts.length === 1) {
    return parts.map((part) => part.text).filter(Boolean);
  }

  return parts
    .map((part) => (part.stressed ? part.text.toUpperCase() : part.text))
    .filter(Boolean);
}

export function buildFriendlyPronunciationCueFromChunks(chunks: string[]): string | null {
  if (chunks.length === 0) {
    return null;
  }

  if (chunks.length === 1) {
    return `Sounds like: ${chunks[0]}`;
  }

  return `Say it slowly: ${chunks.join("-")}`;
}

function hasNormalizedPhoneme(
  phonemes: string[],
  phoneme: string,
): boolean {
  return phonemes.some((value) => normalize(value).base === phoneme);
}

function hasAdjacentNormalizedPhonemes(
  phonemes: string[],
  left: string,
  right: string,
): boolean {
  for (let index = 0; index < phonemes.length - 1; index += 1) {
    if (
      normalize(phonemes[index]!).base === left &&
      normalize(phonemes[index + 1]!).base === right
    ) {
      return true;
    }
  }

  return false;
}

function getSilentLetterNote(label: string): string | null {
  const match = label.match(/^silent ([a-z]+) \(phoneme-validated\)$/i);
  if (!match) {
    return null;
  }

  return `The ${match[1]!.toLowerCase()} is silent here.`;
}

function getExpectedLongVowelPhonemes(vowel: string): string[] {
  switch (vowel) {
    case "a":
      return ["EY"];
    case "i":
      return ["AY"];
    case "o":
      return ["OW"];
    case "u":
      return ["UW"];
    default:
      return [];
  }
}

function buildSilentENote(word: string, phonemes: string[]): string | null {
  const match = word.match(/([aeiou])[^aeiouy]+e$/i);
  if (!match) {
    return null;
  }

  const vowel = match[1]!.toLowerCase();
  const expected = getExpectedLongVowelPhonemes(vowel);
  if (expected.length === 0) {
    return null;
  }

  const saysName =
    expected.some((phoneme) => hasNormalizedPhoneme(phonemes, phoneme)) ||
    hasAdjacentNormalizedPhonemes(phonemes, "Y", "UW");

  if (saysName) {
    return `The final e helps the ${vowel} say its name.`;
  }

  return `The final e is there, but the ${vowel} does not say its name.`;
}

export function buildSoundAwareTipNote(
  targetWord: string,
  phonemes: string[],
): string | null {
  const word = targetWord.trim().toLowerCase();
  if (!word || phonemes.length === 0) {
    return null;
  }

  const patterns = getSoundAwareMatchedPatterns(word, phonemes);

  if (word.includes("ph") && hasNormalizedPhoneme(phonemes, "F")) {
    return "The ph makes the f sound.";
  }

  if (word.includes("gh") && hasNormalizedPhoneme(phonemes, "F")) {
    return "The gh makes the f sound.";
  }

  for (const pattern of patterns) {
    const silentLetterNote = getSilentLetterNote(pattern.label);
    if (silentLetterNote) {
      return silentLetterNote;
    }
  }

  return buildSilentENote(word, phonemes);
}

export function buildStoredSayAloudTip(
  targetWord: string,
  phonemes: string[],
  chunks = deriveFriendlyPronunciationChunks(phonemes),
): string | null {
  const baseCue = buildFriendlyPronunciationCueFromChunks(chunks);
  if (!baseCue) {
    return null;
  }

  const note = buildSoundAwareTipNote(targetWord, phonemes);
  if (!note) {
    return baseCue;
  }

  const punctuatedBaseCue = /[.!?]$/.test(baseCue) ? baseCue : `${baseCue}.`;
  return `${punctuatedBaseCue}\n${note}`;
}

export function buildFriendlyPronunciationCueFromPhonemes(
  phonemes: string[],
): string | null {
  return buildFriendlyPronunciationCueFromChunks(
    deriveFriendlyPronunciationChunks(phonemes),
  );
}

export function getFriendlyPronunciationCue(targetWord: string): string | null {
  const word = getWordByText(targetWord);
  if (!word?.phoneme_metadata) {
    return null;
  }

  if (word.phoneme_metadata.say_aloud_tip?.trim()) {
    return word.phoneme_metadata.say_aloud_tip.trim();
  }

  if (word.phoneme_metadata.friendly_chunks.length > 0) {
    return (
      buildStoredSayAloudTip(
        targetWord,
        word.phoneme_metadata.phonemes,
        word.phoneme_metadata.friendly_chunks,
      ) ??
      buildFriendlyPronunciationCueFromChunks(
        word.phoneme_metadata.friendly_chunks,
      )
    );
  }

  return (
    buildStoredSayAloudTip(targetWord, word.phoneme_metadata.phonemes) ??
    buildFriendlyPronunciationCueFromPhonemes(word.phoneme_metadata.phonemes)
  );
}
