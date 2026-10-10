# QueryVault multi-format smoke-test sheet

Use the exact marker `QueryVault Smoke Test — FORMAT — 2026-10-08` in every
fixture. Keep each fixture below 1 MB. Mark a cell PASS only after verifying
the matching stage; write failure details and the document/job ID in Notes.

| Format      | Upload | Storage | Database record | Worker completion | Parsing | Indexing | Retrieval | RLS isolation | Notes |
| ----------- | ------ | ------- | --------------- | ----------------- | ------- | -------- | --------- | ------------- | ----- |
| PDF         | ☐      | ☐       | ☐               | ☐                 | ☐       | ☐        | ☐         | ☐             |       |
| DOCX        | ☐      | ☐       | ☐               | ☐                 | ☐       | ☐        | ☐         | ☐             |       |
| XLSX        | ☐      | ☐       | ☐               | ☐                 | ☐       | ☐        | ☐         | ☐             |       |
| PPTX        | ☐      | ☐       | ☐               | ☐                 | ☐       | ☐        | ☐         | ☐             |       |
| TXT         | ☐      | ☐       | ☐               | ☐                 | ☐       | ☐        | ☐         | ☐             |       |
| CSV         | ☐      | ☐       | ☐               | ☐                 | ☐       | ☐        | ☐         | ☐             |       |
| HTML        | ☐      | ☐       | ☐               | ☐                 | ☐       | ☐        | ☐         | ☐             |       |
| Markdown    | ☐      | ☐       | ☐               | ☐                 | ☐       | ☐        | ☐         | ☐             |       |
| **Overall** | ☐      | ☐       | ☐               | ☐                 | ☐       | ☐        | ☐         | ☐             |       |

## What each check means

- **Upload:** picker accepts the file and the client does not reject it.
- **Storage:** private `documents` bucket contains the user/document-scoped object.
- **Database record:** `documents.content_type` matches the file MIME type.
- **Worker completion:** the job reaches `succeeded`; the document reaches `ready`.
- **Parsing:** the expected marker is present in extracted chunks (and visible content is preserved).
- **Indexing:** document chunks have embeddings and the expected chunk count is non-zero.
- **Retrieval:** a question containing the format marker retrieves the correct document.
- **RLS isolation:** a second authenticated user cannot list, download, retrieve, or delete it.

## Negative gate

Verify clean failure—with no ready document, indexed chunks, or exposed storage
object—for: `.exe`, forged MIME type, >25 MB input, empty input, corrupt PDF,
DOCX, XLSX and PPTX, and unauthenticated/cross-user access.

**Release gate:** every cell must be PASS for all eight formats. RLS requires a
separate second-user session; it cannot be proven from the owner session alone.
