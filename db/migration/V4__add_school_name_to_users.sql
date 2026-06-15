-- Add school_name column to users table
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS school_name text;
