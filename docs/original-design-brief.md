# QueryVault — Multi-Document RAG Assistant

An enterprise-grade AI knowledge assistant: upload PDFs, ask questions, get streamed answers grounded in your own documents with precise page-level citations. Plus a built-in reference section shipping the production Python/FastAPI RAG implementation.

## What gets built

**1. Auth**
Email/password sign-in and sign-up. Every document, thread, and message is private to its owner.

**2. Knowledge base (left sidebar, bottom)**
- Drag-and-drop PDF upload zone with progress through each stage: uploading, parsing, chunking, embedding, ready.
- List of uploaded PDFs with page count, chunk count, status badge, and delete.
- Deleting a document removes its chunks and vectors.

**3. Ingestion pipeline (server-side)**
- PDF text extraction per page (page numbers preserved as metadata).
- Recursive character chunking, 1000 chars / 200 overlap, paragraph → sentence → word fallback, mirroring the reference implementation.
- Embeddings via Lovable AI (`google/gemini-embedding-2`), stored as pgvector `halfvec` with an HNSW index.
- Runs asynchronously with status written back to the document row so the UI can poll and show live progress.

**4. Chat (main stage)**
- Threaded conversations, each on its own URL (`/chat/$threadId`). Sidebar lists threads; new-chat button creates and navigates. Reload restores that thread's messages.
- Question → embed query → top-k vector retrieval (k=5, configurable) → strict grounded prompt ("answer ONLY from context; otherwise say I don't know") → streamed answer.
- Retrieval is written behind a swappable retriever interface so hybrid (keyword + vector) search and a re-ranking stage can be added later without touching the chat route.
- Responses separate answer text from source nodes. Each source returns filename, page number, similarity score, and snippet.
- Citation pills render as monospace violet tags (`OS_Notes.pdf • Pg 14`); clicking opens a panel with the retrieved chunk text and score.
- Optional scoping: ask across all documents or select a subset.

**5. Reference section (`/reference`)**
A documentation page presenting the Tier-1 Python implementation: complete FastAPI folder structure, async router with SSE streaming, pydantic-settings config, DI/factory wiring for LLM + vector store + loaders, structured logging with latency/token/score tracking, custom exception schemas, and the frontend streaming fetch handler. Syntax-highlighted, copyable code blocks, downloadable as a zip.

**6. Design system**
Dark void base (`#0A0A0A`), Electric Cyan + Vivid Amethyst accents, glassmorphic floating input bar and dropdowns, 1px `white/10` panel borders, Inter for UI and JetBrains Mono for code/citations/metadata. Fixed full-viewport layout with a collapsible 280px sidebar, active thread marked with a violet left border. Staggered message fade-ins, shimmer "Thinking..." state, skeletons during retrieval, upload progress indicators. All colors go into the theme as semantic tokens, not hardcoded classes.

## Technical notes

- Stack is TanStack Start + React (Python/FastAPI/Ollama cannot run on this host) — the working app uses Lovable Cloud (Postgres + pgvector + storage + auth) and Lovable AI for embeddings and generation. The Python code ships as reference material on `/reference`.
- Tables: `documents`, `document_chunks` (with `halfvec` embedding + HNSW index), `threads`, `messages` (message `sources` stored as jsonb). RLS on every table scoped to `auth.uid()`, with explicit grants.
- PDFs stored in a private storage bucket with per-user path policies.
- Chat streams through a server route at `src/routes/api/chat.ts` using `toUIMessageStreamResponse`; ingestion and CRUD use `createServerFn`. `LOVABLE_API_KEY` stays server-side.
- Chat UI composed from AI Elements primitives (conversation, message, prompt-input, shimmer, sources) restyled to the QueryVault visual identity.
- Gateway 429/402 errors surface as clear in-app messages rather than silent failures.

## Build order

1. Enable Lovable Cloud; schema, RLS, storage bucket, auth pages.
2. App shell: sidebar, layout, design tokens, fonts.
3. Upload + ingestion pipeline with live status.
4. Threaded chat routes, retrieval, streaming answers, citations.
5. Reference documentation page.
6. Polish: animations, skeletons, empty states, error boundaries, SEO metadata.
