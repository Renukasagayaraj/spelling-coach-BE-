ALTER TABLE public.practice_sessions
ADD COLUMN IF NOT EXISTS origin_language text,
ADD COLUMN IF NOT EXISTS custom_list_id uuid,
ADD COLUMN IF NOT EXISTS custom_list_name text;

ALTER TABLE public.user_statistics
ADD COLUMN IF NOT EXISTS origin_language text,
ADD COLUMN IF NOT EXISTS custom_list_id uuid;

ALTER TABLE public.user_statistics
DROP CONSTRAINT IF EXISTS user_statistics_user_mode_level_key;

ALTER TABLE public.user_statistics
ADD CONSTRAINT user_statistics_user_mode_level_scope_key
UNIQUE NULLS NOT DISTINCT (user_id, mode, level, origin_language, custom_list_id);

CREATE INDEX IF NOT EXISTS idx_sessions_user_mode_scope
ON public.practice_sessions(user_id, mode, origin_language, custom_list_id);

CREATE INDEX IF NOT EXISTS idx_stats_user_mode_scope
ON public.user_statistics(user_id, mode, origin_language, custom_list_id);
