import { createClient } from "@supabase/supabase-js";
// @ts-ignore
import ws from "ws";
import { type WordEntry } from "./wordCatalog.js";

// Polyfill WebSocket support globally for Node.js < 22
global.WebSocket = ws as any;

const supabaseUrl = process.env.SUPABASE_URL?.trim();
const supabaseKey = process.env.SUPABASE_PUBLISHABLE_KEY?.trim();

if (!supabaseUrl || !supabaseKey) {
  throw new Error("Supabase is not configured. Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY.");
}

export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false,
  },
});

/**
 * Creates a Supabase client that acts on behalf of the logged-in user.
 * This ensures that Row Level Security (RLS) is applied correctly.
 */
export function getSupabaseUserClient(authToken: string) {
  const cleanToken = authToken.replace(/^bearer\s+/i, "").trim();
  return createClient(supabaseUrl!, supabaseKey!, {
    auth: {
      persistSession: false,
    },
    global: {
      headers: {
        Authorization: `Bearer ${cleanToken}`,
      },
    },
  });
}

/**
 * Normalizes any incoming frontend mode string to one of the 6 allowed database enum values:
 * 'standard_level_1', 'standard_level_2', 'standard_level_3', 'custom', 'foreign_origin', 'mock_bee'
 */
export function normalizeMode(mode: string, level?: number): string {
  if (mode === "standard") {
    return `standard_level_${level ?? 1}`;
  }
  if (mode.startsWith("standard_level_")) {
    return mode;
  }
  if (mode.startsWith("custom_list_") || mode === "custom") {
    return "custom";
  }
  if (mode.startsWith("foreign_origin_") || mode === "foreign_origin" || mode === "foreignOrigin") {
    return "foreign_origin";
  }
  if (mode === "mock_bee" || mode === "mock-bee") {
    return "mock_bee";
  }
  return mode;
}


export interface DBCustomList {
  id: string;
  name: string;
  owner_user_id: string;
  words: WordEntry[];
  created_at?: string;
}

/**
 * Fetch all custom word lists for a user from Supabase.
 */
export async function fetchCustomListsFromDB(authToken: string, userId: string) {
  const userClient = getSupabaseUserClient(authToken);
  const { data, error } = await userClient
    .from("custom_word_lists")
    .select("id, name, words")
    .eq("owner_user_id", userId);

  if (error) {
    throw error;
  }

  return (data || []).map((list: any) => ({
    id: list.id as string,
    name: list.name as string,
    wordCount: Array.isArray(list.words) ? list.words.length : 0,
  }));
}

/**
 * Fetch a specific custom word list by ID from Supabase.
 */
