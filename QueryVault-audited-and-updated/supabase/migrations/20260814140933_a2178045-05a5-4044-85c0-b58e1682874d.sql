ALTER TABLE public.document_chunks
  ADD COLUMN IF NOT EXISTS content_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce(content, ''))) STORED;

CREATE INDEX IF NOT EXISTS document_chunks_content_tsv_idx
  ON public.document_chunks USING gin (content_tsv);

CREATE OR REPLACE FUNCTION public.lexical_document_chunks(
  query_text text,
  requesting_user_id uuid,
  match_count integer DEFAULT 20,
  document_ids uuid[] DEFAULT NULL::uuid[]
)
RETURNS TABLE(
  id uuid,
  document_id uuid,
  filename text,
  content text,
  page_number integer,
  chunk_index integer,
  lexical_rank double precision
)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  WITH q AS (
    SELECT websearch_to_tsquery('english', coalesce(query_text, '')) AS tsq
  )
  SELECT c.id, c.document_id, d.filename, c.content, c.page_number, c.chunk_index,
         ts_rank_cd(c.content_tsv, q.tsq)::double precision AS lexical_rank
  FROM public.document_chunks c
  JOIN public.documents d ON d.id = c.document_id
  CROSS JOIN q
  WHERE q.tsq IS NOT NULL
    AND numnode(q.tsq) > 0
    AND requesting_user_id IS NOT NULL
    AND auth.uid() = requesting_user_id
    AND c.user_id = requesting_user_id
    AND d.user_id = requesting_user_id
    AND d.status = 'ready'
    AND (document_ids IS NULL OR c.document_id = ANY(document_ids))
    AND c.content_tsv @@ q.tsq
  ORDER BY lexical_rank DESC
  LIMIT GREATEST(LEAST(match_count, 20), 1);
$function$;

REVOKE ALL ON FUNCTION public.lexical_document_chunks(text, uuid, integer, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lexical_document_chunks(text, uuid, integer, uuid[]) TO authenticated, service_role;