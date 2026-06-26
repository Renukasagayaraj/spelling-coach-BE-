-- Drop total_sessions and last_practice_date columns from user_statistics table
ALTER TABLE user_statistics DROP COLUMN total_sessions;
ALTER TABLE user_statistics DROP COLUMN last_practice_date;
