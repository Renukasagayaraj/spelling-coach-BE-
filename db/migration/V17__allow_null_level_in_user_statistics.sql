-- V17: Allow NULL values in level column for non-standard practice modes

-- 1. Drop any old constraints to prevent duplicates
ALTER TABLE public.user_statistics DROP CONSTRAINT IF EXISTS user_statistics_user_id_level_key;
ALTER TABLE public.user_statistics DROP CONSTRAINT IF EXISTS user_statistics_user_mode_level_key;
ALTER TABLE public.user_statistics DROP CONSTRAINT IF EXISTS user_statistics_user_mode_key;

-- 2. Drop the NOT NULL constraint on the level column
ALTER TABLE public.user_statistics ALTER COLUMN level DROP NOT NULL;

-- 3. Add the clean user_mode_level unique constraint
ALTER TABLE public.user_statistics 
  ADD CONSTRAINT user_statistics_user_mode_level_key 
  UNIQUE NULLS NOT DISTINCT (user_id, mode, level);
