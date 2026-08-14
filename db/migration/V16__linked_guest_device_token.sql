-- Keep a claimed guest token as a restricted device credential. It may only
-- continue Standard Practice, and it consumes the linked account's allowance.

create or replace function public.get_guest_standard_attempts_used(p_guest_id uuid)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid;
  v_attempts integer;
begin
  select claimed_by_user_id into v_user_id
  from guest_identities
  where id = p_guest_id;

  if not found then
    raise exception 'GUEST_ID_NOT_FOUND' using errcode = 'P0001';
  end if;

  if v_user_id is null then
    select count(*)::integer into v_attempts
    from word_attempts
    where origin_guest_id = p_guest_id;
  else
    select count(*)::integer into v_attempts
    from word_attempts wa
    join practice_sessions ps on ps.id = wa.session_id
    where wa.user_id = v_user_id
      and (ps.mode = 'standard' or ps.mode like 'standard_level_%');
  end if;

  return coalesce(v_attempts, 0);
end;
$$;

create or replace function public.record_guest_standard_attempt(
  p_guest_id uuid, p_session_id uuid, p_target_word text, p_child_attempt text,
  p_is_correct boolean, p_level integer, p_definition_viewed boolean,
  p_example_viewed boolean, p_origin_viewed boolean, p_part_of_speech_viewed boolean,
  p_repeat_word_count integer, p_used_voice_input boolean,
  p_coaching_response jsonb, p_limit integer default 30
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_attempt_id uuid;
  v_user_id uuid;
  v_mode text;
  v_attempts_used integer;
  v_attempt record;
  v_total integer := 0;
  v_correct integer := 0;
  v_current integer := 0;
  v_best integer := 0;
  v_badges text[] := '{}';
begin
  perform pg_advisory_xact_lock(hashtextextended(p_guest_id::text, 0));

  select claimed_by_user_id into v_user_id
  from guest_identities
  where id = p_guest_id
  for update;

  if not found then
    raise exception 'GUEST_ID_NOT_FOUND' using errcode = 'P0001';
  end if;

  if v_user_id is null then
    select mode into v_mode
    from practice_sessions
    where id = p_session_id
      and guest_id = p_guest_id
      and origin_guest_id = p_guest_id
      and status = 'active';

    if not found then
      raise exception 'GUEST_SESSION_NOT_FOUND' using errcode = 'P0001';
    end if;

    select count(*)::integer into v_attempts_used
    from word_attempts
    where origin_guest_id = p_guest_id;

    if v_attempts_used >= p_limit then
      raise exception 'GUEST_WORD_LIMIT_REACHED' using errcode = 'P0001';
    end if;

    insert into word_attempts (
      session_id, user_id, guest_id, origin_guest_id, target_word, child_attempt,
      is_correct, level, definition_viewed, example_viewed, origin_viewed,
      part_of_speech_viewed, repeat_word_count, used_voice_input, coaching_response
    ) values (
      p_session_id, null, p_guest_id, p_guest_id, p_target_word, p_child_attempt,
      p_is_correct, p_level, p_definition_viewed, p_example_viewed, p_origin_viewed,
      p_part_of_speech_viewed, coalesce(p_repeat_word_count, 0), p_used_voice_input,
      p_coaching_response
    ) returning id into v_attempt_id;
  else
    -- Every linked device for the same account shares this lock and quota.
    perform pg_advisory_xact_lock(hashtextextended(v_user_id::text, 0));

    select mode into v_mode
    from practice_sessions
    where id = p_session_id
      and user_id = v_user_id
      and guest_id is null
      and origin_guest_id = p_guest_id
      and status = 'active';

    if not found then
      raise exception 'GUEST_SESSION_NOT_FOUND' using errcode = 'P0001';
    end if;

    select count(*)::integer into v_attempts_used
    from word_attempts wa
    join practice_sessions ps on ps.id = wa.session_id
    where wa.user_id = v_user_id
      and (ps.mode = 'standard' or ps.mode like 'standard_level_%');

    if v_attempts_used >= p_limit then
      raise exception 'GUEST_WORD_LIMIT_REACHED' using errcode = 'P0001';
    end if;

    insert into word_attempts (
      session_id, user_id, guest_id, origin_guest_id, target_word, child_attempt,
      is_correct, level, definition_viewed, example_viewed, origin_viewed,
      part_of_speech_viewed, repeat_word_count, used_voice_input, coaching_response
    ) values (
      p_session_id, v_user_id, null, p_guest_id, p_target_word, p_child_attempt,
      p_is_correct, p_level, p_definition_viewed, p_example_viewed, p_origin_viewed,
      p_part_of_speech_viewed, coalesce(p_repeat_word_count, 0), p_used_voice_input,
      p_coaching_response
    ) returning id into v_attempt_id;
  end if;

  update practice_sessions
  set total_words_attempted = coalesce(total_words_attempted, 0) + 1,
      total_correct = coalesce(total_correct, 0) + case when p_is_correct then 1 else 0 end
  where id = p_session_id;

  -- Unclaimed attempts are incorporated by claim_guest_identity. Linked-device
  -- attempts already belong to the account, so refresh that mode immediately.
  if v_user_id is not null then
    for v_attempt in
      select wa.is_correct
      from word_attempts wa
      join practice_sessions ps on ps.id = wa.session_id
      where wa.user_id = v_user_id and ps.mode = v_mode
      order by wa.created_at, wa.id
    loop
      v_total := v_total + 1;
      if v_attempt.is_correct then
        v_correct := v_correct + 1;
        v_current := v_current + 1;
        v_best := greatest(v_best, v_current);
      else
        v_current := 0;
      end if;
    end loop;

    if v_best >= 3 then v_badges := array_append(v_badges, 'streak3'); end if;
    if v_best >= 5 then v_badges := array_append(v_badges, 'streak5'); end if;
    if v_best >= 10 then v_badges := array_append(v_badges, 'streak10'); end if;
    if v_correct >= 25 then v_badges := array_append(v_badges, 'total25'); end if;
    if v_correct >= 50 then v_badges := array_append(v_badges, 'total50'); end if;

    insert into user_statistics (
      user_id, mode, origin_language, custom_list_id, total_attempts,
      correct_attempts, current_streak, best_streak, badges, updated_at
    ) values (
      v_user_id, v_mode, null, null, v_total,
      v_correct, v_current, v_best, v_badges, now()
    )
    on conflict (user_id, mode, origin_language, custom_list_id) do update set
      total_attempts = excluded.total_attempts,
      correct_attempts = excluded.correct_attempts,
      current_streak = excluded.current_streak,
      best_streak = excluded.best_streak,
      badges = excluded.badges,
      updated_at = excluded.updated_at;
  end if;

  return v_attempt_id;
end;
$$;

revoke all on function public.get_guest_standard_attempts_used(uuid) from public;
grant execute on function public.get_guest_standard_attempts_used(uuid) to service_role;
revoke all on function public.record_guest_standard_attempt(uuid,uuid,text,text,boolean,integer,boolean,boolean,boolean,boolean,integer,boolean,jsonb,integer) from public;
grant execute on function public.record_guest_standard_attempt(uuid,uuid,text,text,boolean,integer,boolean,boolean,boolean,boolean,integer,boolean,jsonb,integer) to service_role;
