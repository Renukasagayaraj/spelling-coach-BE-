alter table public.weekly_email_sends
  add column if not exists retry_count integer not null default 0,
  add column if not exists last_error text,
  add column if not exists last_attempted_at timestamp with time zone,
  add column if not exists provider_message_id text;

alter table public.weekly_email_sends
  drop constraint if exists weekly_email_sends_status_check;

alter table public.weekly_email_sends
  add constraint weekly_email_sends_status_check
  check (status in ('sending', 'sent', 'failed', 'sent_pending_persist'));

alter table public.weekly_email_sends
  drop constraint if exists weekly_email_sends_retry_count_check;

alter table public.weekly_email_sends
  add constraint weekly_email_sends_retry_count_check
  check (retry_count >= 0);

create index if not exists idx_weekly_email_sends_retryable
  on public.weekly_email_sends(week_start, retry_count)
  where status = 'failed';
