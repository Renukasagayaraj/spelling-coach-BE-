import assert from "node:assert/strict";
import test, { mock } from "node:test";

type Response = { data?: any; error?: any };
const responses: Response[] = [];
const operations: Array<{ table: string; method: string; value?: any }> = [];

class Query {
  constructor(private table: string) {}
  private op(method: string, value?: any) { operations.push({ table: this.table, method, value }); return this; }
  select(value?: any) { return this.op("select", value); }
  insert(value?: any) { return this.op("insert", value); }
  update(value?: any) { return this.op("update", value); }
  upsert(value?: any, options?: any) { this.op("upsert", value); if (options) this.op("upsertOptions", options); return this; }
  eq(column: string, value: any) { return this.op(`eq:${column}`, value); }
  is(column: string, value: any) { return this.op(`is:${column}`, value); }
  order(value?: any, options?: any) { return this.op("order", [value, options]); }
  limit(value?: any) { return this.op("limit", value); }
  single() { return Promise.resolve(responses.shift() ?? { data: null, error: null }); }
  maybeSingle() { return Promise.resolve(responses.shift() ?? { data: null, error: null }); }
  then(resolve: (value: Response) => unknown, reject?: (reason: unknown) => unknown) {
    return Promise.resolve(responses.shift() ?? { data: null, error: null }).then(resolve, reject);
  }
}

const clients: any[] = [];
const createClient = mock.fn((_url?: string, _key?: string, _options?: any) => {
  const client = { from: (table: string) => new Query(table), auth: { getUser: mock.fn() } };
  clients.push(client);
  return client;
});

mock.module("@supabase/supabase-js", { namedExports: { createClient } });
process.env.SUPABASE_URL = "https://unit-test.supabase.co";
process.env.SUPABASE_PUBLISHABLE_KEY = "unit-key";

const db = await import("../supabase.js");
const word = {
  word: "rhythm", level: "2", grade_band: "3-5", difficulty: "medium", origin: "Greek",
  definition: "pattern", example_sentence: "Keep rhythm.", patterns: [], common_mistakes: [],
  coach_tip: "tip", part_of_speech: "noun",
};

test.beforeEach(() => { responses.length = 0; operations.length = 0; });

test("normalizes every supported practice mode and validates standard levels", () => {
  assert.equal(db.normalizeMode("standard", 1), "standard_level_1");
  assert.equal(db.normalizeMode("standard_level_3"), "standard_level_3");
  assert.equal(db.normalizeMode("custom_list_abc"), "custom");
  assert.equal(db.normalizeMode("foreignOrigin"), "foreign_origin");
  assert.equal(db.normalizeMode("mock-bee"), "mock_bee");
  assert.equal(db.normalizeMode("other"), "other");
  assert.throws(() => db.normalizeMode("standard"), /level is required/);
  assert.throws(() => db.normalizeMode("standard", 4), /level must be/);
  assert.throws(() => db.normalizeMode("standard_level_NaN"), /level must be/);
});

test("creates an RLS user client with a cleaned bearer token", () => {
  db.getSupabaseUserClient("Bearer token-value ");
  const options = createClient.mock.calls.at(-1)?.arguments[2] as any;
  assert.equal(options.global.headers.Authorization, "Bearer token-value");
  assert.equal(options.auth.persistSession, false);
});

test("fetches, saves, and rejects custom-list database operations", async () => {
  responses.push({ data: [{ id: "a", name: "A", words: [word] }, { id: "b", name: "B", words: null }], error: null });
  assert.deepEqual(await db.fetchCustomListsFromDB("t", "u"), [
    { id: "a", name: "A", wordCount: 1 }, { id: "b", name: "B", wordCount: 0 },
  ]);
  responses.push({ data: null, error: new Error("list failure") });
  await assert.rejects(db.fetchCustomListsFromDB("t", "u"), /list failure/);

  responses.push({ data: { id: "a", owner_user_id: "u", words: [word] }, error: null });
  assert.equal((await db.fetchCustomListByIdFromDB("t", "a", "u"))?.id, "a");
  responses.push({ data: null, error: new Error("lookup failure") });
  await assert.rejects(db.fetchCustomListByIdFromDB("t", "a", "u"), /lookup failure/);

  responses.push({ data: { id: "a", name: "Saved", words: [word] }, error: null });
  assert.equal((await db.saveCustomListToDB("t", "u", "Saved", [word] as any, "a")).id, "a");
  assert.equal(operations.find((entry) => entry.method === "upsert")?.value.word_count, 1);
  responses.push({ data: null, error: new Error("save failure") });
  await assert.rejects(db.saveCustomListToDB("t", "u", "Bad", []), /save failure/);
});

test("fetches, creates, updates, and validates user profiles", async () => {
  responses.push({ data: { id: "u", email: "u@example.com" }, error: null });
  assert.equal((await db.fetchUserProfileFromDB("t", "u"))?.id, "u");

  responses.push({ data: null, error: null }, { data: { id: "new", email: null }, error: null });
  assert.equal((await db.fetchUserProfileFromDB("t", "new"))?.id, "new");
  assert.equal(operations.find((entry) => entry.method === "insert")?.value.child_id, "c1");

  responses.push({ data: null, error: null }, { data: null, error: new Error("insert failed") });
  await assert.rejects(db.fetchUserProfileFromDB("t", "bad"), /insert failed/);
  responses.push({ data: null, error: new Error("fetch failed") });
  await assert.rejects(db.fetchUserProfileFromDB("t", "bad"), /fetch failed/);

  responses.push({ data: { id: "u", theme_preference: "dark" }, error: null });
  assert.equal((await db.updateUserProfileInDB("t", "u", { theme_preference: "dark" })).theme_preference, "dark");
  responses.push({ data: null, error: new Error("update failed") });
  await assert.rejects(db.updateUserProfileInDB("t", "u", {}), /update failed/);
});

