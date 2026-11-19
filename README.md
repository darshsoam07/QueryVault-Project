# QueryVault — Scoped Multi-Document Search Using RAG

QueryVault is a production-grade Retrieval-Augmented Generation (RAG) platform designed for verifiable multi-document question answering. It retrieves facts across user-selected document sets, provides clickable inline citations linked to exact passages and page numbers, and strictly refuses to answer when supporting evidence is absent.

---

## 1. What QueryVault Does

When users query complex documents (contracts, manuals, policy guides, technical reports), traditional AI models often hallucinate or blend facts across unrelated contexts. QueryVault solves this by enforcing an evidence-backed verification loop:

1. **Scoped Multi-Document Selection**: Users can selectively query specific documents (e.g. comparing two workshop guides while ignoring a third unrelated guide) or query their entire library.
2. **Dense + Lexical Hybrid Retrieval**: Searches vector embeddings (semantic similarity) and lexical tokens (keyword exact match) in parallel, fusing candidates via Reciprocal Rank Fusion (RRF).
3. **Fail-Closed Evidence Gating**: Computes semantic support scores; if candidate passages do not reach the required confidence threshold, QueryVault delivers a controlled refusal rather than inventing an answer.
4. **Verifiable Inline Citations**: Answers contain canonical citation markers (`[source_1]`, `[source_2]`) mapped to the document name, page number, and original text snippet in an interactive side panel.
5. **Operator Observability**: Includes a live **TraceWaterfall** diagnostic dashboard showing stage-by-stage latencies (retrieval, rerank, support verification, generation) and token allocations.

---

## 2. Why QueryVault Exists

Standard RAG implementations suffer from four critical failure modes in real-world deployments:

| Standard RAG Flaw | How QueryVault Solves It |
|---|---|
| **Hallucination on missing facts** | **Fail-closed refusal**: If the retrieved passages do not contain the answer, the model explicitly refuses instead of guessing. |
| **Cross-document contamination** | **Strict document scoping**: Queries execute only against user-authorized, user-selected document IDs filtered at the database level. |
| **Vague or missing citations** | **Citation validation contract**: Every substantive block in the answer must carry a verified citation marker matching the evidence set; uncited claims reject the candidate response. |
| **Silent ingestion failures** | **Atomic job leasing & state machine**: Documents transition through `queued` → `extracting` → `chunking` → `embedding` → `ready` with durable retry limits and quarantine states for malformed files. |

---

## 3. Core Features

- **Multi-Format Document Parsing**: Native extraction for `.pdf`, `.docx`, `.txt`, `.md`, and `.xlsx` with magic byte validation and size limits.
- **Hybrid Fusion & Reranking**: Combines dense vector retrieval (HNSW in pgvector) and full-text keyword search (`tsvector` in PostgreSQL) with heuristic and cross-encoder reranking.
- **Citation Contract Validator**: Authoritative server-side validator that verifies bracketed citation markers against active evidence IDs before streaming to the client.
- **Concurrency-Controlled Ingestion**: 3-slot upload batching in the browser and atomic `SKIP LOCKED` database leasing on background worker tasks.
- **Row-Level Security (RLS)**: Enforces document and conversation isolation at the PostgreSQL layer so callers can never access another user's documents or embeddings.
- **Observability Dashboard**: Built-in `/admin` inspection view displaying query traces, refusal logs, reranker fallbacks, and stage-by-stage latency breakdowns.

---

## 4. Technology Stack

### Application & Routing
- **React 19 & TypeScript**: Strict type safety throughout client and server modules.
- **TanStack Router & TanStack Start**: Full-stack SSR framework with type-safe routing, server functions (`createServerFn`), and asset preloading.
- **Nitro / Node Server**: High-performance production server runtime.
- **Tailwind CSS v4 & Lucide Icons**: Modern design system and accessible icons.

### Data & Storage
- **PostgreSQL 15+ & pgvector**: Relational storage, user permissions, and high-dimensional vector similarity search.
- **Supabase Storage**: Private object storage buckets for raw uploaded files.
- **Supabase Auth**: Secure user authentication with bearer token validation and RLS session propagation.

### AI & Language Models
- **AI SDK**: Unified interface supporting **Google Gemini** (`gemini-1.5-flash`, `gemini-1.5-pro`) and OpenAI-compatible endpoints.
- **High-Dimensional Embeddings**: 3072-dimensional embeddings for deep semantic representation.
- **Claim-Evidence Verifier**: Secondary inference gate that validates semantic alignment between generated statements and source passages.

### Quality & Testing
- **Vitest**: 694 unit and integration tests covering chunking, ingestion state machines, RLS invariants, citation contracts, and cancellation.
- **Playwright**: End-to-end browser automation validating multi-document upload batches, 3-slot concurrency, error handling, and scroll anchoring.
- **Knip & depcheck**: Automated dead-code and unused dependency auditing.

