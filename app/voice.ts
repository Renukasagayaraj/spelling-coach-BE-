import { z } from "zod";
import { getOpenAIClient } from "./openaiClient.js";
import { generatePronunciationAudio, generateSpeechAudio } from "./pronunciation.js";
import { getWordByText } from "./wordCatalog.js";

export const VoiceRespondRequestSchema = z
  .object({
    targetWord: z.string().min(1),
    utterance: z.string().min(1),
    includeAudio: z.boolean().optional(),
  })
  .strict();

export const VoiceInterpretRequestSchema = z
  .object({
    targetWord: z.string().min(1),
    utterance: z.string().min(1),
  })
  .strict();

export type VoiceIntent =
  | "repeat_word"
  | "example_sentence"
  | "definition"
  | "origin"
  | "part_of_speech"
  | "spelling_attempt"
  | "unknown";

export type VoiceInterpretation =
  | {
      intent: "spelling_attempt";
      confidence: number;
      normalizedUtterance: string;
      parsedAttempt: string;
      displayText: string;
      shouldAutoSubmit: false;
    }
  | {
      intent:
        | "repeat_word"
        | "example_sentence"
        | "definition"
        | "origin"
        | "part_of_speech";
      confidence: number;
      normalizedUtterance: string;
      spokenText: string;
      displayText: string;
    }
  | {
      intent: "unknown";
      confidence: number;
      normalizedUtterance: string;
      displayText: string;
    };

const LETTER_TOKEN_MAP = new Map<string, string>([
  ["a", "a"],
  ["ay", "a"],
  ["b", "b"],
  ["be", "b"],
  ["bee", "b"],
  ["c", "c"],
  ["cee", "c"],
  ["see", "c"],
  ["sea", "c"],
  ["d", "d"],
  ["dee", "d"],
  ["e", "e"],
  ["ee", "e"],
  ["f", "f"],
  ["ef", "f"],
  ["eff", "f"],
  ["g", "g"],
  ["gee", "g"],
  ["h", "h"],
  ["aitch", "h"],
  ["haitch", "h"],
  ["i", "i"],
  ["eye", "i"],
  ["j", "j"],
  ["jay", "j"],
  ["k", "k"],
  ["kay", "k"],
  ["l", "l"],
  ["el", "l"],
  ["ell", "l"],
  ["m", "m"],
  ["em", "m"],
  ["n", "n"],
  ["en", "n"],
  ["o", "o"],
  ["oh", "o"],
  ["p", "p"],
  ["pee", "p"],
  ["pea", "p"],
  ["q", "q"],
  ["cue", "q"],
  ["queue", "q"],
  ["r", "r"],
  ["ar", "r"],
  ["are", "r"],
  ["s", "s"],
  ["ess", "s"],
  ["t", "t"],
  ["tee", "t"],
  ["tea", "t"],
  ["u", "u"],
  ["you", "u"],
  ["v", "v"],
  ["vee", "v"],
  ["w", "w"],
  ["doubleu", "w"],
  ["double-u", "w"],
  ["doubleyou", "w"],
  ["x", "x"],
  ["ex", "x"],
  ["y", "y"],
  ["why", "y"],
  ["z", "z"],
  ["zee", "z"],
  ["zed", "z"],
]);

