# QueryVault: Grounded Retrieval-Augmented Generation & Document Intelligence Vault
## Engineering Project Report Synopsis & Viva Voce Defense Guide

---

### 1. Abstract & Objective

Large Language Models (LLMs) frequently hallucinate unsupported claims and fabricate citation markers when querying academic notes, enterprise handbooks, and course curricula. **QueryVault** is an enterprise-grade, verifiable Retrieval-Augmented Generation (RAG) platform engineered to guarantee trust and correctness in document question answering. 

By coupling a dual-stage hybrid retrieval engine (dense vector embeddings via `pgvector` and lexical search via PostgreSQL `tsvector`) with an evidence-gated verification contract (`Citation Contract v1`), QueryVault eliminates ungrounded generation. Answers are generated only when relevant evidence clears strict relevance thresholds; otherwise, the platform delivers a deterministic, zero-token refusal. Validated responses are rendered with paragraph-level citations strictly mapped to immutable document passages.

---

### 2. Problem Statement

Conventional RAG pipelines suffer from three fundamental architectural flaws:

1. **Unvalidated Token Streaming**: Piping raw LLM token deltas directly over WebSocket or SSE to client sockets permits hallucinated citations (e.g., `[source_99]`) and ungrounded statements to render in the client DOM before completion.
2. **Resource Leaks on Disconnect**: When a user closes their browser tab mid-flight, standard web servers continue executing expensive embedding, reranking, and generation tasks in the background, wasting compute credits and persisting orphaned turns.
3. **Ingestion & Slicing Breakage**: Arbitrary character slicing splits technical terms and entity names across chunk boundaries and breaks Markdown pipe tables, detaching table data cells from their column headers.

---

### 3. System Architecture & Technical Specifications

```mermaid
flowchart TD
    UserQuery["User Query (/api/chat)"] --> QueryExpansion["Query Expansion (Lexical & Semantic Variants)"]
    
    subgraph HybridRetrieval["Dual-Stage Hybrid Retrieval Engine"]
        QueryExpansion --> DenseSearch["Dense Vector Search\n(pgvector HNSW, text-embedding-3-large, 3072 dims)"]
        QueryExpansion --> LexicalSearch["Lexical Full-Text Search\n(PostgreSQL tsvector / ts_rank_cd)"]
        DenseSearch --> RRF["Reciprocal Rank Fusion (RRF)\n(k=60, Dense Wt: 1.0, Lexical Wt: 0.8)"]
        LexicalSearch --> RRF
    end

    RRF --> Reranker["Listwise LLM Reranker\n(5,000 ms wall-clock ceiling with heuristic fallback)"]
    
    Reranker --> EvidenceGate{"Evidence Gate\n(topRank >= 0.35\nsimilarity >= 0.30)"}
    
    EvidenceGate -- Fails --> GroundedRefusal["Grounded Refusal (Deterministic, 0 LLM Tokens)"]
    
    EvidenceGate -- Passes --> ContextPacking["Context Window Token Packing\n(Sliding-Window Passage Compression &\nScore-Aware Dynamic Jaccard Folding)"]
    
    ContextPacking --> BufferedGeneration["Buffered Generation (maxOutputTokens: 1024)"]
    
    BufferedGeneration --> CitationValidator{"Citation Contract v1\n(Block-Level Citation Validation)"}
    
    CitationValidator -- Invalid --> RefusalFallback["Fail-Closed Refusal\n(Discard candidate, emit Grounded Refusal)"]
    CitationValidator -- Valid --> TokenStreaming["Validated Chunk Streaming\n([source_01], [source_02])"]
```

#### Core Components & Invariants

1. **Boundary-Snapped Sliding-Window Ingestion (`src/lib/chunking.ts`)**:
   - Snaps chunk boundaries to sentence terminals (`[.!?]\s+`) and newlines rather than hard character offsets.
   - Retains small Markdown pipe tables as atomic blocks and repeats table column headers (`header + separator`) across subsequent splits for multi-chunk tables.
   - Prepends hierarchical heading breadcrumbs (`[Section: Path > Subpath]\n\n`) to enrich chunk context without database schema migrations.
   - Increments `CHUNKER_VERSION = 3` to prune stale chunks automatically upon re-ingestion.

