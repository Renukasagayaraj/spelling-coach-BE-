-- Keep an explicit activity timestamp for every practice session. A newly
-- created session is active immediately, even before its first word attempt.
alter table public.practice_sessions
add column if not exists last_activity_at timestamptz;

-- Preserve the real activity time for existing sessions. If a session has no
-- attempts, its start time is the best available activity timestamp.
update public.practice_sessions as ps
set last_activity_at = coalesce(
  (
    select max(wa.created_at)
    from public.word_attempts as wa
    where wa.session_id = ps.id
  ),
  ps.session_started_at,
  ps.created_at,
  now()
)
where ps.last_activity_at is null;

alter table public.practice_sessions
alter column last_activity_at set default now();

alter table public.practice_sessions
alter column last_activity_at set not null;

create index if not exists idx_practice_sessions_active_last_activity
on public.practice_sessions(last_activity_at)
where status = 'active';

-- This trigger covers every attempt-writing path, including authenticated,
-- guest, Standard Practice, Mock Bee, and future server-side RPCs.
create or replace function public.touch_practice_session_last_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.practice_sessions
  set last_activity_at = greatest(last_activity_at, new.created_at)
  where id = new.session_id;

  return new;
end;
$$;

drop trigger if exists trg_word_attempt_touch_session_activity
on public.word_attempts;

create trigger trg_word_attempt_touch_session_activity
after insert on public.word_attempts
for each row
execute function public.touch_practice_session_last_activity();

-- Mark every stale active session abandoned in one indexed update. The end
-- time is the exact timeout point rather than the later time at which the cron
-- worker happened to run.
create or replace function public.abandon_inactive_practice_sessions(
  p_inactive_for interval default interval '30 minutes'
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_abandoned_count integer;
begin
  if p_inactive_for is null or p_inactive_for <= interval '0 seconds' then
    raise exception 'p_inactive_for must be greater than zero';
  end if;

  update public.practice_sessions
  set status = 'abandoned',
      session_ended_at = last_activity_at + p_inactive_for,
      duration_seconds = greatest(
        0,
        round(extract(epoch from (
          (last_activity_at + p_inactive_for) - session_started_at
        )))::integer
      )
  where status = 'active'
    and session_ended_at is null
    and last_activity_at <= now() - p_inactive_for;

  get diagnostics v_abandoned_count = row_count;
  return v_abandoned_count;
end;
$$;

-- These functions mutate sessions globally, so browser roles must not be able
-- to call them directly. The trigger and database cron can still execute them.
revoke all on function public.touch_practice_session_last_activity() from public;
revoke all on function public.abandon_inactive_practice_sessions(interval) from public;

-- Supabase Cron is backed by pg_cron and runs even when the application is
-- offline. Running once per minute abandons a session between 30 and 31 minutes
-- after its last word submission.
create extension if not exists pg_cron;

select cron.schedule(
  'abandon-inactive-practice-sessions',
  '* * * * *',
  $cron$select public.abandon_inactive_practice_sessions(interval '30 minutes');$cron$
);
