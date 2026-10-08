-- Storage bucket provisioning.
--
-- Until now the `documents` bucket was a manual dashboard step recorded only in
-- supabase/STORAGE.md, while its RLS policies lived in migrations
-- (20260814130616 / 20260814140649). A fresh environment therefore got the
-- policies but no bucket, and every upload failed with "Bucket not found".
-- This makes provisioning fully reproducible from migrations alone.
--
-- Limits mirror src/lib/documents.policy.ts (MAX_UPLOAD_BYTES = 25 MiB) and are
-- defence in depth, not the primary check: the server still re-verifies size,
-- content type and %PDF- magic bytes after upload, because a bucket-level MIME
-- allowlist trusts the client-declared Content-Type.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('documents', 'documents', false, 26214400, ARRAY['application/pdf'])
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;
