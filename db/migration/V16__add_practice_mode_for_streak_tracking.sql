-- V16: Add practice_mode to user_statistics for separate streak tracking by mode
-- This allows independent streak tracking for:
-- - Standard Practice Level 1, 2, 3
-- - Custom Practice
-- - Foreign Origin Practice

-- Add mode column to identify practice type (standard, custom, foreignOrigin)
ALTER TABLE public.user_statistics 
  ADD COLUMN IF NOT EXISTS mode VARCHAR(50) DEFAULT 'standard' NOT NULL;

-- Drop the old unique constraint (user_id, level)
ALTER TABLE public.user_statistics 
  DROP CONSTRAINT IF EXISTS user_statistics_user_id_level_key;

-- Add new unique constraint covering user, mode, and level
-- Using NULLS NOT DISTINCT ensures only one custom/foreign origin row (where level is NULL) can exist per user.
ALTER TABLE public.user_statistics 
  ADD CONSTRAINT user_statistics_user_mode_level_key 
  UNIQUE NULLS NOT DISTINCT (user_id, mode, level);

-- Add index on mode for faster queries by practice type
CREATE INDEX IF NOT EXISTS idx_stats_user_mode ON public.user_statistics(user_id, mode);
