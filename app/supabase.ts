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
  const { data, error } = await userClient
    .from("practice_sessions")
    .insert({
      user_id: userId,
      mode,
      session_started_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (error) {
    throw error;
  }

  // Update total_sessions in user_statistics
  const { data: stats } = await userClient
    .from("user_statistics")
    .select("total_sessions")
    .eq("user_id", userId)
    .maybeSingle();

  const nextSessions = (stats?.total_sessions || 0) + 1;

  const { error: statsError } = await userClient
    .from("user_statistics")
    .upsert({
      user_id: userId,
      total_sessions: nextSessions,
      last_practice_date: new Date().toISOString(),
    }, {
      onConflict: "user_id"
    });

  if (statsError) {
    console.error("Failed to update total_sessions in user_statistics:", statsError);
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
    })
    .select("id")
    .single();

  if (error) {
    throw error;
  }

  // Fetch current user_statistics
  const { data: stats } = await userClient
    .from("user_statistics")
    .select("current_streak, best_streak, total_attempts, mastered_words")
    .eq("user_id", userId)
    .maybeSingle();

  const currentStreak = stats ? (stats.current_streak || 0) : 0;
  const bestStreak = stats ? (stats.best_streak || 0) : 0;
  const totalAttempts = stats ? (stats.total_attempts || 0) : 0;
  const masteredWords = stats ? (stats.mastered_words || 0) : 0;

  const nextStreak = isCorrect ? currentStreak + 1 : 0;
  const nextBestStreak = Math.max(bestStreak, nextStreak);
  const nextAttempts = totalAttempts + 1;
  const nextMasteredWords = isCorrect ? masteredWords + 1 : masteredWords;

  // Calculate earned badges based on stats rules
  const badges: string[] = [];
  if (nextBestStreak >= 3) badges.push("streak3");
  if (nextBestStreak >= 5) badges.push("streak5");
  if (nextBestStreak >= 10) badges.push("streak10");
  if (nextMasteredWords >= 25) badges.push("total25");
  if (nextMasteredWords >= 50) badges.push("total50");

  const { error: statsError } = await userClient
    .from("user_statistics")
    .upsert({
      user_id: userId,
      total_attempts: nextAttempts,
      mastered_words: nextMasteredWords,
      current_streak: nextStreak,
      best_streak: nextBestStreak,
      badges: badges,
      last_practice_date: new Date().toISOString(),
    }, {
      onConflict: "user_id"
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
  const accuracyPercentage = totalWordsAttempted > 0 ? (totalCorrect / totalWordsAttempted) * 100 : 0;
  
  const { error } = await userClient
    .from("practice_sessions")
    .update({
      session_ended_at: new Date().toISOString(),
      total_words_attempted: totalWordsAttempted,
      total_correct: totalCorrect,
      accuracy_percentage: accuracyPercentage,
      duration_seconds: durationSeconds,
    })
    .eq("id", sessionId)
    .eq("user_id", userId);

  if (error) {
    throw error;
  }
}


