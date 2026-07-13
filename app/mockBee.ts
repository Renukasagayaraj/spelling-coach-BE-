import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  buildSpellingCoachInputFromWordEntry,
  buildWordPrecomputeInputFromWordEntry,
  buildWordResponse,
} from "./inputBuilder.js";
import { hasWordTeachingPrecompute, runSplitSpellingCoachAgent, warmWordTeachingPrecompute } from "./optimizedCoach.js";
import { runSpellingCoachAgent } from "./runAgent.js";
import type { ChildProfileSchema, SpellingCoachOutput } from "./schemas.js";
import type { WordEntry, SupportedLevel } from "./wordCatalog.js";
import { pickNextWord } from "./wordCatalog.js";
import type { DBMockBeeSessionRow } from "./supabase.js";
import {
  startMockBeeSessionInDB,
  getMockBeeSessionFromDB,
  updateMockBeeSessionInDB,
  recordWordAttemptInDB,
} from "./supabase.js";

const MockBeeCreateRequestSchema = z
  .object({
    level: z.enum(["1", "2", "3"]),
    wordSource: z.enum(["standard", "custom_list"]),
    customListId: z.string().optional(),
    wordCount: z.union([z.literal(10), z.literal(20), z.literal(30)]),
    forceCloseCurrent: z.boolean().optional(),
    childProfile: z.object({
      childId: z.string(),
      age: z.number().int().nonnegative(),
      grade: z.string(),
      spellingLevel: z.string(),
    }),
  })
  .superRefine((value, context) => {
    if (value.wordSource === "custom_list" && !value.customListId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "customListId is required when wordSource is custom_list.",
        path: ["customListId"],
      });
    }
  });

const MockBeeSupportsUsedSchema = z
  .object({
    definitionViewed: z.boolean().optional(),
    exampleViewed: z.boolean().optional(),
    originViewed: z.boolean().optional(),
  })
  .strict();

const MockBeeSubmitRequestSchema = z
  .object({
    childAttempt: z.string(),
    supportsUsed: MockBeeSupportsUsedSchema.optional(),
  })
  .strict();

export type MockBeeCreateRequest = z.infer<typeof MockBeeCreateRequestSchema>;
export type MockBeeSubmitRequest = z.infer<typeof MockBeeSubmitRequestSchema>;
export type MockBeeSupportsUsed = z.infer<typeof MockBeeSupportsUsedSchema>;
export type MockBeeChildProfile = z.infer<typeof ChildProfileSchema>;

export type MockBeeReviewCardStatus = "not_started" | "pending" | "completed" | "failed";
export type MockBeeTurnStatus = "pending" | "submitted" | "timed_out";
export type MockBeeSessionStatus = "active" | "completed";

type MockBeeTurn = {
  index: number;
  word: WordEntry;
  status: MockBeeTurnStatus;
  childAttempt?: string;
  supportsUsed?: MockBeeSupportsUsed;
  isCorrect?: boolean;
  answeredAt?: string;
  reviewCardStatus: MockBeeReviewCardStatus;
  reviewCard?: SpellingCoachOutput;
  reviewError?: string;
};

export type MockBeeSession = {
  id: string;
  createdAt: string;
  updatedAt: string;
  ownerUserId?: string;
  config: {
    level: SupportedLevel;
    wordSource: "standard" | "custom_list";
    customListId?: string;
    wordCount: 10 | 20 | 30;
  };
  childProfile: MockBeeChildProfile;
  turns: MockBeeTurn[];
  currentTurnIndex: number;
  status: MockBeeSessionStatus;
};

type MockBeeReviewGenerator = (
  word: WordEntry,
  session: MockBeeSession,
  turn: MockBeeTurn,
) => Promise<SpellingCoachOutput>;

