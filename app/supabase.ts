import { createClient } from "@supabase/supabase-js";
// @ts-ignore
import ws from "ws";

// Polyfill WebSocket support globally for Node.js < 22
global.WebSocket = ws as any;

const supabaseUrl = process.env.SUPABASE_URL?.trim();
const supabaseKey = process.env.SUPABASE_PUBLISHABLE_KEY?.trim();

function checkSupabaseConfig() {
  if (!supabaseUrl || !supabaseKey) {
    throw new Error("Supabase is not configured. Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY.");
  }
}

export const supabase = supabaseUrl && supabaseKey
  ? createClient(supabaseUrl, supabaseKey, {
      auth: {
        persistSession: false,
      },
    })
  : null as any;

/**
 * Creates a Supabase client that acts on behalf of the logged-in user.
 * This ensures that Row Level Security (RLS) is applied correctly.
 */
export function getSupabaseUserClient(authToken: string) {
  checkSupabaseConfig();
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

export interface DBUserProfile {
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
 * Fetch user profile from the users table.
 */
export async function fetchUserProfileFromDB(authToken: string, userId: string): Promise<DBUserProfile | null> {
  const userClient = getSupabaseUserClient(authToken);

  const { data, error } = await userClient
    .from("users")
    .select("*")
    .eq("id", userId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return {
    id: data.id,
    email: data.email,
    full_name: data.full_name || null,
    theme_preference: data.theme_preference || "default",
    audio_enabled: data.audio_enabled !== false,
    child_id: data.child_id || null,
    age: data.age || null,
    grade: data.grade || null,
    spelling_level: data.spelling_level || null,
  };
}

/**
 * Save user profile updates to the users table using UPDATE (not upsert).
 */
export async function saveUserProfileToDB(
  authToken: string,
  userId: string,
  profile: Partial<DBUserProfile>
): Promise<DBUserProfile> {
  const userClient = getSupabaseUserClient(authToken);

  // Filter only valid columns to avoid DB errors
  const payload: any = {};
  if (profile.full_name !== undefined) payload.full_name = profile.full_name;
  if (profile.theme_preference !== undefined) payload.theme_preference = profile.theme_preference;
  if (profile.audio_enabled !== undefined) payload.audio_enabled = profile.audio_enabled;
  if (profile.child_id !== undefined) payload.child_id = profile.child_id;
  if (profile.age !== undefined) payload.age = profile.age;
  if (profile.grade !== undefined) payload.grade = profile.grade;
  if (profile.spelling_level !== undefined) payload.spelling_level = profile.spelling_level;

  payload.updated_at = new Date().toISOString();

  // First check if the row exists
  const { data: existingUser } = await userClient
    .from("users")
    .select("id")
    .eq("id", userId)
    .maybeSingle();

  let query;
  if (existingUser) {
    // Update existing row
    query = userClient
      .from("users")
      .update(payload)
      .eq("id", userId);
  } else {
    // Insert new row
    payload.id = userId;
    if (profile.email) {
      payload.email = profile.email;
    }
    query = userClient
      .from("users")
      .insert(payload);
  }

  const { data, error } = await query.select().single();

  if (error) {
    throw error;
  }

  return {
    id: data.id,
    email: data.email,
    full_name: data.full_name || null,
    theme_preference: data.theme_preference || "default",
    audio_enabled: data.audio_enabled !== false,
    child_id: data.child_id || null,
    age: data.age || null,
    grade: data.grade || null,
    spelling_level: data.spelling_level || null,
  };
}