---

## 5. System Architecture

```mermaid
flowchart TD
    subgraph Client["Browser Interface"]
        UI["Upload / Chat UI"]
        Queue["Upload Queue (max 3 concurrent)"]
        Inspector["Citation & Source Inspector"]
    end

    subgraph Server["TanStack Start / Nitro Server"]
        AuthMiddle["Auth Middleware & RLS Scoping"]
        UploadFn["Server Functions (Document Upload / List)"]
        ChatRoute["Chat API Route (/api/chat)"]
        WorkerDrain["Worker Drain (/api/public/worker-drain)"]
        CitationVal["Citation Contract Validator"]
    end

    subgraph Supabase["Database & Storage (Supabase)"]
        StorageBucket["Private Document Storage Bucket"]
        DB_Jobs["Ingestion Jobs Table (atomic lease)"]
        DB_Vectors["PostgreSQL + pgvector (Embeddings & tsvector)"]
        DB_RLS["Row-Level Security Policies"]
    end

    subgraph AI["AI Providers (Gemini / OpenAI-Compatible)"]
        Embedder["Embedding Model (3072 dimensions)"]
        Generator["Chat Generator (Answer streaming)"]
        Verifier["Support Verifier (Semantic claim check)"]
    end

    UI --> Queue
    Queue -->|1. Pre-sign upload| UploadFn
    UploadFn -->|2. Reserve slot & job| DB_Jobs
    Queue -->|3. Upload original| StorageBucket
    
    DB_Jobs -->|4. Claim job (SKIP LOCKED)| WorkerDrain
    WorkerDrain -->|5. Read file| StorageBucket
    WorkerDrain -->|6. Parse & chunk| WorkerDrain
    WorkerDrain -->|7. Generate vectors| Embedder
    WorkerDrain -->|8. Store chunks & vectors| DB_Vectors

    UI -->|9. Question + Selected Doc IDs| ChatRoute
    ChatRoute -->|10. Check auth & ownership| AuthMiddle
    AuthMiddle --> DB_RLS
    ChatRoute -->|11. Scoped hybrid retrieval| DB_Vectors
    DB_Vectors -->|12. Candidate chunks| ChatRoute
    ChatRoute -->|13. Evidence gate & fuse| ChatRoute
    ChatRoute -->|14. Prompt with evidence| Generator
    Generator -->|15. Candidate answer| CitationVal
    CitationVal -->|16. Validate claims & markers| Verifier
    CitationVal -->|17. Stream answer or refuse| UI
    UI --> Inspector
```

---

## 6. Document Ingestion & RAG Workflow

```
1. Document Ingestion Phase
   ├── File Admission: Check magic bytes (PDF, DOCX, XLSX, TXT, MD) and non-zero size.
   ├── Storage Reservation: Allocate private storage path keyed by user ID.
   ├── Background Worker: Atomic lease (`SKIP LOCKED`) prevents duplicate processing.
   ├── Extraction & Chunking: Extract text with page offsets; chunk text preserving standalone facts.
   └── Embedding & Indexing: Embed chunks and commit vectors + lexical tsvectors to Postgres.

2. Query & Retrieval Phase
   ├── Request Scoping: Client supplies question and optional array of selected document IDs.
   ├── Parallel Search: Dense vector cosine similarity + BM25 keyword matching execute in parallel.
   ├── Reciprocal Rank Fusion: Candidates are fused, scored, and passed through heuristic reranking.
   └── Evidence Gating: If top passages fall below required similarity, trigger immediate grounded refusal.

3. Generation & Verification Phase
   ├── Grounded Prompting: Format selected passages with immutable `[source_N]` markers.
   ├── Answer Streaming: Model produces candidate text citing source passages.
   ├── Citation Validation: Server checks that every substantive claim cites a known evidence ID.
   └── Delivery: Stream verified text with clickable citation links to the user.
```

---

## 7. Local Installation & Quickstart

### Prerequisites
- **Node.js**: `v20+` (Node 22 recommended)
- **npm**: `v10+`
- **Git**

### Installation

```bash
# 1. Clone the repository
git clone https://github.com/darshsoam/queryvault.git
cd queryvault

# 2. Switch to the active branch
git switch chore/queryvault-dead-code-cleanup

# 3. Install dependencies
npm ci
```

### Environment Configuration

Copy the example environment file:
```bash
cp .env.example .env
```