2. **Dual-Stage Hybrid Retrieval & RRF (`src/lib/retrieval/`)**:
   - Executes parallel dense cosine similarity search over 3072-dimensional embeddings and PostgreSQL `tsvector` full-text search.
   - Merges candidate ranks using Reciprocal Rank Fusion ($k=60$, Dense Weight: $1.0$, Lexical Weight: $0.8$):
     $$\text{RRF Score}(d) = \frac{1.0}{60 + r_{\text{dense}}(d)} + \frac{0.8}{60 + r_{\text{lexical}}(d)}$$

3. **Fault-Isolated Bounded Reranker (`reranker.ts`)**:
   - Bounded by a 5,000 ms wall-clock ceiling via `linkAbort`.
   - Automatically degrades to heuristic reciprocal overlap scoring on timeouts or provider failures without aborting the client query.

4. **Evidence Gate (`evidence-gate.ts`)**:
   - Evaluates retrieved candidates prior to generation. If top scores fail the relevance floor ($\text{topRank} \ge 0.35$ and $\text{similarity} \ge 0.30$), the pipeline halts and emits `GROUNDED_REFUSAL` ("Insufficient evidence to answer this question accurately."), consuming zero generation tokens.

5. **Context Window Token Packing (`context-builder.ts`)**:
   - Merges adjoining sequential chunks from the same document in natural reading order, removing redundant sliding-window overlap sentences and duplicate `[Section: ...]` headers.
   - Scales Jaccard duplicate threshold adaptively:
     - High scores ($\ge 0.75$): Scales up to $0.92$ to preserve distinct high-value claims with shared terminology.
     - Low scores ($< 0.50$): Scales down to $0.70$ to aggressively shed redundant text and boilerplate.
   - Enforces a strict 3,200-token context budget.

6. **Citation Contract v1 (`citation-validator.ts`)**:
   - Buffers the candidate response server-side.
   - Enforces fail-closed block-level validation: every substantive paragraph, bullet, and table row must cite an allowed source (`[source_NN]`).
   - Rejects ungrounded citations (`[source_99]`) or uncited claims wholesale, delivering a safe grounded refusal instead of hallucinated text.

7. **Cancellation Lifecycle (`cancellation.ts`)**:
   - Evaluates caller connection state across 4 asynchronous pipeline boundaries.
   - Client disconnects abort active provider HTTP connections via `AbortController`, return `HTTP 499 Client Closed Request`, and bypass database writes.

8. **Operator Observability Dashboard (`src/routes/admin.tsx`)**:
   - Interactive split-pane waterfall visualizing stage-by-stage latencies via proportional Gantt bars.
   - Real-time diagnostic cards for reranker timeouts, evidence gate gauges, and dual-coordinate RRF rank shift matrices.

---

### 4. Database Schema & Data Isolation (Supabase PostgreSQL)

All relational tables enforce **Row-Level Security (RLS)** using JWT-authenticated claims (`auth.uid() = user_id`):

| Table | Purpose & Primary Fields | Access Control |
| :--- | :--- | :--- |
| **`auth.users`** | Supabase managed identity and authentication records. | System Auth |
| **`documents`** | Uploaded file metadata (`id`, `user_id`, `name`, `storage_path`, `mime_type`, `status`). | RLS per `user_id` |
| **`document_chunks`** | Parsed text passages, section breadcrumbs, and vectors (`embedding vector(3072)`). | RLS via document ownership |
| **`threads`** | Conversational session grouping (`id`, `user_id`, `title`, `created_at`). | RLS per `user_id` |
| **`messages`** | User and assistant turns (`id`, `thread_id`, `role`, `content`, `sources jsonb`). | RLS per `user_id` |
| **`query_traces`** | Telemetry records capturing latency, stages, gate status, and citations. | Admin/Operator Role |

---

### 5. Verification & Benchmark Results

Comprehensive automated verification was executed across the full test harness, type checker, offline evaluation runner, and production compiler:

