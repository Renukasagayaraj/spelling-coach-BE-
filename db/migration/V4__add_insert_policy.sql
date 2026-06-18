-- Allow authenticated users to insert their own profile row if it is missing
DROP POLICY IF EXISTS "Users can insert own profile" ON public.users;
CREATE POLICY "Users can insert own profile" ON public.users
  FOR INSERT
  WITH CHECK (auth.uid() = id);
