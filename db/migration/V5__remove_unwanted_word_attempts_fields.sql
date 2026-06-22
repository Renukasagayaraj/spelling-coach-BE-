ALTER TABLE public.word_attempts 
  DROP COLUMN IF EXISTS near_miss,
  DROP COLUMN IF EXISTS error_types,
  DROP COLUMN IF EXISTS supports_used,
  DROP COLUMN IF EXISTS teaching_strategy,
  DROP COLUMN IF EXISTS confidence_level;
