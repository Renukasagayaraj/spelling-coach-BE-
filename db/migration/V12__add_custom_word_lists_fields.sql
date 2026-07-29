-- Add missing word_count and updated_at columns to custom_word_lists table
ALTER TABLE public.custom_word_lists
  ADD COLUMN IF NOT EXISTS word_count integer DEFAULT 0;

ALTER TABLE public.custom_word_lists
  ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL;

-- Backfill word_count and updated_at for existing custom lists
UPDATE public.custom_word_lists
  SET word_count = jsonb_array_length(words),
      updated_at = created_at
  WHERE words IS NOT NULL;
