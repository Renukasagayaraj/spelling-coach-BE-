import assert from "node:assert/strict";
import test, { mock } from "node:test";

type Row = {
  id: string;
  user_id: string;
  mode: "mock_bee";
  status: "active" | "completed" | "abandoned";
  session_started_at: string;
  session_ended_at: string | null;
  total_words_attempted: number | null;
  total_correct: number | null;
  duration_seconds: number | null;
  created_at: string;
  session_config: any;
  session_state: any;
};

const rows = new Map<string, Row>();
let nextStartResult: { action: "active_session_conflict"; activeSessionId: string; activeMode: string } | null = null;
const recordedAttempts: unknown[][] = [];

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

let reviewPersisted = deferred<void>();

mock.module(new URL("../supabase.js", import.meta.url).href, {
  namedExports: {
    startMockBeeSessionInDB: async (
      _token: string,
      userId: string,
      config: unknown,
      state: unknown,
    ) => {
      if (nextStartResult) {
        const result = nextStartResult;
        nextStartResult = null;
        return result;
      }
      const id = `session-${rows.size + 1}`;
      const now = new Date().toISOString();
      rows.set(id, {
        id,
        user_id: userId,
        mode: "mock_bee",
        status: "active",
        session_started_at: now,
        session_ended_at: null,
        total_words_attempted: 0,
        total_correct: 0,
        duration_seconds: null,
        created_at: now,
        session_config: config,
        session_state: state,
      });
      return { action: "created", sessionId: id };
    },
    getMockBeeSessionFromDB: async (_token: string, userId: string, id: string) => {
      const row = rows.get(id);
      return row?.user_id === userId ? row : null;
    },
    updateMockBeeSessionInDB: async (
      _token: string,
      userId: string,
      id: string,
      updates: Partial<Row>,
    ) => {
      const row = rows.get(id);
      if (!row || row.user_id !== userId) throw new Error("missing mocked session");
      Object.assign(row, updates);
      const turns = (updates.session_state as { turns?: Array<{ reviewCardStatus?: string }> } | undefined)?.turns;
      if (turns?.some((turn) => turn.reviewCardStatus === "completed" || turn.reviewCardStatus === "failed")) {
        reviewPersisted.resolve();
      }
      return row;
    },
    recordWordAttemptInDB: async (...args: unknown[]) => {
      recordedAttempts.push(args);
      return { id: `attempt-${recordedAttempts.length}` };
    },
  },
});

const { MockBeeService } = await import("../mockBee.js");
type SpellingCoachOutput = import("../schemas.js").SpellingCoachOutput;

const profile = { childId: "child", age: 9, grade: "4", spellingLevel: "level_2" };

function reviewOutput(word: string, correct = false): SpellingCoachOutput {
  return {
    correctness: { isCorrect: correct, reinforceSuccess: correct },
    missAnalysis: {
      summary: "Review the spelling.", primaryErrorType: null, secondaryErrorTypes: [], errorTypeEvidence: {}, primaryErrorFocus: "form",
      likelyWrongWordInterpretation: false, usedMeaningDisambiguationWell: false,
    },
    wordTeaching: {
      conceptTeaching: {
        summary: "summary", meaningFocus: "meaning", originFocus: "origin",
        morphologyFocus: "morphology", originLabels: [], morphologyLabels: [], relatedForms: [],
      },
    },
    errorRelevance: { mostRelevantToError: "form", confidence: 1, reason: "reason" },
    teachingDecision: {
      strategy: "chunking", primaryFocus: "form", secondaryFocuses: [], confidence: 1, rationale: "rationale",
    },
    coachingText: {
      shortFeedback: "feedback", fullExplanation: `Review ${word}.`, memoryTip: "tip", sayAloudTip: `Say ${word}.`,
    },
    wordBreakdown: { displayChunks: [word], alternateDisplayChunks: [], chunkReason: "whole word", matchedPatterns: [] },
    conceptLabels: { originLabels: [], patternLabels: [], morphologyLabels: [] },
    nextStep: { practiceFocus: "form", shouldReviewSoon: !correct, suggestedSimilarWordTypes: [] },
  };
}

async function create(level: "1" | "2" | "3" = "1", service = new MockBeeService(async (word) => reviewOutput(word.word))) {
  const result = await service.createSession("token", "user", {
    level, wordSource: "standard", wordCount: 10, childProfile: profile,
  });
  assert.notEqual(result.action, "active_session_conflict");
  return { service, result: result as Exclude<typeof result, { action: "active_session_conflict" }> };
}

test.beforeEach(() => {
  rows.clear();
  recordedAttempts.length = 0;
  nextStartResult = null;
  reviewPersisted = deferred<void>();
});

test("mock bee creates sanitized challenges with level-specific timers", async () => {
  for (const [level, seconds, countdown, reveal] of [
    ["1", 60, false, true], ["2", 45, true, true], ["3", 30, true, false],
  ] as const) {
    rows.clear();
    const { result } = await create(level);
    assert.equal(result.session.config.timer.secondsPerWord, seconds);
    assert.equal(result.session.config.timer.showCountdown, countdown);
    assert.equal(result.session.config.timer.revealAnswerOnSubmit, reveal);
    assert.equal("word" in (result.session.currentChallenge?.supports ?? {}), false);
    assert.equal(typeof result.session.currentChallenge?.supports.definition, "string");
  }
});

