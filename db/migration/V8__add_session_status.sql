ALTER TABLE public.practice_sessions
ADD COLUMN IF NOT EXISTS status text;

UPDATE public.practice_sessions
SET status = CASE
  WHEN session_ended_at IS NULL THEN 'active'
  ELSE 'completed'
END
WHERE status IS NULL;

ALTER TABLE public.practice_sessions
ALTER COLUMN status SET DEFAULT 'active';

ALTER TABLE public.practice_sessions
ALTER COLUMN status SET NOT NULL;

ALTER TABLE public.practice_sessions
DROP CONSTRAINT IF EXISTS chk_practice_sessions_status;

ALTER TABLE public.practice_sessions
ADD CONSTRAINT chk_practice_sessions_status
CHECK (status IN ('active', 'completed', 'abandoned'));

CREATE INDEX IF NOT EXISTS idx_sessions_user_status_start
ON public.practice_sessions(user_id, status, session_started_at);
