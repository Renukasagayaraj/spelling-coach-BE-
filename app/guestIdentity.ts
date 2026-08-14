import {
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { createClient } from "@supabase/supabase-js";

type GuestTokenPayload = {
  version: 1;
  guestId: string;
};

export type GuestStartResult = {
  guestToken: string;
  attemptsUsed: number;
  attemptsRemaining: number;
  limit: number;
};

export type GuestSessionStartResult =
  | { action: "created"; sessionId: string }
  | { action: "resume_existing"; sessionId: string }
  | {
      action: "active_session_conflict";
      activeSessionId: string;
      activeMode: string;
    };

export class GuestIdentityError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "GuestIdentityError";
  }
}

function guestTokenSecret(): string {
  const secret = process.env.GUEST_TOKEN_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new GuestIdentityError(
      "Guest access is not configured.",
      503,
      "GUEST_ACCESS_NOT_CONFIGURED",
    );
  }
  return secret;
}

function guestServiceClient() {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    throw new GuestIdentityError(
      "Guest access is not configured.",
      503,
      "GUEST_ACCESS_NOT_CONFIGURED",
    );
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

function normalizeGuestStandardMode(mode: string, level?: number): string {
  if (mode === "standard") {
    if (level !== 1 && level !== 2 && level !== 3) {
      throw new GuestIdentityError(
        "A Standard Practice level is required.",
        400,
        "INVALID_GUEST_PRACTICE_MODE",
      );
    }
    return `standard_level_${level}`;
  }
  if (/^standard_level_[123]$/.test(mode)) return mode;
  throw new GuestIdentityError(
    "Guests can only use Standard Practice.",
    402,
    "SUBSCRIPTION_REQUIRED",
  );
}

function signatureFor(payload: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(payload).digest();
}

export function signGuestToken(guestId: string, secret = guestTokenSecret()): string {
  const payload = Buffer.from(
    JSON.stringify({ version: 1, guestId } satisfies GuestTokenPayload),
  ).toString("base64url");
  const signature = signatureFor(payload, secret).toString("base64url");
  return `${payload}.${signature}`;
}

export function verifyGuestToken(
  token: string,
  secret = guestTokenSecret(),
): GuestTokenPayload {
  const [payload, encodedSignature, extra] = token.split(".");
  if (!payload || !encodedSignature || extra) {
    throw new GuestIdentityError("Invalid guest token.", 401, "INVALID_GUEST_TOKEN");
  }

  const receivedSignature = Buffer.from(encodedSignature, "base64url");
  const expectedSignature = signatureFor(payload, secret);
  if (
    receivedSignature.length !== expectedSignature.length
    || !timingSafeEqual(receivedSignature, expectedSignature)
  ) {
    throw new GuestIdentityError("Invalid guest token.", 401, "INVALID_GUEST_TOKEN");
  }

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (
      parsed?.version !== 1
      || typeof parsed.guestId !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.guestId)
    ) {
      throw new Error("Invalid payload");
    }
    return parsed as GuestTokenPayload;
  } catch {
    throw new GuestIdentityError("Invalid guest token.", 401, "INVALID_GUEST_TOKEN");
  }
}

function hashIpAddress(ipAddress: string | undefined, secret: string): string | null {
  const normalized = ipAddress?.trim();
  return normalized
    ? createHmac("sha256", secret).update(normalized).digest("hex")
    : null;
}

async function requireGuestIdentity(token: string) {
  const secret = guestTokenSecret();
  const guestId = verifyGuestToken(token, secret).guestId;
  const client = guestServiceClient();
  const { data, error } = await client
    .from("guest_identities")
    .select("id, claimed_by_user_id")
    .eq("id", guestId)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new GuestIdentityError("Guest identity was not found.", 401, "INVALID_GUEST_TOKEN");
  }
  return {
    client,
    guestId,
    claimedByUserId: (data.claimed_by_user_id as string | null) ?? null,
  };
}

async function countStandardAttemptsForGuestDevice(
  client: ReturnType<typeof guestServiceClient>,
  guestId: string,
): Promise<number> {
  const { data, error } = await client.rpc("get_guest_standard_attempts_used", {
    p_guest_id: guestId,
  });
  if (error) throw error;
  return Math.max(0, Number(data) || 0);
}

export async function getGuestUsage(token: string, limit: number) {
  const { client, guestId } = await requireGuestIdentity(token);
  const attemptsUsed = await countStandardAttemptsForGuestDevice(client, guestId);
  return {
    guestId,
    attemptsUsed,
    attemptsRemaining: Math.max(0, limit - attemptsUsed),
    limit,
  };
}

