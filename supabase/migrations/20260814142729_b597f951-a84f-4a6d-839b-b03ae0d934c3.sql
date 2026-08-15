-- 1. Roles (separate table, never on profiles)
DO $$ BEGIN
  CREATE TYPE public.app_role AS ENUM ('admin', 'operator', 'user');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);

GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_roles_read_own ON public.user_roles;
CREATE POLICY user_roles_read_own ON public.user_roles
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = _role
  );
$$;

CREATE OR REPLACE FUNCTION public.is_operator(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role IN ('admin', 'operator')
  );
$$;

REVOKE EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) FROM anon;
REVOKE EXECUTE ON FUNCTION public.is_operator(uuid) FROM anon;

-- 2. Structured telemetry events
CREATE TABLE IF NOT EXISTS public.telemetry_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id text NOT NULL,
  event text NOT NULL,
  status text NOT NULL DEFAULT 'ok',
  error_code text,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  document_id uuid,
  thread_id uuid,
  job_id uuid,
  latency_ms integer,
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.telemetry_events TO authenticated;
GRANT ALL ON public.telemetry_events TO service_role;

ALTER TABLE public.telemetry_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS telemetry_events_read_own ON public.telemetry_events;
CREATE POLICY telemetry_events_read_own ON public.telemetry_events
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.is_operator(auth.uid()));

CREATE INDEX IF NOT EXISTS telemetry_events_created_idx ON public.telemetry_events (created_at DESC);
CREATE INDEX IF NOT EXISTS telemetry_events_event_idx ON public.telemetry_events (event, created_at DESC);
CREATE INDEX IF NOT EXISTS telemetry_events_request_idx ON public.telemetry_events (request_id);

-- 3. Query traces for the operator debug view
CREATE TABLE IF NOT EXISTS public.query_traces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  thread_id uuid,
  question text NOT NULL,
  answer_preview text,
  grounded boolean NOT NULL DEFAULT false,
  refused boolean NOT NULL DEFAULT false,
  gate_reason text,
  reranker text,
  stages jsonb NOT NULL DEFAULT '{}'::jsonb,
  citations jsonb NOT NULL DEFAULT '[]'::jsonb,
  retrieval_latency_ms integer,
  generation_latency_ms integer,
  total_latency_ms integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.query_traces TO authenticated;
GRANT ALL ON public.query_traces TO service_role;

ALTER TABLE public.query_traces ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS query_traces_read_own ON public.query_traces;
CREATE POLICY query_traces_read_own ON public.query_traces
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.is_operator(auth.uid()));

CREATE INDEX IF NOT EXISTS query_traces_created_idx ON public.query_traces (created_at DESC);
CREATE INDEX IF NOT EXISTS query_traces_request_idx ON public.query_traces (request_id);

-- 4. Operator-only metrics rollup
CREATE OR REPLACE FUNCTION public.observability_summary(window_minutes integer DEFAULT 60)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  since timestamptz := now() - make_interval(mins => GREATEST(LEAST(window_minutes, 10080), 5));
  api jsonb;
  rag jsonb;
  ingestion jsonb;
  cost jsonb;
BEGIN
  IF NOT public.is_operator(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT jsonb_build_object(
    'requests', count(*),
    'errors', count(*) FILTER (WHERE status = 'error'),
    'error_rate', CASE WHEN count(*) = 0 THEN 0
      ELSE round((count(*) FILTER (WHERE status = 'error'))::numeric / count(*), 4) END,
    'p50_ms', coalesce(percentile_disc(0.5) WITHIN GROUP (ORDER BY latency_ms), 0),
    'p95_ms', coalesce(percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms), 0),
    'p99_ms', coalesce(percentile_disc(0.99) WITHIN GROUP (ORDER BY latency_ms), 0)
  ) INTO api
  FROM public.telemetry_events
  WHERE created_at >= since
    AND event IN ('generation.completed','generation.failed','document.uploaded','document.deleted','document.validation_failed');

  SELECT jsonb_build_object(
    'retrieval_p50_ms', coalesce(percentile_disc(0.5) WITHIN GROUP (
      ORDER BY (attributes->>'retrieval_latency_ms')::int), 0),
    'retrieval_p95_ms', coalesce(percentile_disc(0.95) WITHIN GROUP (
      ORDER BY (attributes->>'retrieval_latency_ms')::int), 0),
    'generation_p50_ms', coalesce(percentile_disc(0.5) WITHIN GROUP (
      ORDER BY (attributes->>'generation_latency_ms')::int), 0),
    'generation_p95_ms', coalesce(percentile_disc(0.95) WITHIN GROUP (
      ORDER BY (attributes->>'generation_latency_ms')::int), 0),
    'answers', count(*) FILTER (WHERE event = 'generation.completed'),
    'grounded', count(*) FILTER (WHERE (attributes->>'grounded')::boolean IS TRUE),
    'refusals', count(*) FILTER (WHERE (attributes->>'refused')::boolean IS TRUE),
    'avg_hits', coalesce(round(avg((attributes->>'final_evidence')::numeric), 2), 0),
    'avg_best_similarity', coalesce(round(avg((attributes->>'best_similarity')::numeric), 4), 0),
    'avg_best_rerank', coalesce(round(avg((attributes->>'best_rerank_score')::numeric), 4), 0)
  ) INTO rag
  FROM public.telemetry_events
  WHERE created_at >= since
    AND event IN ('retrieval.completed','generation.completed','generation.failed');

  SELECT jsonb_build_object(
    'queued', count(*) FILTER (WHERE status = 'queued'),
    'running', count(*) FILTER (WHERE status = 'running'),
    'retrying', count(*) FILTER (WHERE status = 'retrying'),
    'failed', count(*) FILTER (WHERE status = 'failed'),
    'succeeded', count(*) FILTER (WHERE status = 'succeeded'),
    'retries', coalesce(sum(GREATEST(attempt_count - 1, 0)), 0),
    'avg_duration_ms', coalesce(round(avg(
      CASE WHEN completed_at IS NOT NULL AND started_at IS NOT NULL
        THEN EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000 END), 0), 0)
  ) INTO ingestion
  FROM public.ingestion_jobs
  WHERE created_at >= since;

  SELECT jsonb_build_object(
    'embedding_calls', coalesce(sum((attributes->>'embedding_calls')::int), 0),
    'embedded_texts', coalesce(sum((attributes->>'embedded_texts')::int), 0),
    'generation_calls', count(*) FILTER (WHERE event = 'generation.completed'),
    'prompt_tokens', coalesce(sum((attributes->>'prompt_tokens')::int), 0),
    'completion_tokens', coalesce(sum((attributes->>'completion_tokens')::int), 0),
    'context_tokens', coalesce(sum((attributes->>'context_tokens')::int), 0)
  ) INTO cost
  FROM public.telemetry_events
  WHERE created_at >= since;

  RETURN jsonb_build_object(
    'window_minutes', GREATEST(LEAST(window_minutes, 10080), 5),
    'since', since,
    'api', coalesce(api, '{}'::jsonb),
    'rag', coalesce(rag, '{}'::jsonb),
    'ingestion', coalesce(ingestion, '{}'::jsonb),
    'cost', coalesce(cost, '{}'::jsonb)
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.observability_summary(integer) FROM anon;