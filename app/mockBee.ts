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

const MockBeeCreateRequestSchema = z
  .object({
    level: z.enum(["1", "2", "3"]),
    wordSource: z.enum(["standard", "custom_list"]),
    customListId: z.string().optional(),
    wordCount: z.union([z.literal(10), z.literal(20), z.literal(30)]),
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

export interface MockBeeSessionStore {
  create(session: MockBeeSession): Promise<void> | void;
  get(id: string): Promise<MockBeeSession | undefined> | MockBeeSession | undefined;
  save(session: MockBeeSession): Promise<void> | void;
}

export class InMemoryMockBeeSessionStore implements MockBeeSessionStore {
  private readonly sessions = new Map<string, MockBeeSession>();

  create(session: MockBeeSession): void {
    this.sessions.set(session.id, session);
  }

  get(id: string): MockBeeSession | undefined {
    return this.sessions.get(id);
  }

  save(session: MockBeeSession): void {
    this.sessions.set(session.id, session);
  }
}

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

export class MockBeeService {
  constructor(
    private readonly store: MockBeeSessionStore,
    private readonly reviewGenerator: MockBeeReviewGenerator = defaultReviewGenerator,
  ) {}

  async createSession(
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
      ownerUserId: options.ownerUserId,
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

    await this.store.create(session);
    return buildSessionView(session);
  }

  async getSession(sessionId: string) {
    const session = await this.requireSession(sessionId);
    return buildSessionView(session);
  }

  async getReview(sessionId: string) {
    const session = await this.requireSession(sessionId);
    return buildReviewView(session);
  }

  async getInternalSession(sessionId: string) {
    return this.requireSession(sessionId);
  }

  async submitAttempt(sessionId: string, request: MockBeeSubmitRequest) {
    const parsed = MockBeeSubmitRequestSchema.parse(request);
    const session = await this.requireActiveSession(sessionId);
    const turn = session.turns[session.currentTurnIndex];

    turn.childAttempt = parsed.childAttempt;
    turn.supportsUsed = parsed.supportsUsed;
    turn.isCorrect = isExactMatch(turn.word.word, parsed.childAttempt);
    turn.status = "submitted";
    turn.answeredAt = new Date().toISOString();
    session.updatedAt = turn.answeredAt;

    this.startReviewGeneration(session, turn);
    this.advanceSession(session);
    await this.store.save(session);

    return {
      session: buildSessionView(session),
      result: buildResultPayload(session, turn, false),
    };
  }

  async timeoutCurrentWord(sessionId: string) {
    const session = await this.requireActiveSession(sessionId);
    const turn = session.turns[session.currentTurnIndex];

    turn.childAttempt = "";
    turn.isCorrect = false;
    turn.status = "timed_out";
    turn.answeredAt = new Date().toISOString();
    session.updatedAt = turn.answeredAt;

    this.startReviewGeneration(session, turn);
    this.advanceSession(session);
    await this.store.save(session);

    return {
      session: buildSessionView(session),
      result: buildResultPayload(session, turn, true),
    };
  }

  private async requireSession(sessionId: string): Promise<MockBeeSession> {
    const session = await this.store.get(sessionId);
    if (!session) {
      throw new Error(`Unknown mock bee session: ${sessionId}`);
    }

    return session;
  }

  private async requireActiveSession(sessionId: string): Promise<MockBeeSession> {
    const session = await this.requireSession(sessionId);
    if (session.status !== "active") {
      throw new Error(`Mock bee session ${sessionId} is already completed.`);
    }

    return session;
  }

  private advanceSession(session: MockBeeSession): void {
    if (session.currentTurnIndex >= session.turns.length - 1) {
      session.status = "completed";
      return;
    }

    session.currentTurnIndex += 1;
  }

  private startReviewGeneration(session: MockBeeSession, turn: MockBeeTurn): void {
    if (turn.reviewCardStatus === "pending" || turn.reviewCardStatus === "completed") {
      return;
    }

    turn.reviewCardStatus = "pending";

    void this.reviewGenerator(turn.word, session, turn)
      .then(async (reviewCard) => {
        turn.reviewCard = reviewCard;
        turn.reviewCardStatus = "completed";
        turn.reviewError = undefined;
        session.updatedAt = new Date().toISOString();
        await this.store.save(session);
      })
      .catch(async (error) => {
        turn.reviewCardStatus = "failed";
        turn.reviewError = error instanceof Error ? error.message : String(error);
        session.updatedAt = new Date().toISOString();
        await this.store.save(session);
      });
  }
}

