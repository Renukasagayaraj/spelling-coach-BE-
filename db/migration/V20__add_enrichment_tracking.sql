-- Migration V20: Add persistent enrichment tracking to import_jobs
-- These columns track the background AI enrichment lifecycle separately from the import lifecycle.
-- This allows a completed import to have enrichment still running/pending.

alter table public.import_jobs
  add column if not exists enrichment_status text not null default 'none',
  add column if not exists enrichment_total_words integer not null default 0,
  add column if not exists enrichment_processed_words integer not null default 0,
  add column if not exists enrichment_failed_words integer not null default 0,
  add column if not exists enrichment_locked_at bigint,
  add column if not exists enrichment_locked_by text;

-- enrichment_status values:
--   'none'       - no enrichment needed (import did not require AI metadata generation)
--   'pending'    - enrichment queued, not yet started
--   'processing' - a worker has acquired the lock and is actively enriching
--   'completed'  - enrichment finished (some words may have failed, see enrichment_failed_words)
--   'failed'     - enrichment ended in an unrecoverable error