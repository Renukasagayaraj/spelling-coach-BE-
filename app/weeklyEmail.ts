import { createClient } from "@supabase/supabase-js";
import { logError, logWarn } from "./logging.js";

const MAX_SEND_ATTEMPTS = 3;
const SENT_PERSIST_ATTEMPTS = 3;

type WeeklyEmailSendStatus =
  | "sending"
  | "sent"
  | "failed"
  | "sent_pending_persist";

type WeeklyEmailClaim = {
  retryCount: number;
};

class DefiniteEmailSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DefiniteEmailSendError";
  }
}

type EmailRecipient = {
  id: string;
  email: string;
  full_name: string | null;
};

type WeeklySummary = {
  sessions: number;
  wordsPracticed: number;
  correctAnswers: number;
};

function serviceClient() {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    throw new Error("Weekly email requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

function weekBounds(now = new Date()) {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const daysSinceMonday = (end.getUTCDay() + 6) % 7;
  end.setUTCDate(end.getUTCDate() - daysSinceMonday);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 7);
  return { start, end, weekStart: start.toISOString().slice(0, 10) };
}

function reportUrl() {
  return `${(process.env.APP_BASE_URL || "").replace(/\/$/, "")}/reports`;
}

function profileUrl() {
  return `${(process.env.APP_BASE_URL || "").replace(/\/$/, "")}/profile`;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] ?? character);
}

function recipientGreeting(recipient: EmailRecipient) {
  const fullName = recipient.full_name?.trim();
  if (fullName) return fullName;
  return recipient.email.split("@")[0] || "there";
}

function emailHtml(recipient: EmailRecipient, summary: WeeklySummary, start: Date, end: Date) {
  const accuracy = summary.wordsPracticed
    ? Math.round((summary.correctAnswers / summary.wordsPracticed) * 100)
    : 0;
  const dates = `${start.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}–${new Date(end.getTime() - 1).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}`;
  return `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#1e3a5f;line-height:1.5">
    <h1>Weekly Spelling Scholar progress</h1><p>Hello ${escapeHtml(recipientGreeting(recipient))},</p>
    <p>Here is the learning summary for ${dates}.</p>
    <table role="presentation" style="border-collapse:collapse"><tr>
      <td style="padding:12px 20px;background:#f3f7fb"><strong>${summary.sessions}</strong><br>sessions</td>
      <td style="padding:12px 20px;background:#f3f7fb"><strong>${summary.wordsPracticed}</strong><br>words practiced</td>
      <td style="padding:12px 20px;background:#f3f7fb"><strong>${accuracy}%</strong><br>accuracy</td>
    </tr></table>
    <p><a href="${reportUrl()}" style="display:inline-block;padding:10px 16px;background:#1e3a5f;color:#fff;text-decoration:none;border-radius:6px">View full report</a></p>
    <p style="font-size:12px;color:#667085">You receive this because weekly progress emails are enabled in your Spelling Scholar profile. You can <a href="${profileUrl()}" style="color:#1e3a5f">turn them off in Profile</a> at any time.</p>
  </body></html>`;
}

