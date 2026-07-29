import assert from "node:assert/strict";
import test, { mock } from "node:test";

const requests: any[] = [];
let failure: Error | null = null;
const getOpenAIClient = mock.fn(() => ({
  audio: {
    speech: {
      create: async (request: any) => {
        requests.push(request);
        if (failure) throw failure;
        return { arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer };
      },
    },
  },
}));

mock.module(new URL("../openaiClient.js", import.meta.url).href, { namedExports: { getOpenAIClient } });
const pronunciation = await import("../pronunciation.js");

test.beforeEach(() => {
  requests.length = 0;
  failure = null;
  delete process.env.SPELLING_COACH_TTS_INSTRUCTIONS;
  process.env.SPELLING_COACH_AUDIO_CACHE = "off";
});

test("speech generation calls the mocked OpenAI TTS client with defaults and overrides", async () => {
  assert.deepEqual([...await pronunciation.generateSpeechAudio("hello")], [1, 2, 3]);
  assert.deepEqual(requests[0], {
    model: "gpt-4o-mini-tts", voice: "alloy", input: "hello", response_format: "mp3", instructions: undefined,
  });
  await pronunciation.generatePronunciationAudio("rhythm", { voice: "nova", instructions: "exact" });
  assert.equal(requests[1].input, "Spell this word: rhythm.");
  assert.equal(requests[1].voice, "nova");
  assert.equal(requests[1].instructions, "exact");
});

test("speech generation caches successful promises when enabled", async () => {
  process.env.SPELLING_COACH_AUDIO_CACHE = "on";
  const first = pronunciation.generateSpeechAudio("cache me", { voice: "echo" });
  const second = pronunciation.generateSpeechAudio("cache me", { voice: "echo" });
  await Promise.all([first, second]);
  assert.equal(requests.length, 1);
});

test("TTS instructions cover disabled, ordinary, and non-word text", () => {
  assert.equal(pronunciation.buildDefaultTtsInstructions("Spell this word: test."), undefined);
  process.env.SPELLING_COACH_TTS_INSTRUCTIONS = "on";
  assert.match(pronunciation.buildDefaultTtsInstructions("Spell this word: test.") ?? "", /Read the provided text exactly/);
  assert.equal(pronunciation.buildDefaultTtsInstructions("Say a sentence"), undefined);
  assert.equal(pronunciation.buildDefaultTtsInstructions("Spell this word:"), undefined);
});

test("speech generation propagates mocked OpenAI failures", async () => {
  failure = new Error("TTS unavailable");
  await assert.rejects(pronunciation.generateSpeechAudio("fail"), /TTS unavailable/);
});
