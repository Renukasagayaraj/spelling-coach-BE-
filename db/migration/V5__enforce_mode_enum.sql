-- Clean up and map existing modes in user_statistics
UPDATE public.user_statistics
SET mode = 
  CASE 
    WHEN mode = 'standard' AND level = 1 THEN 'standard_level_1'
    WHEN mode = 'standard' AND level = 2 THEN 'standard_level_2'
    WHEN mode = 'standard' AND level = 3 THEN 'standard_level_3'
    WHEN mode = 'standard' THEN 'standard_level_1'
    WHEN mode = 'foreignOrigin' THEN 'foreign_origin'
    ELSE mode
  END,
  level = NULL;

-- Clean up and map existing modes in practice_sessions
UPDATE public.practice_sessions
SET mode = 
  CASE 
    WHEN mode = 'standard_level_1' THEN 'standard_level_1'
    WHEN mode = 'standard_level_2' THEN 'standard_level_2'
    WHEN mode = 'standard_level_3' THEN 'standard_level_3'
    WHEN mode = 'standard' THEN 'standard_level_1'
    WHEN mode LIKE 'custom_list_%' THEN 'custom'
    WHEN mode LIKE 'foreign_origin_%' THEN 'foreign_origin'
    WHEN mode = 'foreignOrigin' THEN 'foreign_origin'
    ELSE mode
  END;

-- Rename mastered_words in user_statistics to correct_attempts
ALTER TABLE public.user_statistics
  RENAME COLUMN mastered_words TO correct_attempts;

-- Drop check constraint if exists first to avoid duplicates/errors
ALTER TABLE public.user_statistics
  DROP CONSTRAINT IF EXISTS chk_user_statistics_mode;

-- Add check constraint to public.user_statistics
ALTER TABLE public.user_statistics
  ADD CONSTRAINT chk_user_statistics_mode 
  CHECK (mode IN ('standard_level_1', 'standard_level_2', 'standard_level_3', 'custom', 'foreign_origin', 'mock_bee'));

-- Drop check constraint if exists first to avoid duplicates/errors
ALTER TABLE public.practice_sessions
  DROP CONSTRAINT IF EXISTS chk_practice_sessions_mode;

-- Add check constraint to public.practice_sessions
ALTER TABLE public.practice_sessions
  ADD CONSTRAINT chk_practice_sessions_mode 
  CHECK (mode IN ('standard_level_1', 'standard_level_2', 'standard_level_3', 'custom', 'foreign_origin', 'mock_bee'));