async function sendWithResend(to: string, html: string): Promise<string | null> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.WEEKLY_EMAIL_FROM?.trim();
  if (!apiKey || !from) {
    // No provider request can occur without this configuration, so retrying is
    // safe (and remains bounded by MAX_SEND_ATTEMPTS).
    throw new DefiniteEmailSendError(
      "Weekly email requires RESEND_API_KEY and WEEKLY_EMAIL_FROM.",
    );
  }
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject: "Your weekly Spelling Scholar progress", html }),
  });
  if (!response.ok) {
    const responseText = await response.text().catch(() => "Response body unavailable");
    throw new DefiniteEmailSendError(
      `Resend email failed: ${response.status} ${responseText}`,
    );
  }

  const result = await response.json().catch(() => null) as { id?: unknown } | null;
  return typeof result?.id === "string" ? result.id : null;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function claimWeeklyEmail(
  db: ReturnType<typeof serviceClient>,
  userId: string,
  weekStart: string,
): Promise<WeeklyEmailClaim | null> {
  const attemptedAt = new Date().toISOString();
  const { error: insertError } = await db.from("weekly_email_sends").insert({
    user_id: userId,
    week_start: weekStart,
    status: "sending" satisfies WeeklyEmailSendStatus,
    last_attempted_at: attemptedAt,
  });
  if (!insertError) return { retryCount: 0 };

  // An insert normally fails because the user/week primary key already exists.
  // Read the row so other database failures are not silently treated as duplicates.
  const { data: existing, error: lookupError } = await db
    .from("weekly_email_sends")
    .select("status, retry_count")
    .eq("user_id", userId)
    .eq("week_start", weekStart)
    .maybeSingle();
  if (lookupError) throw lookupError;
  if (!existing) throw insertError;

  const retryCount = Number(existing.retry_count ?? 0);
  if (existing.status !== "failed") return null;
  if (retryCount >= MAX_SEND_ATTEMPTS) {
    logError("Weekly email reached the automatic retry limit.", {
      userId,
      weekStart,
      retryCount,
    });
    return null;
  }

  // The status and retry count conditions make this an atomic retry claim. If
  // another cron worker claimed it first, this update returns no row.
  const { data: claimed, error: claimError } = await db
    .from("weekly_email_sends")
    .update({
      status: "sending" satisfies WeeklyEmailSendStatus,
      last_attempted_at: attemptedAt,
      last_error: null,
    })
    .eq("user_id", userId)
    .eq("week_start", weekStart)
    .eq("status", "failed")
    .eq("retry_count", retryCount)
    .select("retry_count")
    .maybeSingle();
  if (claimError) throw claimError;
  return claimed ? { retryCount } : null;
}

async function persistSentStatus(
  db: ReturnType<typeof serviceClient>,
  userId: string,
  weekStart: string,
  providerMessageId: string | null,
): Promise<boolean> {
  const sentAt = new Date().toISOString();
  for (let attempt = 1; attempt <= SENT_PERSIST_ATTEMPTS; attempt += 1) {
    const { data, error } = await db
      .from("weekly_email_sends")
      .update({
        status: "sent" satisfies WeeklyEmailSendStatus,
        sent_at: sentAt,
        provider_message_id: providerMessageId,
        last_attempted_at: sentAt,
        last_error: null,
      })
      .eq("user_id", userId)
      .eq("week_start", weekStart)
      .eq("status", "sending")
      .select("status")
      .maybeSingle();
    if (!error && data) return true;

    // A database response can fail after the update was committed. Re-read the
    // row so an already-persisted success is still recognized.
    const { data: current } = await db
      .from("weekly_email_sends")
      .select("status")
      .eq("user_id", userId)
      .eq("week_start", weekStart)
      .maybeSingle();
    if (current?.status === "sent") return true;

    logWarn("Retrying weekly email sent-status persistence.", {
      userId,
      weekStart,
      attempt,
      error: error ? errorMessage(error) : "Tracking row was not updated.",
    });
  }
  return false;
}

async function markNonRetriable(
  db: ReturnType<typeof serviceClient>,
  userId: string,
  weekStart: string,
  error: unknown,
  providerMessageId: string | null,
) {
  const { error: updateError } = await db
    .from("weekly_email_sends")
    .update({
      status: "sent_pending_persist" satisfies WeeklyEmailSendStatus,
      provider_message_id: providerMessageId,
      last_error: errorMessage(error),
      last_attempted_at: new Date().toISOString(),
    })
    .eq("user_id", userId)
    .eq("week_start", weekStart)
    .eq("status", "sending");
  if (updateError) {
    // Leaving the original row as `sending` is also non-retriable and therefore
    // safer than removing it when the provider may have accepted the email.
    logError("Could not persist the non-retriable weekly email state.", {
      userId,
      weekStart,
      error: errorMessage(updateError),
    });
  }
}

