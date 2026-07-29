import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { WordTeachingPrecompute } from "../schemas.js";

let streamCalls = 0;
let invokeCalls = 0;

const directModel = {
  async *stream(_input: unknown, options?: { signal?: AbortSignal }) {
    streamCalls += 1;
    assert.equal(options?.signal instanceof AbortSignal, true);
    yield { content: "[[MISS_ANALYSIS]]Miss.[[END_SECTION]]" };
    yield { content: "[[EXPLANATION]]Explain.[[END_SECTION]]" };
    yield { content: "[[MEMORY_TIP]]Tip.[[END_SECTION]]" };
  },
  async invoke() {
    invokeCalls += 1;
    return "";
  },
};

mock.module(new URL("../directModel.js", import.meta.url).href, {
  namedExports: {
    createDirectSpellingCoachModel: async () => directModel,
    buildDirectRuntimeSystemPrompt: () => "mock-system-prompt",
  },
});

const { streamSpellingCoach } = await import("../streamingCoach.js");

class FakeResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  statusCode = 0;
  headers: Record<string, string> = {};
  chunks: string[] = [];
  socket = { setNoDelay() {} };

  writeHead(statusCode: number, headers: Record<string, string>) {
    this.statusCode = statusCode;
    this.headers = headers;
    return this;
  }

  flushHeaders() {}

  flush() {}

  write(chunk: string) {
    this.chunks.push(chunk);
    return true;
  }

  end() {
    this.writableEnded = true;
    return this;
  }
}

const baseRequest = {
  targetWord: "about",
  childAttempt: "abot",
  level: 1,
  mode: "practice",
  definitionViewed: false,
  exampleViewed: false,
  originViewed: false,
  partOfSpeechViewed: false,
  repeatWordCount: 0,
  usedVoiceInput: false,
};

const precomputed: WordTeachingPrecompute = {
  wordTeaching: {
    conceptTeaching: {
      summary: "summary",
      meaningFocus: "meaning",
      originFocus: "origin",
      morphologyFocus: "morphology",
      originLabels: [],
      morphologyLabels: [],
      relatedForms: [],
    },
  },
  wordBreakdown: {
    displayChunks: ["a", "bout"],
    alternateDisplayChunks: [],
    chunkReason: "two chunks",
    matchedPatterns: [],
  },
  conceptLabels: {
    originLabels: [],
    patternLabels: [],
    morphologyLabels: [],
  },
};

function parseEvents(response: FakeResponse) {
  return response.chunks.map((chunk) => {
    const [eventLine, dataLine] = chunk.trim().split("\n");
    return {
      event: eventLine.slice("event: ".length),
      data: JSON.parse(dataLine.slice("data: ".length)),
    };
  });
}

test("default runtime path streams direct model tokens instead of invoking a full response", async () => {
  streamCalls = 0;
  invokeCalls = 0;
  const response = new FakeResponse();

  await streamSpellingCoach(
    new EventEmitter() as IncomingMessage,
    response as unknown as ServerResponse,
    baseRequest,
    {
      precompute: async () => precomputed,
      requestId: () => "request-default-model-stream",
    },
  );

  assert.equal(streamCalls, 1);
  assert.equal(invokeCalls, 0);
  assert.deepEqual(
    parseEvents(response)
      .filter(({ event }) => event === "section-chunk")
      .map(({ data }) => [data.section, data.text]),
    [
      ["miss_analysis", "Miss."],
      ["explanation", "Explain."],
      ["memory_tip", "Tip."],
    ],
  );
});
