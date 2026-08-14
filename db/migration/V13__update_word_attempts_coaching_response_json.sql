DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'word_attempts'
      AND column_name = 'coaching_response'
      AND data_type <> 'jsonb'
  ) THEN
    ALTER TABLE public.word_attempts
      RENAME COLUMN coaching_response TO coaching_response_legacy;
  END IF;
END $$;

ALTER TABLE public.word_attempts
  ADD COLUMN IF NOT EXISTS coaching_response jsonb;

DO $$
DECLARE
  attempt_row RECORD;
BEGIN
  FOR attempt_row IN
    SELECT id, coaching_response_legacy
    FROM public.word_attempts
    WHERE coaching_response_legacy IS NOT NULL
      AND coaching_response IS NULL
  LOOP
    BEGIN
      UPDATE public.word_attempts
      SET coaching_response = attempt_row.coaching_response_legacy::jsonb
      WHERE id = attempt_row.id;
    EXCEPTION
      WHEN others THEN
        UPDATE public.word_attempts
        SET coaching_response = jsonb_build_object(
          'legacyText',
          attempt_row.coaching_response_legacy
        )
        WHERE id = attempt_row.id;
    END;
  END LOOP;
END $$;

ALTER TABLE public.word_attempts
  DROP COLUMN IF EXISTS coaching_response_legacy;