async function markDefinitelyFailed(
  db: ReturnType<typeof serviceClient>,
  userId: string,
  weekStart: string,
  previousRetryCount: number,
  error: unknown,
) {
  const retryCount = previousRetryCount + 1;
  const { error: updateError } = await db
    .from("weekly_email_sends")
    .update({
      status: "failed" satisfies WeeklyEmailSendStatus,
      retry_count: retryCount,
      last_error: errorMessage(error),
      last_attempted_at: new Date().toISOString(),
    })
    .eq("user_id", userId)
    .eq("week_start", weekStart)
    .eq("status", "sending");
  if (updateError) {
    logError("Could not persist a definite weekly email failure.", {
      userId,
      weekStart,
      retryCount,
      error: errorMessage(updateError),
    });
  } else if (retryCount >= MAX_SEND_ATTEMPTS) {
    logError("Weekly email failed and reached the automatic retry limit.", {
      userId,
      weekStart,
      retryCount,
      error: errorMessage(error),
    });
  }
}

/** Sends one previous-calendar-week report per opted-in account. */
export async function sendWeeklyEmailReports(now = new Date()) {
  const db = serviceClient();
  const { start, end, weekStart } = weekBounds(now);
  const { data: recipients, error } = await db.from("users")
    .select("id, email, full_name")
    .eq("weekly_email_enabled", true)
    .not("email", "is", null);
  if (error) throw error;

  let sent = 0;
  let skipped = 0;
  const failures: string[] = [];
  for (const recipient of (recipients ?? []) as EmailRecipient[]) {
    let claim: WeeklyEmailClaim | null;
    try {
      claim = await claimWeeklyEmail(db, recipient.id, weekStart);
    } catch (error) {
      failures.push(`${recipient.id}: ${errorMessage(error)}`);
      continue;
    }
    if (!claim) {
      skipped++;
      continue;
    }

    let summary: WeeklySummary;
    try {
      const { data: attempts, error: attemptsError } = await db.from("word_attempts")
        .select("is_correct")
        .eq("user_id", recipient.id)
        .gte("created_at", start.toISOString()).lt("created_at", end.toISOString());
      if (attemptsError) throw attemptsError;
      const { count: sessions, error: sessionsError } = await db.from("practice_sessions")
        .select("id", { count: "exact", head: true })
        .eq("user_id", recipient.id)
        .gte("session_started_at", start.toISOString()).lt("session_started_at", end.toISOString());
      if (sessionsError) throw sessionsError;
      const wordsPracticed = attempts?.length ?? 0;
      if (!wordsPracticed) {
        const { error: deleteError } = await db.from("weekly_email_sends")
          .delete()
          .eq("user_id", recipient.id)
          .eq("week_start", weekStart)
          .eq("status", "sending");
        if (deleteError) throw deleteError;
        skipped++;
        continue;
      }
      summary = {
        sessions: sessions ?? 0,
        wordsPracticed,
        correctAnswers: attempts?.filter((attempt) => attempt.is_correct).length ?? 0,
      };
    } catch (error) {
      await markDefinitelyFailed(db, recipient.id, weekStart, claim.retryCount, error);
      failures.push(`${recipient.id}: ${errorMessage(error)}`);
      continue;
    }

    let providerMessageId: string | null = null;
    try {
      providerMessageId = await sendWithResend(
        recipient.email,
        emailHtml(recipient, summary, start, end),
      );
    } catch (error) {
      if (error instanceof DefiniteEmailSendError) {
        await markDefinitelyFailed(db, recipient.id, weekStart, claim.retryCount, error);
      } else {
        // Network failures and timeouts are ambiguous: the provider may have
        // accepted the message even though this process did not receive a response.
        await markNonRetriable(db, recipient.id, weekStart, error, null);
      }
      failures.push(`${recipient.id}: ${errorMessage(error)}`);
      continue;
    }

    if (await persistSentStatus(db, recipient.id, weekStart, providerMessageId)) {
      sent++;
      continue;
    }

    const persistenceError = new Error(
      "Email was sent, but its sent status could not be persisted after retries.",
    );
    await markNonRetriable(
      db,
      recipient.id,
      weekStart,
      persistenceError,
      providerMessageId,
    );
    logError("Weekly email requires sent-status reconciliation.", {
      userId: recipient.id,
      weekStart,
      providerMessageId,
    });
    failures.push(`${recipient.id}: ${persistenceError.message}`);
  }
  return { weekStart, sent, skipped, failures };
}
