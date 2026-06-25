ALTER TABLE public.user_statistics 
  ADD CONSTRAINT user_statistics_user_id_key UNIQUE (user_id);
