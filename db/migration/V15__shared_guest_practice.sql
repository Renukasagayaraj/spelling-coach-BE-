create table if not exists public.guest_identities (
  id uuid primary key,
  ip_hash text,
  country text,
  region text,
  city text,
  claimed_by_user_id uuid references public.users(id) on delete set null,
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

alter table public.practice_sessions alter column user_id drop not null;
alter table public.practice_sessions add column if not exists guest_id uuid references public.guest_identities(id) on delete cascade;
alter table public.practice_sessions add column if not exists origin_guest_id uuid references public.guest_identities(id) on delete set null;
alter table public.practice_sessions drop constraint if exists practice_sessions_owner_check;
alter table public.practice_sessions add constraint practice_sessions_owner_check check (
  (user_id is not null and guest_id is null) or (user_id is null and guest_id is not null)
);

alter table public.word_attempts alter column user_id drop not null;
alter table public.word_attempts add column if not exists guest_id uuid references public.guest_identities(id) on delete cascade;
alter table public.word_attempts add column if not exists origin_guest_id uuid references public.guest_identities(id) on delete set null;
alter table public.word_attempts drop constraint if exists word_attempts_owner_check;
alter table public.word_attempts add constraint word_attempts_owner_check check (
  (user_id is not null and guest_id is null) or (user_id is null and guest_id is not null)
);

create index if not exists idx_sessions_guest_status on public.practice_sessions(guest_id, status, session_started_at);
create index if not exists idx_attempts_guest_created on public.word_attempts(guest_id, created_at);
create index if not exists idx_attempts_origin_guest on public.word_attempts(origin_guest_id);
create index if not exists idx_guest_identities_ip_hash on public.guest_identities(ip_hash);
alter table public.guest_identities enable row level security;

create or replace function public.record_guest_standard_attempt(
  p_guest_id uuid, p_session_id uuid, p_target_word text, p_child_attempt text,
  p_is_correct boolean, p_level integer, p_definition_viewed boolean,
  p_example_viewed boolean, p_origin_viewed boolean, p_part_of_speech_viewed boolean,
  p_repeat_word_count integer, p_used_voice_input boolean,
  p_coaching_response jsonb, p_limit integer default 30
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_attempt_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_guest_id::text, 0));
  if exists (select 1 from guest_identities where id = p_guest_id and claimed_by_user_id is not null) then
    raise exception 'GUEST_ID_ALREADY_CLAIMED' using errcode = 'P0001';
  end if;
  if not exists (select 1 from practice_sessions where id = p_session_id and guest_id = p_guest_id and status = 'active') then
    raise exception 'Guest practice session was not found.' using errcode = 'P0001';
  end if;
  if (select count(*) from word_attempts where origin_guest_id = p_guest_id) >= p_limit then
    raise exception 'GUEST_WORD_LIMIT_REACHED' using errcode = 'P0001';
  end if;

  insert into word_attempts (
    session_id, guest_id, origin_guest_id, target_word, child_attempt, is_correct, level,
    definition_viewed, example_viewed, origin_viewed, part_of_speech_viewed,
    repeat_word_count, used_voice_input, coaching_response
  ) values (
    p_session_id, p_guest_id, p_guest_id, p_target_word, p_child_attempt, p_is_correct, p_level,
    p_definition_viewed, p_example_viewed, p_origin_viewed, p_part_of_speech_viewed,
    coalesce(p_repeat_word_count, 0), p_used_voice_input, p_coaching_response
  ) returning id into v_attempt_id;

  update practice_sessions set total_words_attempted = total_words_attempted + 1,
    total_correct = total_correct + case when p_is_correct then 1 else 0 end
  where id = p_session_id;
  return v_attempt_id;
end;
$$;

create or replace function public.claim_guest_identity(p_guest_id uuid, p_user_id uuid)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid; v_transferred integer := 0; v_mode record; v_attempt record;
  v_total integer; v_correct integer; v_current integer; v_best integer; v_badges text[];
begin
  perform pg_advisory_xact_lock(hashtextextended(p_guest_id::text, 0));
  select claimed_by_user_id into v_owner from guest_identities where id = p_guest_id for update;
  if not found then return 0; end if;
  if v_owner is not null and v_owner <> p_user_id then return 0; end if;

  update guest_identities set claimed_by_user_id = p_user_id,
    claimed_at = coalesce(claimed_at, now()), last_seen_at = now() where id = p_guest_id;
  update practice_sessions set user_id = p_user_id, guest_id = null,
    status = case when status = 'active' then 'completed' else status end,
    session_ended_at = case when status = 'active' then coalesce(session_ended_at, now()) else session_ended_at end
  where guest_id = p_guest_id;
  update word_attempts set user_id = p_user_id, guest_id = null where guest_id = p_guest_id;
  get diagnostics v_transferred = row_count;

  for v_mode in select distinct mode from practice_sessions where user_id = p_user_id and mode like 'standard_level_%'
  loop
    v_total := 0; v_correct := 0; v_current := 0; v_best := 0; v_badges := '{}';
    for v_attempt in
      select wa.is_correct from word_attempts wa join practice_sessions ps on ps.id = wa.session_id
      where wa.user_id = p_user_id and ps.mode = v_mode.mode order by wa.created_at
    loop
      v_total := v_total + 1;
      if v_attempt.is_correct then
        v_correct := v_correct + 1; v_current := v_current + 1; v_best := greatest(v_best, v_current);
      else v_current := 0;
      end if;
    end loop;
    if v_best >= 3 then v_badges := array_append(v_badges, 'streak3'); end if;
    if v_best >= 5 then v_badges := array_append(v_badges, 'streak5'); end if;
    if v_best >= 10 then v_badges := array_append(v_badges, 'streak10'); end if;
    if v_correct >= 25 then v_badges := array_append(v_badges, 'total25'); end if;
    if v_correct >= 50 then v_badges := array_append(v_badges, 'total50'); end if;
    insert into user_statistics (user_id, mode, origin_language, custom_list_id, total_attempts,
      correct_attempts, current_streak, best_streak, badges, updated_at)
    values (p_user_id, v_mode.mode, null, null, v_total, v_correct, v_current, v_best, v_badges, now())
    on conflict (user_id, mode, origin_language, custom_list_id) do update set
      total_attempts = excluded.total_attempts, correct_attempts = excluded.correct_attempts,
      current_streak = excluded.current_streak, best_streak = excluded.best_streak,
      badges = excluded.badges, updated_at = excluded.updated_at;
  end loop;
  return v_transferred;
end;
$$;

revoke all on function public.record_guest_standard_attempt(uuid,uuid,text,text,boolean,integer,boolean,boolean,boolean,boolean,integer,boolean,jsonb,integer) from public;
grant execute on function public.record_guest_standard_attempt(uuid,uuid,text,text,boolean,integer,boolean,boolean,boolean,boolean,integer,boolean,jsonb,integer) to service_role;
revoke all on function public.claim_guest_identity(uuid,uuid) from public;
grant execute on function public.claim_guest_identity(uuid,uuid) to service_role;
