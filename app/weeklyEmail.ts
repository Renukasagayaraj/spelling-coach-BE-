import { createClient } from "@supabase/supabase-js";

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

function emailHtml(name: string, summary: WeeklySummary, start: Date, end: Date) {
  const accuracy = summary.wordsPracticed
    ? Math.round((summary.correctAnswers / summary.wordsPracticed) * 100)
    : 0;
  const dates = `${start.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}–${new Date(end.getTime() - 1).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}`;
  return `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#1e3a5f;line-height:1.5">
    <h1>Weekly Spelling Scholar progress</h1><p>Hello ${name},</p>
    <p>Here is the learning summary for ${dates}.</p>
    <table role="presentation" style="border-collapse:collapse"><tr>
      <td style="padding:12px 20px;background:#f3f7fb"><strong>${summary.sessions}</strong><br>sessions</td>
      <td style="padding:12px 20px;background:#f3f7fb"><strong>${summary.wordsPracticed}</strong><br>words practiced</td>
      <td style="padding:12px 20px;background:#f3f7fb"><strong>${accuracy}%</strong><br>accuracy</td>
    </tr></table>
    <p><a href="${reportUrl()}" style="display:inline-block;padding:10px 16px;background:#1e3a5f;color:#fff;text-decoration:none;border-radius:6px">View full report</a></p>
    <p style="font-size:12px;color:#667085">You receive this because weekly progress emails are enabled in your Spelling Scholar profile. You can turn them off there at any time.</p>
  </body></html>`;
}

async function sendWithResend(to: string, html: string) {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.WEEKLY_EMAIL_FROM?.trim();
  if (!apiKey || !from) throw new Error("Weekly email requires RESEND_API_KEY and WEEKLY_EMAIL_FROM.");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject: "Your weekly Spelling Scholar progress", html }),
  });
  if (!response.ok) throw new Error(`Resend email failed: ${response.status} ${await response.text()}`);
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
    const { error: claimError } = await db.from("weekly_email_sends")
      .insert({ user_id: recipient.id, week_start: weekStart, status: "sending" });
    if (claimError) { skipped++; continue; }
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
      if (!wordsPracticed) { await db.from("weekly_email_sends").delete().eq("user_id", recipient.id).eq("week_start", weekStart); skipped++; continue; }
      await sendWithResend(recipient.email, emailHtml(recipient.full_name || "there", {
        sessions: sessions ?? 0, wordsPracticed, correctAnswers: attempts?.filter((attempt) => attempt.is_correct).length ?? 0,
      }, start, end));
      const { error: updateError } = await db.from("weekly_email_sends")
        .update({ status: "sent", sent_at: new Date().toISOString() })
        .eq("user_id", recipient.id).eq("week_start", weekStart);
      if (updateError) throw updateError;
      sent++;
    } catch (error) {
      await db.from("weekly_email_sends").delete().eq("user_id", recipient.id).eq("week_start", weekStart);
      failures.push(`${recipient.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { weekStart, sent, skipped, failures };
}
