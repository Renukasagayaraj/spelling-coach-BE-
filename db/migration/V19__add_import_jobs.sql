create table if not exists public.import_jobs (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null,
  filename text,
  total_words integer not null default 0,
  processed_words integer not null default 0,
  failed_words integer not null default 0,
  error_summary jsonb not null default '{}'::jsonb,
  result jsonb,
  error text,
  created_at bigint not null,
  started_at bigint,
  completed_at bigint
);

alter table public.import_jobs enable row level security;

drop policy if exists "Users can manage own import jobs" on public.import_jobs;
create policy "Users can manage own import jobs" on public.import_jobs
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);