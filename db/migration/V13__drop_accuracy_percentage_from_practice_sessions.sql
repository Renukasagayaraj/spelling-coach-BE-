-- V13: Drop accuracy_percentage column from practice_sessions table
ALTER TABLE public.practice_sessions 
  DROP COLUMN IF EXISTS accuracy_percentage;
