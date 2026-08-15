CREATE TABLE public.worker_credentials (
  name text PRIMARY KEY,
  token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Server-only: no grants to anon/authenticated at all.
GRANT ALL ON public.worker_credentials TO service_role;

ALTER TABLE public.worker_credentials ENABLE ROW LEVEL SECURITY;
-- Intentionally no policies: service_role bypasses RLS, every other role is denied.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;