import { getOpenAIClient } from "./openaiClient.js";

const DEFAULT_TTS_MODEL = "gpt-4o-mini-tts";
const DEFAULT_TTS_VOICE = "alloy";

const audioCache = new Map<string, Promise<Uint8Array>>();

function isPronunciationCacheEnabled(): boolean {
  return process.env.SPELLING_COACH_AUDIO_CACHE !== "off";
}

function isTtsInstructionEnabled(): boolean {
  return process.env.SPELLING_COACH_TTS_INSTRUCTIONS === "on";
}

function buildCacheKey(text: string, voice: string, instructions?: string): string {
  return [text.toLowerCase(), voice, instructions ?? ""].join("|");
}

export function buildDefaultTtsInstructions(text: string): string | undefined {
  if (!isTtsInstructionEnabled()) {
    return undefined;
  }

  if (/^spell this word:/i.test(text.trim())) {
    return "Read the provided text exactly. Do not omit the target word. Say the word once clearly and naturally.";
  }

  return undefined;
}

export async function generateSpeechAudio(
  text: string,
  options: {
    voice?: string;
    instructions?: string;
  } = {},
): Promise<Uint8Array> {
  const voice = options.voice ?? DEFAULT_TTS_VOICE;
  const cacheKey = buildCacheKey(text, voice, options.instructions);
  const useCache = isPronunciationCacheEnabled();
  const cachedAudio = useCache ? audioCache.get(cacheKey) : undefined;

  if (cachedAudio) {
    return cachedAudio;
  }

  const audioPromise = (async () => {
    const client = getOpenAIClient();
    const instructions =
      options.instructions ?? buildDefaultTtsInstructions(text);
    const response = await client.audio.speech.create({
      model: DEFAULT_TTS_MODEL,
      voice,
      input: text,
      response_format: "mp3",
      instructions,
    });

    const arrayBuffer = await response.arrayBuffer();
    return new Uint8Array(arrayBuffer);
  })();

  if (useCache) {
    audioCache.set(cacheKey, audioPromise);
  }
  return audioPromise;
}

export async function generatePronunciationAudio(
  word: string,
  options: {
    voice?: string;
    instructions?: string;
  } = {},
): Promise<Uint8Array> {
  return generateSpeechAudio(`Spell this word: ${word}.`, options);
}
