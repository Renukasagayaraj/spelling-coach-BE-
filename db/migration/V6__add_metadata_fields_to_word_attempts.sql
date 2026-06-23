ALTER TABLE public.word_attempts 
  ADD COLUMN IF NOT EXISTS definition text,
  ADD COLUMN IF NOT EXISTS origin text,
  ADD COLUMN IF NOT EXISTS example_sentence text,
  ADD COLUMN IF NOT EXISTS part_of_speech text;
