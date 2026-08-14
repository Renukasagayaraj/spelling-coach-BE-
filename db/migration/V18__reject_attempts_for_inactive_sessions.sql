-- Serialize attempt recording with inactivity cleanup. If the cron worker has
-- already abandoned a session, no client (including a stale browser tab) may
-- append another word attempt to it.
create or replace function public.require_active_practice_session_for_attempt()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  if new.session_id is null then
    raise exception 'PRACTICE_SESSION_REQUIRED' using errcode = 'P0001';
  end if;

  select status
  into v_status
  from public.practice_sessions
  where id = new.session_id
  for update;

  if not found then
    raise exception 'PRACTICE_SESSION_NOT_FOUND' using errcode = 'P0001';
  end if;

  if v_status <> 'active' then
    raise exception 'PRACTICE_SESSION_NOT_ACTIVE' using errcode = 'P0001';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_word_attempt_require_active_session
on public.word_attempts;

create trigger trg_word_attempt_require_active_session
before insert on public.word_attempts
for each row
execute function public.require_active_practice_session_for_attempt();

revoke all on function public.require_active_practice_session_for_attempt()
from public;
