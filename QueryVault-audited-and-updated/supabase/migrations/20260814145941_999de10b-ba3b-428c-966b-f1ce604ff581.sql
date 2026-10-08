-- 1. rate_limit_events: server-owned state only
DROP POLICY IF EXISTS rate_limit_events_own ON public.rate_limit_events;
REVOKE ALL ON public.rate_limit_events FROM authenticated, anon;
GRANT ALL ON public.rate_limit_events TO service_role;

-- 2. document_chunks: client read-only, worker writes
DROP POLICY IF EXISTS document_chunks_own ON public.document_chunks;
CREATE POLICY document_chunks_select_own ON public.document_chunks
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
REVOKE INSERT, UPDATE, DELETE ON public.document_chunks FROM authenticated, anon;
GRANT SELECT ON public.document_chunks TO authenticated;
GRANT ALL ON public.document_chunks TO service_role;

-- 3. documents: client may read + delete own; pipeline fields are server-written
DROP POLICY IF EXISTS documents_own ON public.documents;
CREATE POLICY documents_select_own ON public.documents
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
CREATE POLICY documents_delete_own ON public.documents
  FOR DELETE TO authenticated
  USING (auth.uid() = user_id);
REVOKE INSERT, UPDATE ON public.documents FROM authenticated, anon;
GRANT SELECT, DELETE ON public.documents TO authenticated;
GRANT ALL ON public.documents TO service_role;