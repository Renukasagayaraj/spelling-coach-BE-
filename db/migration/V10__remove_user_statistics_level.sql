-- Standard levels are encoded in mode (standard_level_1, standard_level_2,
-- standard_level_3). Keeping a separate level column in user_statistics
-- duplicates that information.

ALTER TABLE public.user_statistics
  DROP CONSTRAINT IF EXISTS user_statistics_user_mode_level_scope_key;

-- These names are retained for databases that applied older migration layouts.
ALTER TABLE public.user_statistics
  DROP CONSTRAINT IF EXISTS user_statistics_user_mode_level_key;

ALTER TABLE public.user_statistics
  DROP CONSTRAINT IF EXISTS user_statistics_user_id_level_key;

ALTER TABLE public.user_statistics
  DROP COLUMN IF EXISTS level;

ALTER TABLE public.user_statistics
  ADD CONSTRAINT user_statistics_user_mode_scope_key
  UNIQUE NULLS NOT DISTINCT (user_id, mode, origin_language, custom_list_id);