Configure your `.env` variables:
```ini
# Supabase Configuration
VITE_SUPABASE_URL="https://your-project.supabase.co"
VITE_SUPABASE_PUBLISHABLE_KEY="your-anon-key"
SUPABASE_SERVICE_ROLE_KEY="your-service-role-key"

# Ingestion Worker Secret (for trigger authorization)
INGESTION_WORKER_SECRET="your-secure-random-worker-secret"

# AI Provider Configuration (Gemini or OpenAI-compatible)
AI_PROVIDER="gemini"
GEMINI_API_KEY="your-gemini-api-key"
```

### Run the Development Server

```bash
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

---

## 8. AI Provider Configuration

QueryVault supports two AI backends configured via `AI_PROVIDER`:

### Option A: Google Gemini (Recommended)
Set the following in `.env`:
```ini
AI_PROVIDER="gemini"
GEMINI_API_KEY="AIzaSy..."
```
This uses `gemini-1.5-flash` for high-throughput streaming and evidence verification.

### Option B: OpenAI-Compatible Endpoint
```ini
AI_PROVIDER="openai-compatible"
OPENAI_API_KEY="sk-..."
# Optional overrides:
OPENAI_BASE_URL="https://api.openai.com/v1"
OPENAI_CHAT_MODEL="gpt-4o-mini"
OPENAI_EMBEDDING_MODEL="text-embedding-3-large"
```

### Option C: Zero-Cost / Offline Verification
For automated testing or demonstration without live model credits:
```ini
QV_LOCAL_ONLY="1"
VITE_QV_LOCAL_ONLY="1"
```

---

## 9. Verification & Testing Suite

QueryVault includes comprehensive test suites across every layer:

```bash
# 1. Type Check (0 errors expected)
npm run typecheck

# 2. Unit and Integration Tests (694 passed, 2 skipped)
npm test

# 3. Production Build Verification
npm run build

# 4. End-to-End Playwright Tests (multi-document, scroll pagination, demo flow)
npx playwright test

# 5. Offline Evaluation & Safety Gates
npm run eval:gate

# 6. Dead-Code and Unused Dependency Check
npx knip
npx depcheck
```

---

## 10. Live Demonstration & Rehearsal Guide

To present QueryVault in **6 minutes** without external dependencies:

### Automated Rehearsal Run
```bash
# Run the automated browser rehearsal (headless)
npm run demo:rehearse

# Run with interactive browser inspector to pause and step through actions
npm run demo:rehearse -- --headed --debug
```

### Presenter Walkthrough Script

Using the three included demo documents in `demo/documents/`:
- `harbor-guide.txt` (Harbor Workshop registration reference `HBR-204`, doors open at `09:30`).
- `harbor-travel.txt` (East entrance is step-free).
- `meadow-guide.txt` (Conflicting event: Meadow Workshop registration reference `MDW-909`, doors open at `13:00`).

| Step | Action | What to Point Out |
|---|---|---|
| **1. Ingestion** | Upload `harbor-guide.txt` and `harbor-travel.txt`. | Files queue in the sidebar, upload concurrently, and transition to **Ready** with chunk counts. |
| **2. Scoped Query** | Select **both** Harbor documents. Ask: *"When do doors open and which entrance is step-free?"* | The model answers **09:30** and **east entrance**, combining facts from both documents. |
| **3. Citation Inspection** | Click citation `[source_1]` and `[source_2]`. | The sidebar opens to show the exact file, page number, and source passage. |
| **4. Negative Proof** | Unselect Meadow. Ask: *"What is the Meadow registration code?"* | QueryVault explicitly **refuses** because Meadow is not in the selected evidence scope. |
| **5. Missing Info** | Ask: *"What is the ticket price?"* | Neither guide mentions a price; QueryVault delivers a clean grounded refusal rather than hallucinating a cost. |
| **6. Error Handling** | Upload an empty file or corrupt binary. | Shows immediate rejection and quarantine with non-crashing UI toast alerts. |

---

## Technical Documentation Index

For in-depth architectural and operational guides, see:

- [System Architecture](ARCHITECTURE.md): Detailed component diagrams and data flow contracts.
- [Demonstration Guide](docs/DEMO.md): Presenter timings, sample questions, and verification boundaries.
- [Testing & Evaluation](docs/TESTING.md): Vitest, RLS policy tests, Playwright scenarios, and evaluation gate specs.
- [Production Deployment](docs/DEPLOYMENT.md): Supabase deployment, Cloudflare/Nitro hosting, and environment variables.
- [Concurrent Ingestion](docs/CONCURRENT_INGESTION.md): Worker lease mechanics and upload queue scaling.
- [Architectural Decisions (ADR)](docs/DECISIONS.md): Rationale behind TanStack Start, pgvector, and Streamdown.
- [Security Model](docs/SECURITY.md): Token verification, RLS enforcement, and secret protection.

---

## License

QueryVault is licensed under the [MIT License](LICENSE).
