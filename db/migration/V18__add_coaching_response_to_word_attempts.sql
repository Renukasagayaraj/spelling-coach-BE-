-- V18: Add coaching_response column to word_attempts table
ALTER TABLE public.word_attempts 
  ADD COLUMN IF NOT EXISTS coaching_response jsonb;
