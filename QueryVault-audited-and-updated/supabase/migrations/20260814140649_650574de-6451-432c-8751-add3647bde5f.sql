DROP POLICY IF EXISTS documents_insert_own ON storage.objects;
CREATE POLICY documents_insert_own ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'documents'
    AND (storage.foldername(name))[1] = (auth.uid())::text
    AND name ILIKE '%.pdf'
  );

DROP POLICY IF EXISTS documents_update_own ON storage.objects;
CREATE POLICY documents_update_own ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'documents'
    AND (storage.foldername(name))[1] = (auth.uid())::text
  )
  WITH CHECK (
    bucket_id = 'documents'
    AND (storage.foldername(name))[1] = (auth.uid())::text
    AND name ILIKE '%.pdf'
  );