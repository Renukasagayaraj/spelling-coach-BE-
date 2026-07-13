ALTER TABLE public.practice_sessions
ADD COLUMN IF NOT EXISTS session_config jsonb,
ADD COLUMN IF NOT EXISTS session_state jsonb;