function buildLevelRules(level: SupportedLevel) {
  if (level === "1") {
    return {
      secondsPerWord: 60,
      showCountdown: false,
      readyPromptAtElapsedSeconds: 45,
      revealAnswerOnSubmit: true,
    };
  }

  if (level === "2") {
    return {
      secondsPerWord: 45,
      showCountdown: true,
      readyPromptAtElapsedSeconds: undefined,
      revealAnswerOnSubmit: true,
    };
  }

  return {
    secondsPerWord: 30,
    showCountdown: true,
    readyPromptAtElapsedSeconds: undefined,
    revealAnswerOnSubmit: false,
  };
}

function normalizeAttempt(value: string): string {
  return value.trim().toLowerCase();
}

function isExactMatch(word: string, attempt: string): boolean {
  return normalizeAttempt(word) === normalizeAttempt(attempt);
}

function buildChallengeWord(word: WordEntry) {
  const publicWord = buildWordResponse(word);
  return {
    definition: publicWord.definition,
    exampleSentence: publicWord.exampleSentence,
    origin: publicWord.origin,
    partOfSpeech: publicWord.partOfSpeech,
    gradeBand: publicWord.gradeBand,
    difficulty: publicWord.difficulty,
    level: publicWord.level,
  };
}

function buildProgress(session: MockBeeSession) {
  const answeredTurns = session.turns.filter((turn) => turn.status !== "pending");
  return {
    totalWords: session.turns.length,
    currentTurnNumber:
      session.status === "completed"
        ? session.turns.length
        : Math.min(session.currentTurnIndex + 1, session.turns.length),
    answeredCount: answeredTurns.length,
    correctCount: answeredTurns.filter((turn) => turn.isCorrect).length,
    incorrectCount: answeredTurns.filter(
      (turn) => turn.status === "submitted" && turn.isCorrect === false,
    ).length,
    timedOutCount: answeredTurns.filter((turn) => turn.status === "timed_out").length,
  };
}

function buildCurrentChallenge(session: MockBeeSession) {
  if (session.status !== "active") {
    return null;
  }

  const turn = session.turns[session.currentTurnIndex];
  const rules = buildLevelRules(session.config.level);

  return {
    turnIndex: turn.index,
    turnNumber: turn.index + 1,
    timer: rules,
    supports: buildChallengeWord(turn.word),
  };
}

