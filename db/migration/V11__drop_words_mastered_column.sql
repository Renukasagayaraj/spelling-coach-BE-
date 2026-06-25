-- V11: Drop duplicate words_mastered column from user_statistics table
ALTER TABLE public.user_statistics 
  DROP COLUMN IF EXISTS words_mastered;