test("starts, resumes, conflicts, force-closes, and rejects practice sessions", async () => {
  responses.push({ data: null, error: null }, { data: { id: "created" }, error: null });
  assert.deepEqual(await db.startPracticeSessionInDB("t", "u", "foreign_origin_Greek", undefined, false, {}), { action: "created", sessionId: "created" });
  const insert = operations.find((entry) => entry.method === "insert")?.value;
  assert.equal(insert.mode, "foreign_origin");
  assert.equal(insert.origin_language, "Greek");

  responses.push({ data: { id: "same", mode: "custom", custom_list_id: "list" }, error: null });
  assert.deepEqual(await db.startPracticeSessionInDB("t", "u", "custom_list_list"), { action: "resume_existing", sessionId: "same" });

  responses.push({ data: { id: "other", mode: "standard_level_2" }, error: null });
  assert.deepEqual(await db.startPracticeSessionInDB("t", "u", "standard", 1), { action: "active_session_conflict", activeSessionId: "other", activeMode: "standard_level_2" });

  responses.push(
    { data: { id: "other", mode: "standard_level_2", session_started_at: "invalid", total_words_attempted: null, total_correct: null }, error: null },
    { data: null, error: null }, { data: { id: "forced" }, error: null },
  );
  const forced = await db.startPracticeSessionInDB("t", "u", "standard", 1, true);
  assert.notEqual(forced.action, "active_session_conflict");
  assert.equal((forced as { sessionId: string }).sessionId, "forced");

  responses.push({ data: null, error: new Error("active lookup") });
  await assert.rejects(db.startPracticeSessionInDB("t", "u", "standard", 1), /active lookup/);
  responses.push({ data: null, error: null }, { data: null, error: new Error("create failed") });
  await assert.rejects(db.startPracticeSessionInDB("t", "u", "standard", 1), /create failed/);
});

test("records attempts, updates streak statistics, and tolerates statistics failures", async () => {
  responses.push(
    { data: { id: "attempt" }, error: null },
    { data: { total_words_attempted: 2, total_correct: 1 }, error: null },
    { data: null, error: null },
    { data: { current_streak: 4, best_streak: 4, total_attempts: 24, correct_attempts: 24 }, error: null },
    { data: null, error: new Error("stats unavailable") },
  );
  const originalError = console.error;
  const errors: unknown[][] = [];
  console.error = (...args) => { errors.push(args); };
  try {
    assert.equal(await db.recordWordAttemptInDB("t", "u", "s", "word", "word", true, "standard", 2, true), "attempt");
  } finally {
    console.error = originalError;
  }
  const stats = operations.filter((entry) => entry.table === "user_statistics" && entry.method === "upsert").at(-1)?.value;
  assert.equal(stats.current_streak, 5);
  assert.deepEqual(stats.badges, ["streak3", "streak5", "total25"]);
  assert.equal(errors.length, 1);

  responses.push({ data: null, error: new Error("attempt failed") });
  await assert.rejects(db.recordWordAttemptInDB("t", "u", "s", "word", "bad", false, "custom"), /attempt failed/);
});

test("covers session, statistics, attempts, and subscription CRUD success and failures", async () => {
  responses.push({ data: null, error: null });
  await db.endPracticeSessionInDB("t", "u", "s", 3, 2, 10);
  responses.push({ data: null, error: new Error("end") });
  await assert.rejects(db.endPracticeSessionInDB("t", "u", "s", 0, 0, 0), /end/);

  const cases: Array<[() => Promise<any>, any]> = [
    [() => db.getUserStatisticsInDB("t", "u"), [{ total_attempts: 1 }]],
    [() => db.getSessionAttemptsFromDB("t", "u", "s"), [{ id: "a" }]],
    [() => db.getPracticeSessionFromDB("t", "u", "s"), { id: "s" }],
    [() => db.getUserSubscriptionFromDB("t", "u"), { status: "active" }],
    [() => db.updateUserSubscriptionInDB("t", "u", { stripeCustomerId: null, stripeSubscriptionId: null, status: "active", currentPeriodEnd: null, cancelAtPeriodEnd: false, stripePriceId: null, priceUnitAmount: null, priceCurrency: null, billingInterval: null }), { status: "active" }],
  ];
  for (const [operation, expected] of cases) {
    responses.push({ data: expected, error: null });
    assert.deepEqual(await operation(), expected);
    responses.push({ data: null, error: new Error("query failed") });
    await assert.rejects(operation(), /query failed/);
  }
});

test("covers mock-bee database CRUD helpers", async () => {
  const row = { id: "bee", status: "active" };
  for (const operation of [
    () => db.createMockBeeSessionInDB("t", "u", {}, {}),
    () => db.getMockBeeSessionFromDB("t", "u", "bee"),
    () => db.updateMockBeeSessionInDB("t", "u", "bee", { status: "completed" }),
  ]) {
    responses.push({ data: row, error: null });
    assert.equal((await operation())?.id, "bee");
    responses.push({ data: null, error: new Error("mock bee query") });
    await assert.rejects(operation(), /mock bee query/);
  }

  responses.push({ data: null, error: null }, { data: { id: "bee" }, error: null });
  assert.equal((await db.startMockBeeSessionInDB("t", "u", {}, {})).action, "created");
  responses.push({ data: { id: "bee", mode: "mock_bee" }, error: null });
  assert.equal((await db.startMockBeeSessionInDB("t", "u", {}, {})).action, "resume_existing");
  responses.push({ data: { id: "practice", mode: "standard_level_1" }, error: null });
  assert.equal((await db.startMockBeeSessionInDB("t", "u", {}, {})).action, "active_session_conflict");
});
