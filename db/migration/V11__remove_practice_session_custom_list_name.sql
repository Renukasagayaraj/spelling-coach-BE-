-- The current application identifies custom-list sessions by custom_list_id and
-- does not display a historical list-name snapshot.
ALTER TABLE public.practice_sessions
  DROP COLUMN IF EXISTS custom_list_name;
