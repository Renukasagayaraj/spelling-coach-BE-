-- Combined migration containing changes from V4 to V19

-- ==========================================
-- 4: Allow authenticated users to insert their own profile row if it is missing
-- ==========================================
DROP POLICY IF EXISTS "Users can insert own profile" ON public.users;
CREATE POLICY "Users can insert own profile" ON public.users
  FOR INSERT
  WITH CHECK (auth.uid() = id);

-- ==========================================
-- 5: remove unwanted word attempts fields
-- ==========================================
ALTER TABLE public.word_attempts 
  DROP COLUMN IF EXISTS near_miss,
  DROP COLUMN IF EXISTS error_types,
  DROP COLUMN IF EXISTS supports_used,
  DROP COLUMN IF EXISTS teaching_strategy,
  DROP COLUMN IF EXISTS confidence_level;

-- ==========================================
-- 6: add metadata fields to word attempts
-- ==========================================
ALTER TABLE public.word_attempts 
  ADD COLUMN IF NOT EXISTS definition text,
  ADD COLUMN IF NOT EXISTS origin text,
  ADD COLUMN IF NOT EXISTS example_sentence text,
  ADD COLUMN IF NOT EXISTS part_of_speech text;

-- ==========================================
-- 7: add level and support flags to word attempts
-- ==========================================
-- 1. Drop the metadata fields we don't need anymore
ALTER TABLE public.word_attempts 
  DROP COLUMN IF EXISTS definition CASCADE,
  DROP COLUMN IF EXISTS origin CASCADE,
  DROP COLUMN IF EXISTS example_sentence CASCADE,
  DROP COLUMN IF EXISTS part_of_speech CASCADE;

-- 2. Add the level and tracking flags
ALTER TABLE public.word_attempts
  ADD COLUMN IF NOT EXISTS level integer,
  ADD COLUMN IF NOT EXISTS definition_viewed boolean default false,
  ADD COLUMN IF NOT EXISTS example_viewed boolean default false,
  ADD COLUMN IF NOT EXISTS origin_viewed boolean default false,
  ADD COLUMN IF NOT EXISTS part_of_speech_viewed boolean default false,
  ADD COLUMN IF NOT EXISTS repeat_word_count integer default 0,
  ADD COLUMN IF NOT EXISTS used_voice_input boolean default false;

-- ==========================================
-- 8: add gamification fields to users (actually drops attempt_number)
-- ==========================================
ALTER TABLE public.word_attempts 
  DROP COLUMN IF EXISTS attempt_number CASCADE;

-- ==========================================
-- 9: add unique constraint to user statistics
-- ==========================================
ALTER TABLE public.user_statistics 
  ADD CONSTRAINT user_statistics_user_id_key UNIQUE (user_id);

-- ==========================================
-- 10: Rename columns and add badges column in user_statistics table
-- ==========================================
ALTER TABLE public.user_statistics 
  RENAME COLUMN total_correct TO mastered_words;

ALTER TABLE public.user_statistics 
  RENAME COLUMN longest_streak TO best_streak;

ALTER TABLE public.user_statistics 
  ADD COLUMN IF NOT EXISTS badges text[] DEFAULT '{}';

-- ==========================================
-- 11: Drop duplicate words_mastered column from user_statistics table
-- ==========================================
ALTER TABLE public.user_statistics 
  DROP COLUMN IF EXISTS words_mastered;

-- ==========================================
-- 12: Drop average_accuracy column from user_statistics table
-- ==========================================
ALTER TABLE public.user_statistics 
  DROP COLUMN IF EXISTS average_accuracy;

-- ==========================================
-- 13: Drop accuracy_percentage column from practice_sessions table
-- ==========================================
ALTER TABLE public.practice_sessions 
  DROP COLUMN IF EXISTS accuracy_percentage;

-- ==========================================
-- 14: Add level column and update unique constraint to support per-level stats
-- ==========================================
ALTER TABLE public.user_statistics 
  ADD COLUMN IF NOT EXISTS level integer DEFAULT 1 NOT NULL;

-- Drop the old unique constraint on user_id
ALTER TABLE public.user_statistics 
  DROP CONSTRAINT IF EXISTS user_statistics_user_id_key;

-- Add the new unique constraint on (user_id, level)
ALTER TABLE public.user_statistics 
  ADD CONSTRAINT user_statistics_user_id_level_key UNIQUE (user_id, level);

-- ==========================================
-- 15: remove unused fields from user statistics
-- ==========================================
-- Drop total_sessions and last_practice_date columns from user_statistics table
ALTER TABLE user_statistics DROP COLUMN total_sessions;
ALTER TABLE user_statistics DROP COLUMN last_practice_date;

-- ==========================================
-- 16: Add practice_mode to user_statistics for separate streak tracking by mode
-- ==========================================
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

-- ==========================================
-- 17: Allow NULL values in level column for non-standard practice modes
-- ==========================================
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

-- ==========================================
-- 18: Add coaching_response column to word_attempts table
-- ==========================================
ALTER TABLE public.word_attempts 
  ADD COLUMN IF NOT EXISTS coaching_response jsonb;

-- ==========================================
-- 19: Change coaching_response column type from jsonb to text
-- ==========================================
ALTER TABLE public.word_attempts 
  ALTER COLUMN coaching_response TYPE text;
