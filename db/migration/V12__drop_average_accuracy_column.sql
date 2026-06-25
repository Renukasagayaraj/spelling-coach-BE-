-- V12: Drop average_accuracy column from user_statistics table
ALTER TABLE public.user_statistics 
  DROP COLUMN IF EXISTS average_accuracy;
