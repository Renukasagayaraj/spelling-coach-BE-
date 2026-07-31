-- Parent/account holders must explicitly opt in before receiving progress emails.
alter table public.users
  add column if not exists weekly_email_enabled boolean not null default false;

-- One row per user and reporting week makes the scheduled task idempotent.
create table if not exists public.weekly_email_sends (
  user_id uuid not null references public.users(id) on delete cascade,
  week_start date not null,
  status text not null check (status in ('sending', 'sent')),
  sent_at timestamp with time zone,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  primary key (user_id, week_start)
);

alter table public.weekly_email_sends enable row level security;
create index if not exists idx_weekly_email_sends_week_start
  on public.weekly_email_sends(week_start);