function buildSessionView(session: MockBeeSession) {
  return {
    id: session.id,
    status: session.status,
    config: {
      ...session.config,
      timer: buildLevelRules(session.config.level),
    },
    progress: buildProgress(session),
    currentChallenge: buildCurrentChallenge(session),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function buildResultPayload(
  session: MockBeeSession,
  turn: MockBeeTurn,
  timedOut: boolean,
) {
  const rules = buildLevelRules(session.config.level);
  return {
    turnIndex: turn.index,
    turnNumber: turn.index + 1,
    isCorrect: Boolean(turn.isCorrect),
    timedOut,
    revealAnswer: rules.revealAnswerOnSubmit,
    correctWord: rules.revealAnswerOnSubmit ? turn.word.word : undefined,
  };
}

function buildReviewView(session: MockBeeSession) {
  const reviewCounts = session.turns.reduce(
    (counts, turn) => {
      counts[turn.reviewCardStatus] += 1;
      return counts;
    },
    {
      not_started: 0,
      pending: 0,
      completed: 0,
      failed: 0,
    } satisfies Record<MockBeeReviewCardStatus, number>,
  );

  return {
    id: session.id,
    status: session.status,
    progress: buildProgress(session),
    reviewStatus: reviewCounts,
    words: session.turns.map((turn) => ({
      turnIndex: turn.index,
      turnNumber: turn.index + 1,
      word: turn.word.word,
      status: turn.status,
      childAttempt: turn.childAttempt ?? "",
      isCorrect: Boolean(turn.isCorrect),
      reviewCardStatus: turn.reviewCardStatus,
      reviewCard: turn.reviewCard,
      reviewError: turn.reviewError,
      supports: buildChallengeWord(turn.word),
    })),
  };
}

async function defaultReviewGenerator(
  word: WordEntry,
  session: MockBeeSession,
  turn: MockBeeTurn,
): Promise<SpellingCoachOutput> {
  const input = buildSpellingCoachInputFromWordEntry(word, {
    targetWord: word.word,
    childAttempt: turn.childAttempt ?? "",
    childProfile: session.childProfile,
    supportsUsed: turn.supportsUsed,
    sessionContext: {
      mode: "mock_bee_review",
      previousAttemptsOnThisWord: 0,
      previousMissPatterns: [],
      recentlyPracticedWords: session.turns
        .slice(0, turn.index)
        .map((entry) => entry.word.word),
    },
  });

  const precomputeInput = buildWordPrecomputeInputFromWordEntry(word);
  void warmWordTeachingPrecompute(precomputeInput).catch(() => undefined);

  return hasWordTeachingPrecompute(input)
    ? runSplitSpellingCoachAgent(input)
    : runSpellingCoachAgent(input);
}

async function pickWordsForSession(
  request: MockBeeCreateRequest,
  ownerUserId?: string,
  customWordsFallback?: WordEntry[],
): Promise<WordEntry[]> {
  const selected: WordEntry[] = [];
  const excluded: string[] = [];

  for (let index = 0; index < request.wordCount; index += 1) {
    const next = pickNextWord(
      request.wordSource === "standard" ? request.level : undefined,
      excluded,
      request.wordSource === "custom_list" ? request.customListId : undefined,
      undefined,
      ownerUserId,
      customWordsFallback,
    );
    selected.push(next);
    excluded.push(next.word);
  }

  return selected;
}

function buildMockBeeSessionConfig(session: MockBeeSession) {
  return {
    level: session.config.level,
    wordSource: session.config.wordSource,
    customListId: session.config.customListId,
    wordCount: session.config.wordCount,
    childProfile: session.childProfile,
    words: session.turns.map((turn) => turn.word),
  };
}

function buildMockBeeSessionState(session: MockBeeSession) {
  return {
    status: session.status,
    currentTurnIndex: session.currentTurnIndex,
    turns: session.turns,
    updatedAt: session.updatedAt,
  };
}

function calculateDurationSeconds(sessionStartedAt: string, endedAt: string): number {
  return Math.max(
    0,
    Math.round((new Date(endedAt).getTime() - new Date(sessionStartedAt).getTime()) / 1000),
  );
}

function hydrateMockBeeSession(row: DBMockBeeSessionRow): MockBeeSession {
  const config = row.session_config ?? {};
  const state = row.session_state ?? {};

  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: state.updatedAt ?? row.created_at,
    ownerUserId: row.user_id,
    config: {
      level: config.level,
      wordSource: config.wordSource,
      customListId: config.customListId,
      wordCount: config.wordCount,
    },
    childProfile: config.childProfile,
    turns: state.turns ?? [],
    currentTurnIndex: state.currentTurnIndex ?? 0,
    status: state.status ?? "active",
  };
}

export class MockBeeService {
  constructor(
    private readonly reviewGenerator: MockBeeReviewGenerator = defaultReviewGenerator,
  ) {}

  async createSession(
    authToken: string,
    userId: string,
    request: MockBeeCreateRequest,
    options: {
      ownerUserId?: string;
      customWordsFallback?: WordEntry[];
    } = {},
  ) {
    const parsed = MockBeeCreateRequestSchema.parse(request);
    const words = await pickWordsForSession(
      parsed,
      options.ownerUserId,
      options.customWordsFallback,
    );

    const now = new Date().toISOString();
    const session: MockBeeSession = {
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      ownerUserId: options.ownerUserId ?? userId,
      config: {
        level: parsed.level,
        wordSource: parsed.wordSource,
        customListId: parsed.customListId,
        wordCount: parsed.wordCount,
      },
      childProfile: parsed.childProfile,
      turns: words.map((word, index) => ({
        index,
        word,
        status: "pending",
        reviewCardStatus: "not_started",
      })),
      currentTurnIndex: 0,
      status: "active",
    };

    const startResult = await startMockBeeSessionInDB(
      authToken,
      userId,
      buildMockBeeSessionConfig(session),
      buildMockBeeSessionState(session),
      parsed.forceCloseCurrent,
    );

    if (startResult.action === "active_session_conflict") {
      return startResult;
    }

    const row = await getMockBeeSessionFromDB(
      authToken,
      userId,
      startResult.sessionId,
    );

    if (!row) {
      throw new Error(`Unknown mock bee session: ${startResult.sessionId}`);
    }

    return {
      action: startResult.action,
      sessionId: startResult.sessionId,
      session: buildSessionView(hydrateMockBeeSession(row)),
    };
  }

  async getSession(
    authToken: string,
    userId: string,
    sessionId: string,
  ) {
    const row = await getMockBeeSessionFromDB(authToken, userId, sessionId);
    if (!row) {
      throw new Error(`Unknown mock bee session: ${sessionId}`);
    }

    return buildSessionView(hydrateMockBeeSession(row));
  }

  async getReview(
    authToken: string,
    userId: string,
    sessionId: string,
  ) {
    const row = await getMockBeeSessionFromDB(authToken, userId, sessionId);
    if (!row) {
      throw new Error(`Unknown mock bee session: ${sessionId}`);
    }

    return buildReviewView(hydrateMockBeeSession(row));
  }

  async getInternalSession(
    authToken: string,
    userId: string,
    sessionId: string,
  ) {
    const row = await getMockBeeSessionFromDB(authToken, userId, sessionId);
    if (!row) {
      throw new Error(`Unknown mock bee session: ${sessionId}`);
    }

    return hydrateMockBeeSession(row);
  }

  async submitAttempt(
    authToken: string,
    userId: string,
    sessionId: string,
    request: MockBeeSubmitRequest,
  ) {
    const parsed = MockBeeSubmitRequestSchema.parse(request);
    const row = await getMockBeeSessionFromDB(authToken, userId, sessionId);
    if (!row) {
      throw new Error(`Unknown mock bee session: ${sessionId}`);
    }

    const session = hydrateMockBeeSession(row);
    if (session.status !== "active") {
      throw new Error(`Mock bee session ${sessionId} is already completed.`);
    }

    const turn = session.turns[session.currentTurnIndex];

    turn.childAttempt = parsed.childAttempt;
    turn.supportsUsed = parsed.supportsUsed;
    turn.isCorrect = isExactMatch(turn.word.word, parsed.childAttempt);
    turn.status = "submitted";
    turn.answeredAt = new Date().toISOString();
    session.updatedAt = turn.answeredAt;
    await recordWordAttemptInDB(
      authToken,
      userId,
      sessionId,
      turn.word.word,
      parsed.childAttempt,
      Boolean(turn.isCorrect),
      undefined,
      parsed.supportsUsed?.definitionViewed,
      parsed.supportsUsed?.exampleViewed,
      parsed.supportsUsed?.originViewed,
      false,
      0,
      false,
      "mock_bee",
    );
    this.advanceSession(session);
    this.startReviewGeneration(authToken, userId, session, turn);

    const isSessionCompleted = session.turns.every((entry) => entry.status !== "pending");

    const endedAt = isSessionCompleted ? new Date().toISOString() : null;
    const updatedRow = await updateMockBeeSessionInDB(authToken, userId, sessionId, {
      session_state: buildMockBeeSessionState(session),
      total_words_attempted: buildProgress(session).answeredCount,
      total_correct: buildProgress(session).correctCount,
      session_ended_at: endedAt,
      duration_seconds: endedAt
        ? calculateDurationSeconds(row.session_started_at, endedAt)
        : undefined,
    });

    const updatedSession = hydrateMockBeeSession(updatedRow);

    return {
      session: buildSessionView(updatedSession),
      result: buildResultPayload(updatedSession, turn, false),
    };
  }

  async timeoutCurrentWord(
    authToken: string,
    userId: string,
    sessionId: string,
  ) {
    const row = await getMockBeeSessionFromDB(authToken, userId, sessionId);
    if (!row) {
      throw new Error(`Unknown mock bee session: ${sessionId}`);
    }

    const session = hydrateMockBeeSession(row);
    if (session.status !== "active") {
      throw new Error(`Mock bee session ${sessionId} is already completed.`);
    }

    const turn = session.turns[session.currentTurnIndex];

    turn.childAttempt = "";
    turn.isCorrect = false;
    turn.status = "timed_out";
    turn.answeredAt = new Date().toISOString();
    session.updatedAt = turn.answeredAt;
    await recordWordAttemptInDB(
      authToken,
      userId,
      sessionId,
      turn.word.word,
      "",
      false,
      undefined,
      false,
      false,
      false,
      false,
      0,
      false,
      "mock_bee",
    );
    this.advanceSession(session);
    this.startReviewGeneration(authToken, userId, session, turn);

    const isSessionCompleted = session.turns.every((entry) => entry.status !== "pending");

    const endedAt = isSessionCompleted ? new Date().toISOString() : null;
    const updatedRow = await updateMockBeeSessionInDB(authToken, userId, sessionId, {
      session_state: buildMockBeeSessionState(session),
      total_words_attempted: buildProgress(session).answeredCount,
      total_correct: buildProgress(session).correctCount,
      session_ended_at: endedAt,
      duration_seconds: endedAt
        ? calculateDurationSeconds(row.session_started_at, endedAt)
        : undefined,
    });

    const updatedSession = hydrateMockBeeSession(updatedRow);

    return {
      session: buildSessionView(updatedSession),
      result: buildResultPayload(updatedSession, turn, true),
    };
  }

  async endSession(
    authToken: string,
    userId: string,
    sessionId: string,
  ) {
    const row = await getMockBeeSessionFromDB(authToken, userId, sessionId);
    if (!row) {
      throw new Error(`Unknown mock bee session: ${sessionId}`);
    }

    const session = hydrateMockBeeSession(row);
    if (session.status === "completed" && row.session_ended_at) {
      return buildSessionView(session);
    }

    const endedAt = new Date().toISOString();
    session.status = "completed";
    session.updatedAt = endedAt;

    const updatedRow = await updateMockBeeSessionInDB(authToken, userId, sessionId, {
      session_state: buildMockBeeSessionState(session),
      total_words_attempted: buildProgress(session).answeredCount,
      total_correct: buildProgress(session).correctCount,
      session_ended_at: endedAt,
      duration_seconds: calculateDurationSeconds(row.session_started_at, endedAt),
    });

    return buildSessionView(hydrateMockBeeSession(updatedRow));
  }

  private advanceSession(session: MockBeeSession): void {
    if (session.currentTurnIndex >= session.turns.length - 1) {
      session.status = "completed";
      return;
    }

    session.currentTurnIndex += 1;
  }

  private startReviewGeneration(
    authToken: string,
    userId: string,
    session: MockBeeSession,
    turn: MockBeeTurn,
  ): void {
    if (turn.reviewCardStatus === "pending" || turn.reviewCardStatus === "completed") {
      return;
    }

    turn.reviewCardStatus = "pending";

    void updateMockBeeSessionInDB(authToken, userId, session.id, {
      session_state: buildMockBeeSessionState(session),
    }).catch(() => undefined);

    void this.reviewGenerator(turn.word, session, turn)
      .then(async (reviewCard) => {
        turn.reviewCard = reviewCard;
        turn.reviewCardStatus = "completed";
        turn.reviewError = undefined;
        session.updatedAt = new Date().toISOString();

        await updateMockBeeSessionInDB(authToken, userId, session.id, {
          session_state: buildMockBeeSessionState(session),
        });
      })
      .catch(async (error) => {
        turn.reviewCardStatus = "failed";
        turn.reviewError = error instanceof Error ? error.message : String(error);
        session.updatedAt = new Date().toISOString();

        await updateMockBeeSessionInDB(authToken, userId, session.id, {
          session_state: buildMockBeeSessionState(session),
        });
      });
  }
}