export async function fetchCustomListByIdFromDB(authToken: string, listId: string, userId: string) {
  const userClient = getSupabaseUserClient(authToken);
  const { data, error } = await userClient
    .from("custom_word_lists")
    .select("id, name, words, owner_user_id")
    .eq("id", listId)
    .eq("owner_user_id", userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data as DBCustomList | null;
}

/**
 * Upsert (save/update) a custom word list in Supabase.
 */
export async function saveCustomListToDB(
  authToken: string,
  userId: string,
  name: string,
  words: WordEntry[],
  listId?: string,
) {
  const userClient = getSupabaseUserClient(authToken);

  const payload: Partial<DBCustomList> = {
    name,
    owner_user_id: userId,
    words,
  };

  if (listId) {
    payload.id = listId;
  }

  const { data, error } = await userClient
    .from("custom_word_lists")
    .upsert(payload)
    .select("id, name, words")
    .single();

  if (error) {
    throw error;
  }

  return data as DBCustomList;
}

export interface UserProfile {
  id: string;
  email: string | null;
  full_name: string | null;
  theme_preference: string;
  audio_enabled: boolean;
  child_id: string | null;
  age: number | null;
  grade: string | null;
  spelling_level: string | null;
}

/**
 * Fetch the user's profile from the users table. If not found, insert a default row.
 */
export async function fetchUserProfileFromDB(authToken: string, userId: string, email?: string | null) {
  const userClient = getSupabaseUserClient(authToken);
  const { data, error } = await userClient
    .from("users")
    .select("id, email, full_name, theme_preference, audio_enabled, child_id, age, grade, spelling_level")
    .eq("id", userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    const { data: inserted, error: insertError } = await userClient
      .from("users")
      .insert({
        id: userId,
        email: email ?? null,
        theme_preference: "default",
        audio_enabled: true,
        child_id: "c1",
        age: 10,
        grade: "5",
        spelling_level: "competition",
      })
      .select("id, email, full_name, theme_preference, audio_enabled, child_id, age, grade, spelling_level")
      .maybeSingle();

    if (insertError) {
      throw insertError;
    }
    return inserted;
  }

  return data;
}

/**
 * Update the user's profile details.
 */
export async function updateUserProfileInDB(
  authToken: string,
  userId: string,
  updates: Partial<Omit<UserProfile, "id" | "email">>,
) {
  const userClient = getSupabaseUserClient(authToken);
  const { data, error } = await userClient
    .from("users")
    .update(updates)
    .eq("id", userId)
    .select("id, email, full_name, theme_preference, audio_enabled, child_id, age, grade, spelling_level")
    .single();

  if (error) {
    throw error;
  }
  return data;
}

/**
 * Start a new practice session in the DB.
 */
export async function startPracticeSessionInDB(
  authToken: string,
  userId: string,
  mode: string,
) {
  const userClient = getSupabaseUserClient(authToken);
  const dbMode = normalizeMode(mode);

  // Check if there is an active session for this user and mode
  const { data: activeSession } = await userClient
    .from("practice_sessions")
    .select("id")
    .eq("user_id", userId)
    .eq("mode", dbMode)
    .is("session_ended_at", null)
    .order("session_started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (activeSession) {
    return activeSession.id as string;
  }

  const { data, error } = await userClient
    .from("practice_sessions")
    .insert({
      user_id: userId,
      mode: dbMode,
      session_started_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (error) {
    throw error;
  }

  return data.id as string;
}

export async function recordWordAttemptInDB(
  authToken: string,
  userId: string,
  sessionId: string,
  targetWord: string,
  childAttempt: string,
  isCorrect: boolean,
  level?: number,
  definitionViewed?: boolean,
  exampleViewed?: boolean,
  originViewed?: boolean,
  partOfSpeechViewed?: boolean,
  repeatWordCount?: number,
  usedVoiceInput?: boolean,
  mode: string = "standard",
  coachingResponse?: string,
) {
  const userClient = getSupabaseUserClient(authToken);
  const { data, error } = await userClient
    .from("word_attempts")
    .insert({
      session_id: sessionId,
      user_id: userId,
      target_word: targetWord,
      child_attempt: childAttempt,
      is_correct: isCorrect,
      level,
      definition_viewed: definitionViewed,
      example_viewed: exampleViewed,
      origin_viewed: originViewed,
      part_of_speech_viewed: partOfSpeechViewed,
      repeat_word_count: repeatWordCount || 0,
      used_voice_input: usedVoiceInput,
      coaching_response: coachingResponse,
    })
    .select("id")
    .single();

  if (error) {
    throw error;
  }

  // Update practice_sessions table in real-time
  const { data: sessionData } = await userClient
    .from("practice_sessions")
    .select("total_words_attempted, total_correct")
    .eq("id", sessionId)
    .maybeSingle();

  if (sessionData) {
    const nextWords = (sessionData.total_words_attempted || 0) + 1;
    const nextCorrect = (sessionData.total_correct || 0) + (isCorrect ? 1 : 0);
    await userClient
      .from("practice_sessions")
      .update({
        total_words_attempted: nextWords,
        total_correct: nextCorrect,
      })
      .eq("id", sessionId);
  }

  // Fetch current user_statistics for the specific normalized mode (level is null for enum modes)
  const dbMode = normalizeMode(mode, level);
  const query = userClient
    .from("user_statistics")
    .select("current_streak, best_streak, total_attempts, correct_attempts")
    .eq("user_id", userId)
    .eq("mode", dbMode)
    .is("level", null);

  const { data: stats } = await query.maybeSingle();

  const currentStreak = stats ? (stats.current_streak || 0) : 0;
  const bestStreak = stats ? (stats.best_streak || 0) : 0;
  const totalAttempts = stats ? (stats.total_attempts || 0) : 0;
  const correctAttempts = stats ? (stats.correct_attempts || 0) : 0;

  const nextStreak = isCorrect ? currentStreak + 1 : 0;
  const nextBestStreak = Math.max(bestStreak, nextStreak);
  const nextAttempts = totalAttempts + 1;
  const nextCorrectAttempts = isCorrect ? correctAttempts + 1 : correctAttempts;

  // Calculate earned badges based on stats rules
  const badges: string[] = [];
  if (nextBestStreak >= 3) badges.push("streak3");
  if (nextBestStreak >= 5) badges.push("streak5");
  if (nextBestStreak >= 10) badges.push("streak10");
  if (nextCorrectAttempts >= 25) badges.push("total25");
  if (nextCorrectAttempts >= 50) badges.push("total50");

  const { error: statsError } = await userClient
    .from("user_statistics")
    .upsert({
      user_id: userId,
      mode: dbMode,
      level: null,
      total_attempts: nextAttempts,
      correct_attempts: nextCorrectAttempts,
      current_streak: nextStreak,
      best_streak: nextBestStreak,
      badges: badges,
      updated_at: new Date().toISOString(),
    }, {
      onConflict: "user_id,mode,level"
    });

  if (statsError) {
    console.error("Failed to update user_statistics:", statsError);
  }

  return data.id as string;
}

/**
 * End a practice session in the DB.
 */
export async function endPracticeSessionInDB(
  authToken: string,
  userId: string,
  sessionId: string,
  totalWordsAttempted: number,
  totalCorrect: number,
  durationSeconds: number,
) {
  const userClient = getSupabaseUserClient(authToken);

  const { error } = await userClient
    .from("practice_sessions")
    .update({
      session_ended_at: new Date().toISOString(),
      total_words_attempted: totalWordsAttempted,
      total_correct: totalCorrect,
      duration_seconds: durationSeconds,
    })
    .eq("id", sessionId)
    .eq("user_id", userId);

  if (error) {
    throw error;
  }
}

/**
 * Fetch all statistics for a user.
 */
export async function getUserStatisticsInDB(
  authToken: string,
  userId: string,
) {
  const userClient = getSupabaseUserClient(authToken);
  const { data, error } = await userClient
    .from("user_statistics")
    .select("level, mode, current_streak, best_streak, total_attempts, correct_attempts, badges")
    .eq("user_id", userId);

  if (error) {
    throw error;
  }
  return data;
}

/**
 * Fetch all word attempts for a specific practice session.
 */
export async function getSessionAttemptsFromDB(
  authToken: string,
  userId: string,
  sessionId: string,
) {
  const userClient = getSupabaseUserClient(authToken);
  const { data, error } = await userClient
    .from("word_attempts")
    .select("*")
    .eq("session_id", sessionId)
    .eq("user_id", userId)
    .order("created_at", { ascending: true });

  if (error) {
    throw error;
  }
  return data;
}

/**
 * Fetch a user's subscription record from the DB.
 */
export async function getUserSubscriptionFromDB(
  authToken: string,
  userId: string,
) {
  const userClient = getSupabaseUserClient(authToken);
  const { data, error } = await userClient
    .from("user_subscriptions")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw error;
  }
  return data;
}

/**
 * Upsert a user's subscription record in the DB.
 */
export async function updateUserSubscriptionInDB(
  authToken: string,
  userId: string,
  subData: {
    stripeCustomerId: string | null;
    stripeSubscriptionId: string | null;
    status: string | null;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
  },
) {
  const userClient = getSupabaseUserClient(authToken);
  const { data, error } = await userClient
    .from("user_subscriptions")
    .upsert({
      user_id: userId,
      stripe_customer_id: subData.stripeCustomerId,
      stripe_subscription_id: subData.stripeSubscriptionId,
      status: subData.status,
      current_period_end: subData.currentPeriodEnd,
      cancel_at_period_end: subData.cancelAtPeriodEnd,
      updated_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) {
    throw error;
  }
  return data;
}