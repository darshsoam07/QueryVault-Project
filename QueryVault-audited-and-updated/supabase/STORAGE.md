# Storage configuration — `documents` bucket

Declarative record of the bucket QueryVault depends on. Recreate it exactly if
the project is rebuilt in a new environment.

| Setting | Value |
| --- | --- |
| Bucket id / name | `documents` |
| Public | `false` (private, all access via RLS + signed reads) |
| Object path convention | `<auth.uid()>/<document_id>.pdf` (owner-scoped) |
| Allowed extension | `.pdf` only (enforced in the INSERT/UPDATE policies) |
| Max object size | 25 MB — enforced in application code (`MAX_UPLOAD_BYTES` in `src/lib/documents.policy.ts`) and re-checked server-side after upload |
| Content type | `application/pdf` declared on upload; the server re-validates the object's `%PDF-` magic bytes before ingestion continues |

## RLS policies on `storage.objects`

Applied via migration:

- `documents_read_own` — SELECT where `bucket_id = 'documents'` and first path segment = `auth.uid()`
- `documents_insert_own` — INSERT with the same owner check plus `name ILIKE '%.pdf'`
- `documents_update_own` — UPDATE (upsert on retry) with the same checks
- `documents_delete_own` — DELETE with the owner check

## Notes

- The browser MIME type is never trusted. `validateUploadedDocument`
  (`src/lib/documents.functions.ts`) downloads the stored object and checks
  size, content type and magic bytes before the document leaves the
  `validating` state.
- Deletion is server-authoritative and retryable: chunks → storage object →
  metadata row. A failed step leaves the row in `deleting`, so retrying the
  delete finishes the cleanup and no storage object is permanently orphaned.
