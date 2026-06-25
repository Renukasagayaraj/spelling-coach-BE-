-- V14: Add level column and update unique constraint to support per-level stats
ALTER TABLE public.user_statistics 
  ADD COLUMN IF NOT EXISTS level integer DEFAULT 1 NOT NULL;

-- Drop the old unique constraint on user_id
ALTER TABLE public.user_statistics 
  DROP CONSTRAINT IF EXISTS user_statistics_user_id_key;

-- Add the new unique constraint on (user_id, level)
ALTER TABLE public.user_statistics 
  ADD CONSTRAINT user_statistics_user_id_level_key UNIQUE (user_id, level);
