# Document ingestion

The ingestion worker stores the original document privately, extracts text on
the server, then uses the existing chunking, embedding and retrieval pipeline.
No extracted text or AI credential is sent from the browser.

## Local formats

- PDF: `unpdf` text layer extraction (password-protected and scan-only PDFs do
  not have usable local text).
- DOCX: `mammoth` raw text extraction.
- TXT, Markdown, CSV and JSON: UTF-8 text extraction.
- HTML: tags, scripts and styles are removed before indexing.
- XLSX: each worksheet is converted to CSV-style text.
- PPTX: text runs are extracted slide-by-slide.

## OCR boundary

PNG, JPEG and WebP files may be uploaded and retained, but are intentionally
marked `OCR_REQUIRED` until an OCR provider is integrated. OCR needs a service
that can render images/scanned PDF pages (for example Azure AI Vision, Google
Cloud Vision, AWS Textract or a self-hosted Tesseract worker). Keep that
credential server-only; do not add it as `VITE_*`. The selected provider should
be called from `document-parser.server.ts` and return `PageText[]`.

## Required deployment steps

1. Apply `supabase/migrations/20261008000000_expand_document_formats.sql`.
2. Rebuild the application after setting the correct Supabase public values:
   `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, and
   `VITE_SUPABASE_PROJECT_ID`.
3. Ensure their server mirrors and `SUPABASE_SERVICE_ROLE_KEY` reference the
   same Supabase project. The service-role key remains server-only.
4. Install dependencies from `package-lock.json` with `npm ci`.
