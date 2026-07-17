ALTER TABLE public.user_subscriptions
ADD COLUMN IF NOT EXISTS stripe_price_id text,
ADD COLUMN IF NOT EXISTS price_unit_amount integer,
ADD COLUMN IF NOT EXISTS price_currency text,
ADD COLUMN IF NOT EXISTS billing_interval text;