export async function startGuestPracticeSession(options: {
  token: string;
  mode: string;
  level?: number;
  forceCloseCurrent?: boolean;
  limit: number;
}): Promise<GuestSessionStartResult> {
  const mode = normalizeGuestStandardMode(options.mode, options.level);
  const { client, guestId, claimedByUserId } = await requireGuestIdentity(options.token);
  const attemptsUsed = await countStandardAttemptsForGuestDevice(client, guestId);
  if (attemptsUsed >= options.limit) {
    throw new GuestIdentityError(
      "Free attempt limit reached.",
      402,
      "FREE_ATTEMPT_LIMIT_REACHED",
    );
  }

  const ownerColumn = claimedByUserId ? "user_id" : "guest_id";
  const ownerId = claimedByUserId || guestId;
  const { data: activeSession, error: activeError } = await client
    .from("practice_sessions")
    .select("id, mode, session_started_at, total_words_attempted, total_correct")
    .eq(ownerColumn, ownerId)
    .eq("origin_guest_id", guestId)
    .eq("status", "active")
    .is("session_ended_at", null)
    .order("session_started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (activeError) throw activeError;

  if (activeSession) {
    if (activeSession.mode === mode) {
      return { action: "resume_existing", sessionId: activeSession.id as string };
    }
    if (!options.forceCloseCurrent) {
      return {
        action: "active_session_conflict",
        activeSessionId: activeSession.id as string,
        activeMode: activeSession.mode as string,
      };
    }
    const endedAt = new Date().toISOString();
    const durationSeconds = Math.max(
      0,
      Math.round(
        (new Date(endedAt).getTime()
          - new Date(activeSession.session_started_at as string).getTime()) / 1000,
      ),
    );
    const { error: closeError } = await client
      .from("practice_sessions")
      .update({
        status: "abandoned",
        session_ended_at: endedAt,
        duration_seconds: durationSeconds,
      })
      .eq("id", activeSession.id)
      .eq(ownerColumn, ownerId)
      .eq("origin_guest_id", guestId);
    if (closeError) throw closeError;
  }

  const { data, error } = await client
    .from("practice_sessions")
    .insert({
      user_id: claimedByUserId,
      guest_id: claimedByUserId ? null : guestId,
      origin_guest_id: guestId,
      mode,
      status: "active",
      session_started_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error) throw error;
  return { action: "created", sessionId: data!.id as string };
}

export async function getGuestPracticeSession(token: string, sessionId: string) {
  const { client, guestId, claimedByUserId } = await requireGuestIdentity(token);
  const ownerColumn = claimedByUserId ? "user_id" : "guest_id";
  const ownerId = claimedByUserId || guestId;
  const { data, error } = await client
    .from("practice_sessions")
    .select("*")
    .eq("id", sessionId)
    .eq(ownerColumn, ownerId)
    .eq("origin_guest_id", guestId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function getGuestSessionAttempts(token: string, sessionId: string) {
  const { client, guestId, claimedByUserId } = await requireGuestIdentity(token);
  const ownerColumn = claimedByUserId ? "user_id" : "guest_id";
  const ownerId = claimedByUserId || guestId;
  const { data: session, error: sessionError } = await client
    .from("practice_sessions")
    .select("id")
    .eq("id", sessionId)
    .eq(ownerColumn, ownerId)
    .eq("origin_guest_id", guestId)
    .maybeSingle();
  if (sessionError) throw sessionError;
  if (!session) {
    throw new GuestIdentityError("Guest session was not found.", 404, "GUEST_SESSION_NOT_FOUND");
  }
  const { data, error } = await client
    .from("word_attempts")
    .select("*")
    .eq("session_id", sessionId)
    .eq(ownerColumn, ownerId)
    .eq("origin_guest_id", guestId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function endGuestPracticeSession(options: {
  token: string;
  sessionId: string;
  durationSeconds: number;
}) {
  const { client, guestId, claimedByUserId } = await requireGuestIdentity(options.token);
  const ownerColumn = claimedByUserId ? "user_id" : "guest_id";
  const ownerId = claimedByUserId || guestId;
  const { data: session, error: sessionError } = await client
    .from("practice_sessions")
    .select("id")
    .eq("id", options.sessionId)
    .eq(ownerColumn, ownerId)
    .eq("origin_guest_id", guestId)
    .maybeSingle();
  if (sessionError) throw sessionError;
  if (!session) {
    throw new GuestIdentityError("Guest session was not found.", 404, "GUEST_SESSION_NOT_FOUND");
  }
  const { error } = await client
    .from("practice_sessions")
    .update({
      status: "completed",
      session_ended_at: new Date().toISOString(),
      duration_seconds: Math.max(0, Math.round(options.durationSeconds || 0)),
    })
    .eq("id", options.sessionId)
    .eq(ownerColumn, ownerId)
    .eq("origin_guest_id", guestId);
  if (error) throw error;
}

export async function recordGuestStandardAttempt(options: {
  token: string;
  sessionId: string;
  targetWord: string;
  childAttempt: string;
  isCorrect: boolean;
  level?: number;
  definitionViewed?: boolean;
  exampleViewed?: boolean;
  originViewed?: boolean;
  partOfSpeechViewed?: boolean;
  repeatWordCount?: number;
  usedVoiceInput?: boolean;
  coachingResponse?: string;
  limit: number;
}) {
  if (options.level !== 1 && options.level !== 2 && options.level !== 3) {
    throw new GuestIdentityError(
      "A Standard Practice level is required.",
      400,
      "INVALID_GUEST_PRACTICE_MODE",
    );
  }
  const { client, guestId } = await requireGuestIdentity(options.token);
  let coachingResponse: unknown = null;
  if (options.coachingResponse) {
    try {
      coachingResponse = JSON.parse(options.coachingResponse);
    } catch {
      coachingResponse = null;
    }
  }
  const { data, error } = await client.rpc("record_guest_standard_attempt", {
    p_guest_id: guestId,
    p_session_id: options.sessionId,
    p_target_word: options.targetWord,
    p_child_attempt: options.childAttempt,
    p_is_correct: options.isCorrect,
    p_level: options.level,
    p_definition_viewed: Boolean(options.definitionViewed),
    p_example_viewed: Boolean(options.exampleViewed),
    p_origin_viewed: Boolean(options.originViewed),
    p_part_of_speech_viewed: Boolean(options.partOfSpeechViewed),
    p_repeat_word_count: options.repeatWordCount || 0,
    p_used_voice_input: Boolean(options.usedVoiceInput),
    p_coaching_response: coachingResponse,
    p_limit: options.limit,
  });
  if (error) {
    if (error.message?.includes("GUEST_WORD_LIMIT_REACHED")) {
      throw new GuestIdentityError(
        "Free attempt limit reached.",
        402,
        "FREE_ATTEMPT_LIMIT_REACHED",
      );
    }
    if (error.message?.includes("GUEST_SESSION_NOT_FOUND")) {
      throw new GuestIdentityError(
        "Guest session was not found.",
        404,
        "GUEST_SESSION_NOT_FOUND",
      );
    }
    throw error;
  }
  const attemptsUsed = await countStandardAttemptsForGuestDevice(client, guestId);
  return {
    attemptId: data as string,
    attemptsUsed,
    attemptsRemaining: Math.max(0, options.limit - attemptsUsed),
    limit: options.limit,
  };
}

export async function claimGuestIdentity(token: string, userId: string) {
  const { client, guestId, claimedByUserId } = await requireGuestIdentity(token);
  if (claimedByUserId) {
    if (claimedByUserId === userId) return 0;
    throw new GuestIdentityError(
      "This device guest identity is linked to a different account.",
      409,
      "GUEST_LINKED_TO_DIFFERENT_ACCOUNT",
    );
  }
  const { data, error } = await client.rpc("claim_guest_identity", {
    p_guest_id: guestId,
    p_user_id: userId,
  });
  if (error) throw error;
  const { data: claimed, error: claimedError } = await client
    .from("guest_identities")
    .select("claimed_by_user_id")
    .eq("id", guestId)
    .single();
  if (claimedError) throw claimedError;
  if (claimed?.claimed_by_user_id !== userId) {
    throw new GuestIdentityError(
      "This device guest identity is linked to a different account.",
      409,
      "GUEST_LINKED_TO_DIFFERENT_ACCOUNT",
    );
  }
  return Math.max(0, Number(data) || 0);
}

export async function startGuestIdentity(options: {
  existingToken?: string;
  ipAddress?: string;
  limit: number;
}): Promise<GuestStartResult> {
  const secret = guestTokenSecret();
  const client = guestServiceClient();
  const ipHash = hashIpAddress(options.ipAddress, secret);
  let guestId: string;

  if (options.existingToken) {
    guestId = verifyGuestToken(options.existingToken, secret).guestId;
    const { data, error } = await client
      .from("guest_identities")
      .select("id, claimed_by_user_id")
      .eq("id", guestId)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      throw new GuestIdentityError("Guest identity was not found.", 401, "INVALID_GUEST_TOKEN");
    }
    const { error: updateError } = await client
      .from("guest_identities")
      .update({ last_seen_at: new Date().toISOString(), ip_hash: ipHash })
      .eq("id", guestId);
    if (updateError) throw updateError;
  } else {
    guestId = randomUUID();
    const { error } = await client.from("guest_identities").insert({
      id: guestId,
      ip_hash: ipHash,
    });
    if (error) throw error;
  }

  const attemptsUsed = await countStandardAttemptsForGuestDevice(client, guestId);
  return {
    guestToken: signGuestToken(guestId, secret),
    attemptsUsed,
    attemptsRemaining: Math.max(0, options.limit - attemptsUsed),
    limit: options.limit,
  };
}
