-- Migration: health probe RPC  (Phase 6)
-- Used by GET /api/health. Cheap SELECT now() — no table scans.

CREATE OR REPLACE FUNCTION public.health_probe()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object('ok', true, 'ts', now()::text);
$$;

REVOKE ALL ON FUNCTION public.health_probe() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.health_probe() TO service_role;

