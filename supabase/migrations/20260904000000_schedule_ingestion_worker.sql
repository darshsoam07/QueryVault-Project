-- Durable ingestion scheduler ------------------------------------------------
--
-- The application owns ingestion execution; this migration only wakes the
-- existing authenticated /api/public/worker-drain endpoint once per minute.
-- Jobs remain claimed, retried and made idempotent by the Node worker.
--
-- Before enabling production traffic, store these two values in Supabase Vault:
--   queryvault_worker_drain_url       the deployed HTTPS endpoint URL
--   queryvault_ingestion_worker_secret the same value injected as
--                                      INGESTION_WORKER_SECRET in the app
--
-- They are intentionally looked up at execution time. No endpoint URL or
-- credential is baked into a migration, cron command, table, or application
-- bundle. If either is absent the scheduled no-op is safe and fail-closed.

CREATE EXTENSION IF NOT EXISTS supabase_vault WITH SCHEMA vault;

CREATE OR REPLACE FUNCTION public.trigger_ingestion_worker()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, extensions
AS $$
DECLARE
  worker_url text;
  worker_secret text;
BEGIN
  SELECT decrypted_secret
    INTO worker_url
    FROM vault.decrypted_secrets
   WHERE name = 'queryvault_worker_drain_url';

  SELECT decrypted_secret
    INTO worker_secret
    FROM vault.decrypted_secrets
   WHERE name = 'queryvault_ingestion_worker_secret';

  -- A scheduler that cannot authenticate must never turn the endpoint public,
  -- and must not create a failing pg_net request every minute.
  IF worker_url IS NULL OR worker_url = '' OR worker_secret IS NULL OR worker_secret = '' THEN
    RETURN false;
  END IF;

  PERFORM net.http_post(
    url := worker_url,
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-worker-secret', worker_secret
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 1_000
  );

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.trigger_ingestion_worker() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trigger_ingestion_worker() TO service_role;

-- Keep a single named schedule. Re-running the migration does not create a
-- competing worker; changing its cadence is a deliberate future migration.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM cron.job
     WHERE jobname = 'queryvault-ingestion-worker'
  ) THEN
    PERFORM cron.schedule(
      'queryvault-ingestion-worker',
      '* * * * *',
      'SELECT public.trigger_ingestion_worker();'
    );
  END IF;
END;
$$;
