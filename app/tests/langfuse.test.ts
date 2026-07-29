import assert from "node:assert/strict";
import test, { mock } from "node:test";

const calls: any[] = [];
let shouldFail = false;
const span = { end: mock.fn() };
const propagateAttributes = mock.fn(async (attributes: any, callback: () => Promise<void>) => {
  calls.push(attributes);
  if (shouldFail) throw new Error("tracing unavailable");
  await callback();
});
const startObservation = mock.fn(() => span);
mock.module("@langfuse/tracing", { namedExports: { propagateAttributes, startObservation } });

const tracing = await import("../langfuse.js");

test.beforeEach(() => { calls.length = 0; shouldFail = false; });

test("records spelling-coach and import traces through mocked Langfuse", async () => {
  await tracing.recordSpellingCoachTrace({
    input: {
      targetWord: "word", childAttempt: "wrd",
      childProfile: { childId: "child", age: 9, grade: "4", spellingLevel: "level_2" },
      sessionContext: { mode: "practice" },
    },
    output: { ok: true }, latencyMs: 12,
  });
  assert.equal(calls[0].userId, "child");
  assert.equal(calls[0].sessionId, "child-practice");
  assert.equal(calls[0].metadata.childAge, "9");

  await tracing.recordImportListTrace({
    user: { id: "id", email: "user@example.com" }, listName: "List", wordCount: 2,
    latencyMs: 3, inputWords: ["one", "two"], outputWords: [{ word: "one" }],
  });
  assert.equal(calls[1].userId, "user@example.com");
  assert.equal(calls[1].metadata.words, "one, two");
  assert.equal(span.end.mock.callCount(), 2);
  assert.equal(tracing.getLangfuseHandler(), undefined);
});

test("trace recording absorbs mocked tracing failures and anonymous input", async () => {
  shouldFail = true;
  const originalError = console.error;
  console.error = () => undefined;
  try {
    await tracing.recordSpellingCoachTrace({ input: {}, output: null, latencyMs: 0 });
    await tracing.recordImportListTrace({
      user: { id: "id", email: null }, listName: "Empty", wordCount: 0,
      latencyMs: 0, inputWords: [], outputWords: [],
    });
  } finally {
    console.error = originalError;
  }
});