test("mock bee validates create and submit requests before database work", async () => {
  const service = new MockBeeService();
  await assert.rejects(
    service.createSession("token", "user", {
      level: "1", wordSource: "custom_list", wordCount: 10, childProfile: profile,
    } as any),
    /customListId is required/,
  );
  const { result } = await create("1", service);
  await assert.rejects(
    service.submitAttempt("token", "user", result.sessionId, {
      childAttempt: "word", supportsUsed: { unexpected: true },
    } as any),
  );
  assert.equal(recordedAttempts.length, 0);
});

test("mock bee returns conflicts and rejects unknown sessions", async () => {
  nextStartResult = { action: "active_session_conflict", activeSessionId: "other", activeMode: "standard" };
  const service = new MockBeeService();
  const conflict = await service.createSession("token", "user", {
    level: "1", wordSource: "standard", wordCount: 10, childProfile: profile,
  });
  assert.deepEqual(conflict, { action: "active_session_conflict", activeSessionId: "other", activeMode: "standard" });
  await assert.rejects(service.getSession("token", "user", "missing"), /Unknown mock bee session/);
  await assert.rejects(service.getReview("token", "user", "missing"), /Unknown mock bee session/);
  await assert.rejects(service.getInternalSession("token", "user", "missing"), /Unknown mock bee session/);
  await assert.rejects(service.endSession("token", "user", "missing"), /Unknown mock bee session/);
});

test("mock bee submits exact and incorrect attempts and applies answer reveal rules", async () => {
  const levelTwo = await create("2");
  const internal = await levelTwo.service.getInternalSession("token", "user", levelTwo.result.sessionId);
  const correct = await levelTwo.service.submitAttempt("token", "user", levelTwo.result.sessionId, {
    childAttempt: `  ${internal.turns[0].word.word.toUpperCase()}  `,
    supportsUsed: { definitionViewed: true, exampleViewed: false, originViewed: true },
  });
  assert.equal(correct.result.isCorrect, true);
  assert.equal(correct.result.revealAnswer, true);
  assert.equal(correct.result.correctWord, internal.turns[0].word.word);
  assert.equal(correct.session.progress.correctCount, 1);
  assert.equal(recordedAttempts.length, 1);

  rows.clear();
  const levelThree = await create("3");
  const incorrect = await levelThree.service.submitAttempt("token", "user", levelThree.result.sessionId, {
    childAttempt: "definitely-wrong",
  });
  assert.equal(incorrect.result.isCorrect, false);
  assert.equal(incorrect.result.revealAnswer, false);
  assert.equal(incorrect.result.correctWord, undefined);
  assert.equal(incorrect.session.progress.incorrectCount, 1);
});

test("mock bee timeout advances and successful review generation is persisted", async () => {
  const review = deferred<SpellingCoachOutput>();
  const service = new MockBeeService(() => review.promise);
  const { result } = await create("1", service);
  const timedOut = await service.timeoutCurrentWord("token", "user", result.sessionId);
  assert.equal(timedOut.result.timedOut, true);
  assert.equal(timedOut.session.progress.currentTurnNumber, 2);
  review.resolve(reviewOutput("word"));
  await reviewPersisted.promise;
  const reviewResult = await service.getReview("token", "user", result.sessionId);
  assert.equal(reviewResult.words[0]?.status, "timed_out");
  assert.equal(reviewResult.words[0]?.reviewCardStatus, "completed");
  assert.match(reviewResult.words[0]?.reviewCard?.coachingText.sayAloudTip ?? "", /^Say /);
});

test("mock bee records failed review generation and blocks completed rounds", async () => {
  const review = deferred<SpellingCoachOutput>();
  const service = new MockBeeService(() => review.promise);
  const created = await create("1", service);
  await service.timeoutCurrentWord("token", "user", created.result.sessionId);
  review.reject("review unavailable");
  await reviewPersisted.promise;
  const reviewResult = await service.getReview("token", "user", created.result.sessionId);
  assert.equal(reviewResult.words[0]?.reviewCardStatus, "failed");
  assert.equal(reviewResult.words[0]?.reviewError, "review unavailable");

  const row = rows.get(created.result.sessionId)!;
  row.status = "completed";
  row.session_state.status = "completed";
  await assert.rejects(
    service.submitAttempt("token", "user", created.result.sessionId, { childAttempt: "word" }),
    /already completed/,
  );
  await assert.rejects(
    service.timeoutCurrentWord("token", "user", created.result.sessionId),
    /already completed/,
  );
});

test("mock bee ends active sessions and returns already-ended sessions unchanged", async () => {
  const { service, result } = await create();
  const ended = await service.endSession("token", "user", result.sessionId);
  assert.equal(ended.status, "completed");
  assert.equal(rows.get(result.sessionId)?.status, "abandoned");
  const again = await service.endSession("token", "user", result.sessionId);
  assert.equal(again.status, "completed");
});