const SUPPORT_PATTERNS: Array<{
  intent: Exclude<VoiceIntent, "spelling_attempt" | "unknown">;
  patterns: RegExp[];
}> = [
  {
    intent: "repeat_word",
    patterns: [
      /\bcan i have the word(?: please)?\b/,
      /\bhave the word(?: please)?\b/,
      /\bsay (it|the word) again\b/,
      /\bsay the word\b/,
      /\btell the word again\b/,
      /\btell the word\b/,
      /\btell me the word again\b/,
      /\btell me the word\b/,
      /\bwhat(?:'s|s| is) the wor(?:d|ld) again\b/,
      /\bwhat(?:'s|s| is) the wor(?:d|ld)\b/,
      /\brepeat (it|the word)\b/,
      /\bpronounce (it|the word)\b/,
      /\bhear it again\b/,
      /\bsay it\b/,
    ],
  },
  {
    intent: "example_sentence",
    patterns: [
      /\buse it in a sentence\b/,
      /\bsentence\b/,
      /\bcan you use it in a sentence\b/,
      /\bgive me a sentence\b/,
    ],
  },
  {
    intent: "definition",
    patterns: [
      /\bdefinition\b/,
      /\bwhat does it mean\b/,
      /\bwhat is the definition\b/,
      /\bmeaning\b/,
    ],
  },
  {
    intent: "origin",
    patterns: [
      /\borigin\b/,
      /\blanguage of origin\b/,
      /\bwhere does it come from\b/,
      /\bwhat language\b/,
    ],
  },
  {
    intent: "part_of_speech",
    patterns: [
      /\bpart of speech\b/,
      /\bis it a noun\b/,
      /\bis it a verb\b/,
      /\bis it an adjective\b/,
      /\bis it an adverb\b/,
    ],
  },
];

function normalizeUtterance(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[.,!?;:]+/g, " ")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeUtterance(value: string): string[] {
  return normalizeUtterance(value).split(" ").filter(Boolean);
}

function maybeParseLetterToken(token: string): string | null {
  return LETTER_TOKEN_MAP.get(token) ?? null;
}

export function normalizeSpokenSpelling(utterance: string): {
  parsedAttempt: string;
  confidence: number;
} | null {
  const tokens = tokenizeUtterance(utterance);
  if (tokens.length === 0) {
    return null;
  }

  const letters: string[] = [];
  let recognizedTokenCount = 0;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "double") {
      const nextToken = tokens[index + 1];
      const nextLetter = nextToken ? maybeParseLetterToken(nextToken) : null;
      if (nextLetter) {
        letters.push(nextLetter, nextLetter);
        recognizedTokenCount += 2;
        index += 1;
        continue;
      }
    }

    const letter = maybeParseLetterToken(token);
    if (letter) {
      letters.push(letter);
      recognizedTokenCount += 1;
      continue;
    }
  }

  if (letters.length < 2) {
    return null;
  }

  const confidence = recognizedTokenCount / tokens.length;
  if (confidence < 0.6) {
    return null;
  }

  return {
    parsedAttempt: letters.join(""),
    confidence,
  };
}

function detectSupportIntent(normalizedUtterance: string): {
  intent: Exclude<VoiceIntent, "spelling_attempt" | "unknown">;
  confidence: number;
} | null {
  for (const candidate of SUPPORT_PATTERNS) {
    if (candidate.patterns.some((pattern) => pattern.test(normalizedUtterance))) {
      return { intent: candidate.intent, confidence: 0.95 };
    }
  }

  return null;
}

function normalizeAlphabeticAttempt(value: string): string | null {
  const collapsed = value.replace(/\s+/g, "");
  if (!/^[a-z]{2,8}$/.test(collapsed)) {
    return null;
  }

  return collapsed;
}

function normalizeTargetWord(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z]/g, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function maskTargetWordInUtterance(
  normalizedUtterance: string,
  targetWord: string,
): string {
  const normalizedTarget = normalizeTargetWord(targetWord);
  if (!normalizedTarget) {
    return normalizedUtterance;
  }

  return normalizedUtterance.replace(
    new RegExp(`\\b${escapeRegExp(normalizedTarget)}\\b`, "g"),
    "the challenge word",
  );
}

function normalizeSupportIntentUtterance(
  normalizedUtterance: string,
  targetWord: string,
): string {
  const normalizedTarget = normalizeTargetWord(targetWord);
  if (!normalizedTarget) {
    return normalizedUtterance;
  }

  return normalizedUtterance.replace(
    new RegExp(`\\b${escapeRegExp(normalizedTarget)}\\b`, "g"),
    "it",
  );
}

function recoverCollapsedSpellingAttempt(
  normalizedUtterance: string,
  targetWord: string,
): {
  parsedAttempt: string;
  confidence: number;
} | null {
  const attempt = normalizeAlphabeticAttempt(normalizedUtterance);
  if (!attempt) {
    return null;
  }

  const normalizedTarget = normalizeTargetWord(targetWord);
  if (!normalizedTarget) {
    return null;
  }

  if (attempt === normalizedTarget) {
    return null;
  }

  if (attempt.length > normalizedTarget.length + 1) {
    return null;
  }

  return {
    parsedAttempt: attempt,
    confidence: 0.72,
  };
}

