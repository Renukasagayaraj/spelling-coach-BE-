type Counts = Record<string, number>;

type ReportSession = {
  id: string;
  mode: string;
  status?: "active" | "completed" | "abandoned";
  session_started_at: string;
  total_words_attempted?: number | null;
  total_correct?: number | null;
  duration_seconds?: number | null;
  session_config?: unknown;
  session_state?: unknown;
};

type ReportWord = {
  origin?: string;
  mainOrigin?: string;
  partOfSpeech?: string;
  difficulty?: string;
  gradeBand?: string;
};

type ReportAttempt = {
  id: string;
  session_id: string;
  target_word: string;
  child_attempt: string;
  is_correct: boolean;
  level?: number;
  definition_viewed?: boolean;
  example_viewed?: boolean;
  origin_viewed?: boolean;
  part_of_speech_viewed?: boolean;
  repeat_word_count?: number;
  used_voice_input?: boolean;
  coaching_response?: Record<string, unknown> | null;
  created_at: string;
  word_catalog_entry?: ReportWord | null;
};

type CoachingPayload = {
  missAnalysis?: {
    primaryErrorType?: unknown;
    secondaryErrorTypes?: unknown;
  };
  coachingText?: {
    fullExplanation?: unknown;
    memoryTip?: unknown;
    sayAloudTip?: unknown;
  };
  wordBreakdown?: {
    displayChunks?: unknown;
  };
  wordTeaching?: {
    conceptTeaching?: {
      summary?: unknown;
    };
  };
};

type ReportFormatting = {
  locale?: string;
  timeZone?: string;
};

const LEVEL_ORDER = ["Level 1", "Level 2", "Level 3"] as const;
const MODE_ORDER = ["Standard", "Custom", "Foreign Origin", "Mock Bee"] as const;
const RECENT_MISSED_WORD_LIMIT = 20;

function add(counts: Counts, key: string, amount = 1) {
  counts[key] = (counts[key] ?? 0) + amount;
}

