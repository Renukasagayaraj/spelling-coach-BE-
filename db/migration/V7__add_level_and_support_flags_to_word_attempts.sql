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