function buildSupportResponse(
  intent: Exclude<VoiceIntent, "spelling_attempt" | "unknown">,
  targetWord: string,
): { spokenText: string } {
  const wordEntry = getWordByText(targetWord);
  if (!wordEntry) {
    throw new Error(`Unknown target word: ${targetWord}`);
  }

  switch (intent) {
    case "repeat_word":
      return {
        spokenText: `Spell this word: ${wordEntry.word}.`,
      };
    case "example_sentence":
      return {
        spokenText: wordEntry.example_sentence,
      };
    case "definition":
      return {
        spokenText: wordEntry.definition,
      };
    case "origin":
      return {
        spokenText: `The word comes from ${wordEntry.origin}.`,
      };
    case "part_of_speech":
      return {
        spokenText: `It is a ${wordEntry.part_of_speech}.`,
      };
  }
}

export function interpretVoiceUtterance(
  targetWord: string,
  utterance: string,
): VoiceInterpretation {
  if (!getWordByText(targetWord)) {
    throw new Error(`Unknown target word: ${targetWord}`);
  }

  const normalizedUtterance = normalizeUtterance(utterance);
  const normalizedTarget = normalizeTargetWord(targetWord);

  if (normalizedUtterance === normalizedTarget) {
    return {
      intent: "unknown",
      confidence: 0.95,
      normalizedUtterance,
      displayText: "Sorry, I can't spell it for you.",
    };
  }

  const supportIntent = detectSupportIntent(
    normalizeSupportIntentUtterance(normalizedUtterance, targetWord),
  );
  if (supportIntent) {
    const supportResponse = buildSupportResponse(supportIntent.intent, targetWord);
    return {
      intent: supportIntent.intent,
      confidence: supportIntent.confidence,
      normalizedUtterance,
      spokenText: supportResponse.spokenText,
      displayText: maskTargetWordInUtterance(normalizedUtterance, targetWord),
    };
  }

  const spokenSpelling = normalizeSpokenSpelling(normalizedUtterance);
  if (spokenSpelling) {
    return {
      intent: "spelling_attempt",
      confidence: spokenSpelling.confidence,
      normalizedUtterance,
      parsedAttempt: spokenSpelling.parsedAttempt,
      displayText: spokenSpelling.parsedAttempt,
      shouldAutoSubmit: false,
    };
  }

  const collapsedSpelling = recoverCollapsedSpellingAttempt(
    normalizedUtterance,
    targetWord,
  );
  if (collapsedSpelling) {
    return {
      intent: "spelling_attempt",
      confidence: collapsedSpelling.confidence,
      normalizedUtterance,
      parsedAttempt: collapsedSpelling.parsedAttempt,
      displayText: collapsedSpelling.parsedAttempt,
      shouldAutoSubmit: false,
    };
  }

  return {
    intent: "unknown",
    confidence: 0.2,
    normalizedUtterance,
    displayText: "I did not catch that. Ask for a hint or spell the word out loud.",
  };
}

export async function buildVoiceResponse(
  targetWord: string,
  utterance: string,
  includeAudio = true,
): Promise<
  VoiceInterpretation & {
    audioBase64?: string;
    audioMimeType?: "audio/mpeg";
  }
> {
  const interpreted = interpretVoiceUtterance(targetWord, utterance);
  if (
    interpreted.intent === "unknown" ||
    interpreted.intent === "spelling_attempt" ||
    !includeAudio
  ) {
    return interpreted;
  }

  const audio =
    interpreted.intent === "repeat_word"
      ? await generatePronunciationAudio(targetWord)
      : await generateSpeechAudio(interpreted.spokenText, {
          instructions:
            "Read the answer clearly and naturally for a child in a spelling practice activity.",
        });

  return {
    ...interpreted,
    audioBase64: Buffer.from(audio).toString("base64"),
    audioMimeType: "audio/mpeg",
  };
}

export async function transcribeAudio(
  audio: Uint8Array,
  mimeType = "audio/webm",
  fileName = "voice.webm",
): Promise<string> {
  const openai = getOpenAIClient();
  const file = new File([audio], fileName, { type: mimeType });
  const transcription = await openai.audio.transcriptions.create({
    file,
    model: "gpt-4o-mini-transcribe",
  });

  return transcription.text.trim();
}
