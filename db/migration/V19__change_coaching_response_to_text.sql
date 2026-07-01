-- V19: Change coaching_response column type from jsonb to text
ALTER TABLE public.word_attempts 
  ALTER COLUMN coaching_response TYPE text;
