-- Format-aware ingestion. Existing PDFs retain their metadata; new files keep
-- their actual MIME type so the worker can route them to a local parser.
ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS content_type text NOT NULL DEFAULT 'application/pdf';

UPDATE storage.buckets
SET allowed_mime_types = ARRAY[
  'application/pdf', 'application/x-pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain', 'text/markdown', 'text/x-markdown', 'text/csv', 'application/csv',
  'text/html', 'application/xhtml+xml',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'image/png', 'image/jpeg', 'image/webp'
]
WHERE id = 'documents';

-- The original policies required a .pdf suffix. Keep ownership checks and
-- broaden only the allowed extensions used by the server validation layer.
DROP POLICY IF EXISTS documents_insert_own ON storage.objects;
CREATE POLICY documents_insert_own ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'documents' AND (storage.foldername(name))[1] = auth.uid()::text
  AND name ~* '\.(pdf|docx|txt|md|markdown|csv|html|htm|xlsx|pptx|png|jpe?g|webp)$'
);

DROP POLICY IF EXISTS documents_update_own ON storage.objects;
CREATE POLICY documents_update_own ON storage.objects FOR UPDATE TO authenticated
USING (bucket_id = 'documents' AND (storage.foldername(name))[1] = auth.uid()::text)
WITH CHECK (
  bucket_id = 'documents' AND (storage.foldername(name))[1] = auth.uid()::text
  AND name ~* '\.(pdf|docx|txt|md|markdown|csv|html|htm|xlsx|pptx|png|jpe?g|webp)$'
);
