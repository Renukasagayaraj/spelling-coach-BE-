-- V10: Rename columns and add badges column in user_statistics table
ALTER TABLE public.user_statistics 
  RENAME COLUMN total_correct TO mastered_words;

ALTER TABLE public.user_statistics 
  RENAME COLUMN longest_streak TO best_streak;

ALTER TABLE public.user_statistics 
  ADD COLUMN IF NOT EXISTS badges text[] DEFAULT '{}';
