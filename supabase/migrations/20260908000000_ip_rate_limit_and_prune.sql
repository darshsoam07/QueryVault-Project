-- Migration: IP-level burst rate limiting + prune helper  (Phase 5)
-- Non-destructive: only adds new table and functions.

CREATE TABLE IF NOT EXISTS public.rate_limits_ip (
  ip              text        NOT NULL,
  window_start    timestamptz NOT NULL,
  request_count   integer     NOT NULL DEFAULT 1,
  CONSTRAINT pk_rate_limits_ip PRIMARY KEY (ip, window_start)
);
ALTER TABLE public.rate_limits_ip ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.rate_limits_ip FROM anon, authenticated;
GRANT ALL ON public.rate_limits_ip TO service_role;
CREATE INDEX IF NOT EXISTS idx_rate_limits_ip_window ON public.rate_limits_ip (window_start);

-- 50 req / 10 s sliding window per IP.
CREATE OR REPLACE FUNCTION public.check_ip_rate_limit(
  p_ip text, p_max integer DEFAULT 50, p_window interval DEFAULT '10 seconds'
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_window_start timestamptz;
  v_count        integer;
BEGIN
  v_window_start := date_trunc('second', now()) -
    make_interval(secs => EXTRACT(EPOCH FROM now())::int % EXTRACT(EPOCH FROM p_window)::int);
  INSERT INTO public.rate_limits_ip (ip, window_start, request_count)
    VALUES (p_ip, v_window_start, 1)
    ON CONFLICT (ip, window_start) DO UPDATE
      SET request_count = rate_limits_ip.request_count + 1
    RETURNING request_count INTO v_count;
  IF v_count > p_max THEN
    RETURN jsonb_build_object('allowed', false, 'retry_after_seconds',
      EXTRACT(EPOCH FROM (v_window_start + p_window - now()))::int);
  END IF;
  RETURN jsonb_build_object('allowed', true, 'retry_after_seconds', 0);
END;
$$;

REVOKE ALL ON FUNCTION public.check_ip_rate_limit(text, integer, interval) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.check_ip_rate_limit(text, integer, interval) TO service_role;

-- Cleans both rate_limit_events (user) and rate_limits_ip; called from worker drain.
-- References rate_limit_events (the original table name), NOT "rate_limits".
CREATE OR REPLACE FUNCTION public.prune_expired_rate_limits(
  p_older_than interval DEFAULT '1 hour'
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  DELETE FROM public.rate_limits_ip WHERE window_start < now() - p_older_than;
  DELETE FROM public.rate_limit_events WHERE created_at < now() - p_older_than;
EXCEPTION
  WHEN undefined_table THEN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.prune_expired_rate_limits(interval) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.prune_expired_rate_limits(interval) TO service_role;