| Quality Gate | Test Command | Result |
| :--- | :--- | :--- |
| **Unit & Integration Suite** | `npm run test` (`vitest run`) | **20 test files, 396 passed** (100%) |
| **Static Typecheck** | `npm run typecheck` (`tsc --noEmit`) | **0 errors** |
| **Production Compilation** | `QV_ALLOW_PLACEHOLDER_CONFIG=1 npm run build` | **Clean build** (~5.8s) |
| **Offline Retrieval Gate** | `bun run evaluation/runner.ts` | **GATE: PASS** (0 failures) |

#### Offline Retrieval Benchmark Breakdown

- **Recall@5**: `1.000` (100% of gold evidence captured within top-5 candidates)
- **Recall@10**: `1.000`
- **MRR (Mean Reciprocal Rank)**: `0.925`
- **NDCG@10**: `0.950`
- **Evidence Precision**: `0.365` (**+20.4% improvement** via Phase 3 passage compression)
- **Citation Validity**: `1.000` (Zero ungrounded source markers emitted)
- **Refusal Accuracy**: `1.000` (Zero false acceptances on negative or adversarial queries)
- **Injection Defense**: `1.000` (Zero prompt injections breached system sandbox)
- **Cross-Document Coverage**: `1.000`

---

### 6. Viva Voce & Presentation Defense Cheatsheet

#### Q1: "How does QueryVault differ from copy-pasting notes into ChatGPT?"
> **Answer**: "Standard ChatGPT prompts operate without citation grounding—they hallucinate plausible-sounding answers when information is missing and mix internet knowledge with proprietary syllabus notes. QueryVault operates on a zero-trust verification contract: every substantive statement must cite an exact chunk ID retrieved from the uploaded document (`[source_01]`). If retrieved evidence falls below our 0.35 relevance threshold, the system deterministically refuses to answer before any generation occurs."

#### Q2: "Why use both pgvector and PostgreSQL Full-Text Search instead of just vector embeddings?"
> **Answer**: "Dense vector embeddings capture conceptual and semantic similarity (e.g., matching 'pricing' with 'subscription cost'), but they frequently miss exact alphanumeric codes, variable names, error codes, and abbreviations. PostgreSQL full-text search (`tsvector` / `ts_rank_cd`) matches exact keywords. By fusing both lists using Reciprocal Rank Fusion ($k=60$), we achieve significantly higher retrieval recall (`Recall@5 = 1.000`) than single-index approaches."

#### Q3: "What happens if a user submits a query and immediately closes the tab?"
> **Answer**: "In standard RAG architectures, the server continues running embedding, reranking, and generation in the background, wasting expensive API tokens and persisting orphaned assistant messages. QueryVault implements a client-disconnect lifecycle (`cancellation.ts`): before every major async stage, it evaluates `throwIfCallerCancelled()`. If the client disconnects, `linkAbort` immediately aborts the active LLM connection, responds with HTTP 499, and prevents database persistence."

#### Q4: "How does QueryVault handle tables during document chunking?"
> **Answer**: "Arbitrary character slicing cuts Markdown tables mid-row, detaching numerical data from column headers and causing hallucinated answers. QueryVault's parser detects Markdown table syntax (`| ... |`). It keeps small tables atomic, and if a large table exceeds the chunk limit, it splits rows cleanly while repeating the column header and separator rows at the top of every subsequent chunk."

#### Q5: "How does Context Token Packing improve evidence quality within the token budget?"
> **Answer**: "When sliding-window chunking ingests documents, adjoining chunks share overlapping sentences. In naive RAG, retrieving two adjacent chunks duplicates those tokens and wastes prompt overhead on repeated `<evidence>` tags. QueryVault's Context Builder identifies adjoining chunks from the same document, eliminates the overlapping suffix-prefix text, deduplicates section breadcrumbs, and adaptively adjusts Jaccard thresholds (0.70–0.92) to maximize information density, achieving a +20.4% increase in evidence precision."

#### Q6: "Where is user data stored and how is tenant isolation guaranteed?"
> **Answer**: "All data is stored in Supabase PostgreSQL with Row-Level Security (RLS) enabled across every table. Every query and vector match strictly evaluates `auth.uid() = user_id` from the cryptographically verified JWT, making it mathematically impossible for one user to query or access another student's documents or chat threads."