function countRows(counts: Counts) {
  return Object.entries(counts)
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function dateFormatter(
  formatting: ReportFormatting,
  options: Intl.DateTimeFormatOptions,
) {
  return new Intl.DateTimeFormat(formatting.locale || "en-US", {
    ...options,
    timeZone: formatting.timeZone || "UTC",
  });
}

function calendarDateKey(value: string, formatting: ReportFormatting) {
  const parts = dateFormatter(formatting, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function modeLabel(mode?: string) {
  if (mode?.startsWith("standard")) return "Standard";
  if (mode === "foreign_origin") return "Foreign Origin";
  if (mode === "mock_bee") return "Mock Bee";
  if (mode === "custom") return "Custom";
  return "unknown";
}

function levelLabel(level?: number, mode?: string) {
  const standardLevel = mode?.match(/^standard_level_([1-3])$/)?.[1];
  if (standardLevel) return `Level ${standardLevel}`;
  return level === 1 || level === 2 || level === 3 ? `Level ${level}` : "—";
}

function hasAssignedLevel(attempt: ReportAttempt, session?: ReportSession) {
  return levelLabel(attempt.level, session?.mode) !== "—";
}

function supportLevelLabel(attempt: ReportAttempt, session?: ReportSession) {
  const standardLevel = session?.mode.match(/^standard_level_([1-3])$/)?.[1];
  if (standardLevel) return `Level ${standardLevel}`;
  return attempt.level === 1 || attempt.level === 2 || attempt.level === 3
    ? `Level ${attempt.level}`
    : null;
}

function labelError(error: string) {
  return error.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function coachingErrors(attempt: ReportAttempt) {
  const payload = attempt.coaching_response as CoachingPayload | null | undefined;
  const miss = payload?.missAnalysis;
  return {
    primary: typeof miss?.primaryErrorType === "string"
      ? miss.primaryErrorType
      : "Unclassified",
    secondary: Array.isArray(miss?.secondaryErrorTypes)
      ? miss.secondaryErrorTypes.filter(
          (item: unknown): item is string => typeof item === "string",
        )
      : [],
  };
}

function coachingDetails(attempt: ReportAttempt) {
  const payload = attempt.coaching_response as CoachingPayload | null | undefined;
  return {
    explanation: typeof payload?.coachingText?.fullExplanation === "string"
      ? payload.coachingText.fullExplanation
      : "—",
    memoryTip: typeof payload?.coachingText?.memoryTip === "string"
      ? payload.coachingText.memoryTip
      : "—",
    wordBreakdown: Array.isArray(payload?.wordBreakdown?.displayChunks)
      ? payload.wordBreakdown.displayChunks.join(" · ")
      : "—",
    conceptTeaching:
      typeof payload?.wordTeaching?.conceptTeaching?.summary === "string"
        ? payload.wordTeaching.conceptTeaching.summary
        : "—",
    sayAloudTip: typeof payload?.coachingText?.sayAloudTip === "string"
      ? payload.coachingText.sayAloudTip
      : "—",
  };
}

function mockBeeDetails(session: ReportSession) {
  const config = session.session_config as { level?: string | number } | null;
  const state = session.session_state as {
    turns?: Array<{ status?: string; reviewCard?: unknown }>;
  } | null;
  const level = config?.level;
  return {
    level:
      level === 1 || level === 2 || level === 3
      || level === "1" || level === "2" || level === "3"
        ? `Level ${level}`
        : "—",
    timeouts: Array.isArray(state?.turns)
      ? state.turns.filter((turn) => turn.status === "timed_out").length
      : 0,
    reviewCards: Array.isArray(state?.turns)
      ? state.turns.flatMap((turn) =>
          turn.reviewCard == null ? [] : [turn.reviewCard])
      : [],
  };
}

type SupportCounts = {
  definition: number;
  example: number;
  origin: number;
  partOfSpeech: number;
  repeat: number;
  voice: number;
};

function groupSupport<Field extends "mode" | "level">(
  attempts: ReportAttempt[],
  key: Field,
  sessions: Map<string, ReportSession>,
): Array<{ [Key in Field]: string } & SupportCounts> {
  const rows = new Map<string, { [Key in Field]: string } & SupportCounts>();
  for (const attempt of attempts) {
    const session = sessions.get(attempt.session_id);
    const value = key === "mode"
      ? modeLabel(session?.mode)
      : supportLevelLabel(attempt, session);
    if (!value) continue;
    const row = rows.get(value) ?? ({
      [key]: value,
      definition: 0,
      example: 0,
      origin: 0,
      partOfSpeech: 0,
      repeat: 0,
      voice: 0,
    } as { [Key in Field]: string } & SupportCounts);
    row.definition += attempt.definition_viewed ? 1 : 0;
    row.example += attempt.example_viewed ? 1 : 0;
    row.origin += attempt.origin_viewed ? 1 : 0;
    row.partOfSpeech += attempt.part_of_speech_viewed ? 1 : 0;
    row.repeat += (attempt.repeat_word_count ?? 0) > 0 ? 1 : 0;
    row.voice += attempt.used_voice_input ? 1 : 0;
    rows.set(value, row);
  }
  return [...rows.values()];
}

type ReportSource = { sessions: ReportSession[]; attempts: ReportAttempt[] };

function sessionsById(source: ReportSource) {
  return new Map(source.sessions.map((session) => [session.id, session]));
}

function sortedAttempts(source: ReportSource) {
  return [...source.attempts].sort(
    (a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
}

function displayDate(formatting: ReportFormatting) {
  const formatter = dateFormatter(formatting, { month: "short", day: "numeric" });
  return (value: string) => formatter.format(new Date(value));
}

function countBy<Field extends string>(counts: Counts, field: Field) {
  return countRows(counts).map((row) => ({
    [field]: row.label,
    attempts: row.count,
  })) as Array<{ [Key in Field]: string } & { attempts: number }>;
}

function countByFixedOrder<Field extends string>(
  counts: Counts,
  order: readonly string[],
  field: Field,
) {
  return order
    .filter((value) => counts[value] != null)
    .map((value) => ({
      [field]: value,
      attempts: counts[value] ?? 0,
    })) as Array<{ [Key in Field]: string } & { attempts: number }>;
}

export function buildOverviewSection(
  source: ReportSource,
  formatting: ReportFormatting = {},
) {
  const attempts = sortedAttempts(source);
  const sessionMap = sessionsById(source);
  const completedSessions = source.sessions.filter(
    (session) => session.status === "completed",
  );
  const correct = attempts.filter((attempt) => attempt.is_correct).length;
  const byDate: Record<
    string,
    { timestamp: number; date: string; attempts: number; correct: number }
  > = {};
  const byMode: Counts = {};
  const byLevel: Counts = {};
  const attemptCountsBySession: Counts = {};
  const formatDate = displayDate(formatting);

  for (const attempt of attempts) {
    const session = sessionMap.get(attempt.session_id);
    const timestamp = new Date(attempt.created_at).getTime();
    const dateKey = calendarDateKey(attempt.created_at, formatting);
    const trend = byDate[dateKey] ?? {
      timestamp,
      date: formatDate(attempt.created_at),
      attempts: 0,
      correct: 0,
    };
    trend.attempts += 1;
    trend.correct += attempt.is_correct ? 1 : 0;
    trend.timestamp = Math.min(trend.timestamp, timestamp);
    byDate[dateKey] = trend;
    add(byMode, modeLabel(session?.mode));
    if (hasAssignedLevel(attempt, session)) {
      add(byLevel, levelLabel(attempt.level, session?.mode));
    }
    add(attemptCountsBySession, attempt.session_id);
  }

  const trendRows = Object.values(byDate).sort(
    (a, b) => a.timestamp - b.timestamp,
  );
  return {
    totalAttempted: attempts.length,
    accuracy: attempts.length ? Math.round((correct / attempts.length) * 100) : 0,
    totalCorrect: correct,
    totalIncorrect: attempts.length - correct,
    sessionsCompleted: completedSessions.length,
    avgAttemptsPerSession: completedSessions.length
      ? Number((
          completedSessions.reduce(
            (total, session) => total + (
              session.total_words_attempted ?? attemptCountsBySession[session.id] ?? 0
            ),
            0,
          ) / completedSessions.length
        ).toFixed(1))
      : 0,
    practiceTimeMinutes: Math.round(
      completedSessions.reduce(
        (total, session) => total + (session.duration_seconds ?? 0),
        0,
      ) / 60,
    ),
    accuracyTrend: trendRows.map((row) => ({
      date: row.date,
      accuracy: Math.round((row.correct / row.attempts) * 100),
    })),
    attemptsTrend: trendRows.map(({ date, attempts: count }) => ({
      date,
      attempts: count,
    })),
    byMode: countByFixedOrder(byMode, MODE_ORDER, "mode"),
    byLevel: countByFixedOrder(byLevel, LEVEL_ORDER, "level"),
  };
}

function missBreakdown<Field extends "mode" | "level">(
  attempts: ReportAttempt[],
  sessionMap: Map<string, ReportSession>,
  key: Field,
) {
  const scopedAttempts = key === "level"
    ? attempts.filter((attempt) =>
        hasAssignedLevel(attempt, sessionMap.get(attempt.session_id)))
    : attempts;
  const categories = [...new Set(
    scopedAttempts
      .filter((attempt) => !attempt.is_correct)
      .map((attempt) => labelError(coachingErrors(attempt).primary)),
  )];
  const groups = [...new Set(scopedAttempts.map((attempt) =>
    key === "mode"
      ? modeLabel(sessionMap.get(attempt.session_id)?.mode)
      : levelLabel(attempt.level, sessionMap.get(attempt.session_id)?.mode)))];

  return groups.map((value) => {
    const counts = Object.fromEntries(
      categories.map((category) => [category, 0]),
    ) as Record<string, number>;
    scopedAttempts
      .filter((attempt) => {
        const group = key === "mode"
          ? modeLabel(sessionMap.get(attempt.session_id)?.mode)
          : levelLabel(attempt.level, sessionMap.get(attempt.session_id)?.mode);
        return group === value && !attempt.is_correct;
      })
      .forEach((attempt) => {
        const error = labelError(coachingErrors(attempt).primary);
        counts[error] = (counts[error] ?? 0) + 1;
      });
    return { [key]: value, ...counts };
  });
}

export function buildMissAnalysisSection(
  source: ReportSource,
  formatting: ReportFormatting = {},
) {
  const attempts = sortedAttempts(source);
  const sessionMap = sessionsById(source);
  const primary: Counts = {};
  const secondary: Counts = {};
  const formatDate = displayDate(formatting);

  for (const attempt of attempts) {
    if (attempt.is_correct) continue;
    const errors = coachingErrors(attempt);
    add(primary, labelError(errors.primary));
    errors.secondary.forEach((error) => add(secondary, labelError(error)));
  }

  const recentMiss = (attempt: ReportAttempt) => {
    const errors = coachingErrors(attempt);
    const session = sessionMap.get(attempt.session_id);
    return {
      target: attempt.target_word,
      attempt: attempt.child_attempt,
      primary: labelError(errors.primary),
      secondary: errors.secondary.map(labelError),
      date: formatDate(attempt.created_at),
      mode: modeLabel(session?.mode),
      level: levelLabel(attempt.level, session?.mode),
    };
  };

  const recentMissedWords: ReportAttempt[] = [];
  const seenMissedWords = new Set<string>();
  for (const attempt of attempts) {
    if (attempt.is_correct) continue;
    const key = attempt.target_word.toLowerCase();
    if (seenMissedWords.has(key)) continue;
    seenMissedWords.add(key);
    recentMissedWords.push(attempt);
    if (recentMissedWords.length >= RECENT_MISSED_WORD_LIMIT) break;
  }

  return {
    primary: countRows(primary).map(({ label, count }) => ({
      key: label,
      label,
      count,
    })),
    secondary: countRows(secondary).map(({ label, count }) => ({
      key: label,
      label,
      count,
    })),
    byLevel: missBreakdown(attempts, sessionMap, "level"),
    byMode: missBreakdown(attempts, sessionMap, "mode"),
    recentIncorrect: attempts
      .filter((attempt) => !attempt.is_correct)
      .slice(0, 20)
      .map(recentMiss),
    recentMissedWords: recentMissedWords.map(recentMiss),
  };
}

export function buildWordKnowledgeSection(
  source: ReportSource,
  formatting: ReportFormatting = {},
) {
  const attempts = sortedAttempts(source);
  const sessionMap = sessionsById(source);
  const byOrigin: Counts = {};
  const byPos: Counts = {};
  const byDifficulty: Counts = {};
  const byGradeBand: Counts = {};
  const missedOrigins: Counts = {};
  const formatDate = displayDate(formatting);

  for (const attempt of attempts) {
    const word = attempt.word_catalog_entry;
    const origin = word?.mainOrigin?.trim() || "Unknown";
    add(byOrigin, origin);
    add(byPos, word?.partOfSpeech || "Other");
    add(byDifficulty, word?.difficulty || "Unknown");
    add(byGradeBand, word?.gradeBand || "Unknown");
    if (!attempt.is_correct) add(missedOrigins, origin);
  }

  const recentWord = (attempt: ReportAttempt) => ({
    word: attempt.target_word,
    origin: attempt.word_catalog_entry?.origin || "Unknown",
    date: formatDate(attempt.created_at),
    correct: attempt.is_correct,
  });
  return {
    byOrigin: countBy(byOrigin, "origin"),
    byPos: countBy(byPos, "pos"),
    byDifficulty: countBy(byDifficulty, "difficulty"),
    byGradeBand: countBy(byGradeBand, "band"),
    mostMissedOrigins: countRows(missedOrigins).map(
      ({ label: origin, count: missed }) => ({ origin, incorrect: missed }),
    ),
    recentByOrigin: attempts.slice(0, 20).map(recentWord),
    recentHard: attempts
      .filter((attempt) =>
        attempt.word_catalog_entry?.difficulty?.toLowerCase() === "hard")
      .slice(0, 20)
      .map(recentWord),
    recentForeign: attempts
      .filter((attempt) =>
        sessionMap.get(attempt.session_id)?.mode === "foreign_origin")
      .slice(0, 20)
      .map(recentWord),
  };
}

export function buildSupportUsageSection(
  source: ReportSource,
  formatting: ReportFormatting = {},
) {
  const attempts = sortedAttempts(source);
  const sessionMap = sessionsById(source);
  const formatDate = displayDate(formatting);
  const supportAttempts = attempts.filter((attempt) =>
    attempt.definition_viewed
    || attempt.example_viewed
    || attempt.origin_viewed
    || attempt.part_of_speech_viewed
    || (attempt.repeat_word_count ?? 0) > 0
    || attempt.used_voice_input);

  return {
    definition: attempts.filter((attempt) => attempt.definition_viewed).length,
    example: attempts.filter((attempt) => attempt.example_viewed).length,
    origin: attempts.filter((attempt) => attempt.origin_viewed).length,
    partOfSpeech: attempts.filter(
      (attempt) => attempt.part_of_speech_viewed,
    ).length,
    repeat: attempts.filter(
      (attempt) => (attempt.repeat_word_count ?? 0) > 0,
    ).length,
    voice: attempts.filter((attempt) => attempt.used_voice_input).length,
    recentWithSupport: supportAttempts.slice(0, 20).map((attempt) => {
      const session = sessionMap.get(attempt.session_id);
      const supports = [
        attempt.definition_viewed && "Definition",
        attempt.example_viewed && "Example",
        attempt.origin_viewed && "Origin",
        attempt.part_of_speech_viewed && "Part of speech",
        (attempt.repeat_word_count ?? 0) > 0 && "Repeat",
        attempt.used_voice_input && "Voice input",
      ].filter((value): value is string => Boolean(value));
      return {
        word: attempt.target_word,
        date: formatDate(attempt.created_at),
        supports,
        mode: modeLabel(session?.mode),
        level: levelLabel(attempt.level, session?.mode),
        correct: attempt.is_correct,
      };
    }),
    byMode: groupSupport(attempts, "mode", sessionMap),
    byLevel: groupSupport(attempts, "level", sessionMap),
  };
}

export function buildSessionsSection(
  source: ReportSource,
  formatting: ReportFormatting = {},
) {
  const attempts = sortedAttempts(source);
  const attemptsBySession = new Map<string, ReportAttempt[]>();
  for (const attempt of attempts) {
    const rows = attemptsBySession.get(attempt.session_id) ?? [];
    rows.push(attempt);
    attemptsBySession.set(attempt.session_id, rows);
  }
  const formatDateTime = dateFormatter(formatting, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  return source.sessions.map((session) => {
    const sessionAttempts = attemptsBySession.get(session.id) ?? [];
    const missed = sessionAttempts.filter((attempt) => !attempt.is_correct);
    const supports = {
      definition: sessionAttempts.filter((attempt) => attempt.definition_viewed).length,
      example: sessionAttempts.filter((attempt) => attempt.example_viewed).length,
      origin: sessionAttempts.filter((attempt) => attempt.origin_viewed).length,
      partOfSpeech: sessionAttempts.filter(
        (attempt) => attempt.part_of_speech_viewed,
      ).length,
      repeat: sessionAttempts.filter(
        (attempt) => (attempt.repeat_word_count ?? 0) > 0,
      ).length,
      voice: sessionAttempts.filter((attempt) => attempt.used_voice_input).length,
    };
    const attempted = session.total_words_attempted ?? sessionAttempts.length;
    const sessionCorrect = session.total_correct
      ?? sessionAttempts.filter((attempt) => attempt.is_correct).length;
    const details = session.mode === "mock_bee" ? mockBeeDetails(session) : null;
    return {
      id: session.id,
      startedAt: formatDateTime.format(new Date(session.session_started_at)),
      mode: modeLabel(session.mode),
      level: details?.level ?? levelLabel(sessionAttempts[0]?.level, session.mode),
      attempted,
      correct: sessionCorrect,
      incorrect: attempted - sessionCorrect,
      accuracy: attempted ? Math.round((sessionCorrect / attempted) * 100) : 0,
      durationMinutes: Math.round((session.duration_seconds ?? 0) / 60),
      topMissCategories: countRows(
        missed.reduce<Counts>((counts, attempt) => {
          add(counts, labelError(coachingErrors(attempt).primary));
          return counts;
        }, {}),
      ).slice(0, 2).map((item) => item.label),
      supportsUsed: supports,
      words: [],
    };
  });
}

export function buildMockBeeSection(
  source: ReportSource,
  formatting: ReportFormatting = {},
) {
  const completedMockSessions = source.sessions.filter(
    (session) => session.mode === "mock_bee" && session.status === "completed",
  );
  const chronologicalMockSessions = [...completedMockSessions].sort(
    (a, b) =>
      new Date(a.session_started_at).getTime()
      - new Date(b.session_started_at).getTime(),
  );
  const mockLevels = completedMockSessions.reduce<
    Record<string, { correct: number; total: number }>
  >((acc, session) => {
    const { level } = mockBeeDetails(session);
    if (level === "—") return acc;
    const value = acc[level] ?? { correct: 0, total: 0 };
    value.total += session.total_words_attempted ?? 0;
    value.correct += session.total_correct ?? 0;
    acc[level] = value;
    return acc;
  }, {});
  const formatDate = displayDate(formatting);

  return {
    roundsCompleted: completedMockSessions.length,
    avgScore: completedMockSessions.length
      ? Number((
          completedMockSessions.reduce(
            (total, session) => total + (session.total_correct ?? 0),
            0,
          ) / completedMockSessions.length
        ).toFixed(1))
      : 0,
    accuracyByRound: chronologicalMockSessions.map((session, index) => ({
      round: `R${index + 1}`,
      accuracy: session.total_words_attempted
        ? Math.round(
            ((session.total_correct ?? 0) / session.total_words_attempted) * 100,
          )
        : 0,
    })),
    timeoutsByRound: chronologicalMockSessions.map((session, index) => ({
      round: `R${index + 1}`,
      timeouts: mockBeeDetails(session).timeouts,
    })),
    accuracyByLevel: Object.entries(mockLevels).map(([level, value]) => ({
      level,
      accuracy: value.total ? Math.round((value.correct / value.total) * 100) : 0,
    })),
    rounds: completedMockSessions.map((session) => {
      const details = mockBeeDetails(session);
      return {
        id: session.id,
        date: formatDate(session.session_started_at),
        level: details.level,
        attempted: session.total_words_attempted ?? 0,
        correct: session.total_correct ?? 0,
        incorrect:
          (session.total_words_attempted ?? 0) - (session.total_correct ?? 0),
        timedOut: details.timeouts,
        reviewCards: details.reviewCards,
      };
    }),
  };
}

export type ReportData = {
  overview: ReturnType<typeof buildOverviewSection>;
  missAnalysis: ReturnType<typeof buildMissAnalysisSection>;
  wordKnowledge: ReturnType<typeof buildWordKnowledgeSection>;
  supportUsage: ReturnType<typeof buildSupportUsageSection>;
  sessions: ReturnType<typeof buildSessionsSection>;
  mockBee: ReturnType<typeof buildMockBeeSection>;
};
export type ReportSection = keyof ReportData;

export function buildReportData(
  source: ReportSource,
  formatting: ReportFormatting = {},
): ReportData {
  return {
    overview: buildOverviewSection(source, formatting),
    missAnalysis: buildMissAnalysisSection(source, formatting),
    wordKnowledge: buildWordKnowledgeSection(source, formatting),
    supportUsage: buildSupportUsageSection(source, formatting),
    sessions: buildSessionsSection(source, formatting),
    mockBee: buildMockBeeSection(source, formatting),
  };
}

/** Build only the section requested by the client. */
export function buildReportSection(
  source: ReportSource,
  section: ReportSection,
  formatting: ReportFormatting = {},
): Partial<ReportData> {
  switch (section) {
    case "overview":
      return { overview: buildOverviewSection(source, formatting) };
    case "missAnalysis":
      return { missAnalysis: buildMissAnalysisSection(source, formatting) };
    case "wordKnowledge":
      return { wordKnowledge: buildWordKnowledgeSection(source, formatting) };
    case "supportUsage":
      return { supportUsage: buildSupportUsageSection(source, formatting) };
    case "sessions":
      return { sessions: buildSessionsSection(source, formatting) };
    case "mockBee":
      return { mockBee: buildMockBeeSection(source, formatting) };
  }
}

export function buildSessionWordDetails(attempts: ReportAttempt[]) {
  return attempts.map((attempt) => {
    const errors = coachingErrors(attempt);
    return {
      target: attempt.target_word,
      attempt: attempt.child_attempt,
      correct: attempt.is_correct,
      primaryError: labelError(errors.primary),
      secondaryErrors: errors.secondary.map(labelError),
      ...coachingDetails(attempt),
    };
  });
}

export type SessionWordDetails = ReturnType<typeof buildSessionWordDetails>;
