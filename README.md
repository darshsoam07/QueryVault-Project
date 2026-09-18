<div align="center">

QueryVault

AI-Powered, Evidence-Grounded Knowledge Platform

Upload your documents. Ask questions in natural language. Get answers grounded in your own knowledge base — with traceable sources.

<br/>








<br/>

<a href="https://github.com/darshsoam07/QueryVault-Project">GitHub Repository</a>

</div>

✨ At a Glance





What is it?

A multi-tenant RAG knowledge platform for document-grounded Q&A

Core idea

Retrieve relevant evidence first, then generate an answer constrained by that evidence

Search

Dense vector retrieval + PostgreSQL full-text search + Reciprocal Rank Fusion

Security

Supabase Auth + PostgreSQL Row-Level Security

Storage

Private Supabase Storage

AI layer

OpenAI-compatible AI gateway and embedding models

Ingestion

Database-backed jobs with scheduled worker execution

Observability

Health checks, telemetry, query tracing, rate limiting and structured errors

Validation

Automated tests + RAG evaluation tooling

📑 Table of Contents

✨ At a Glance

🎥 Demo

📸 Screenshots

🎯 Problem

💡 Solution

🏗️ Architecture

🔄 RAG Pipeline

⭐ Key Features

🧰 Technology Stack

📂 Project Structure

🚀 Getting Started

🧪 Testing

🔐 Security

📚 Documentation

⚠️ Current Limitations

🗺️ Future Scope

🎓 Mini-Project Summary

👤 Author

🎥 Demo

Replace the placeholder below with the final demo GIF before sharing the repository.

<!-- DEMO GIF PLACEHOLDER
Recommended path:
assets/demo/queryvault-demo.gif

Example:
<img src="assets/demo/queryvault-demo.gif" alt="QueryVault product demo" width="900">
-->

<div align="center">

[ 🎬 Demo GIF — Coming Soon ]

Recommended demo flow: Sign in → upload a document → wait for indexing → ask a question → inspect citations.

</div>

📸 Screenshots

A visual walkthrough makes the repository much easier to understand during a project review or presentation.

01 — Dashboard

<!-- SCREENSHOT PLACEHOLDER
Recommended file: assets/screenshots/dashboard.png
-->

🖼️ Screenshot placeholder — Dashboard

Add: assets/screenshots/dashboard.png

02 — Document Upload & Processing

<!-- SCREENSHOT PLACEHOLDER
Recommended file: assets/screenshots/document-upload.png
-->

🖼️ Screenshot placeholder — Document upload / processing

Add: assets/screenshots/document-upload.png

03 — Chat & Grounded Answer

<!-- SCREENSHOT PLACEHOLDER
Recommended file: assets/screenshots/chat-answer.png
-->

🖼️ Screenshot placeholder — Chat response with citations

Add: assets/screenshots/chat-answer.png

04 — Retrieved Evidence / Sources

<!-- SCREENSHOT PLACEHOLDER
Recommended file: assets/screenshots/evidence-citations.png
-->

🖼️ Screenshot placeholder — Retrieved evidence and citations

Add: assets/screenshots/evidence-citations.png

🎯 Problem

Traditional document search has two common limitations:

Keyword-only search can miss relevant information when the wording differs.

General-purpose LLMs can generate plausible answers that are not grounded in the user's documents.

For a knowledge assistant, the user needs more than an answer — they need a way to understand where that answer came from.

💡 Solution

QueryVault combines document retrieval with LLM generation through a Retrieval-Augmented Generation (RAG) architecture.

Instead of:

Question ───────────────► LLM ───────────────► Answer

QueryVault uses:

Question
   │
   ▼
Retrieve relevant evidence
   │
   ▼
Build grounded context
   │
   ▼
Generate answer
   │
   ▼
Validate citations / evidence
   │
   ▼
Answer + Sources

This makes the generated response traceable to the indexed document content.

🏗️ Architecture

┌──────────────────────────────────────────────────────────────┐
│                         QUERYVAULT                            │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────────────┐                                         │
│  │     Browser     │                                         │
│  │ React / TanStack│                                         │
│  └────────┬────────┘                                         │
│           │ HTTPS                                            │
│           ▼                                                  │
│  ┌──────────────────────────────┐                            │
│  │      TanStack Start         │                            │
│  │     UI + Server APIs        │                            │
│  └──────────────┬───────────────┘                            │
│                 │                                            │
│       ┌─────────┼─────────┐                                  │
│       │         │         │                                  │
│       ▼         ▼         ▼                                  │
│  ┌─────────┐ ┌────────┐ ┌─────────────┐                     │
│  │ Supabase│ │  RAG   │ │ Auth + RLS  │                     │
│  │ Postgres│ │ Engine │ │ Tenant      │                     │
│  │ Storage │ │        │ │ Isolation   │                     │
│  └────┬────┘ └────┬───┘ └─────────────┘                     │
│       │            │                                         │
│       │            ▼                                         │
│       │       ┌──────────┐                                  │
│       │       │   LLM    │                                  │
│       │       │Generation│                                  │
│       │       └────┬─────┘                                  │
│       │            │                                         │
│       ▼            ▼                                         │
│  ┌──────────────────────────┐                               │
│  │  Indexed Knowledge +     │                               │
│  │  Grounded Answer +       │                               │
│  │  Traceable Citations     │                               │
│  └──────────────────────────┘                               │
│                                                              │
└──────────────────────────────────────────────────────────────┘

Design principles

Principle

Implementation

Grounding

Retrieved document evidence is supplied to generation

Traceability

Responses expose source/citation information

Hybrid retrieval

Vector + lexical search are fused

Tenant isolation

PostgreSQL RLS protects user-owned data

Durable ingestion

Processing is represented as database-backed jobs

Fail-closed security

Privileged credentials remain server-side

Observability

Health, telemetry and query tracing are built in

Testability

Critical RAG and security paths are covered by automated tests

🔄 RAG Pipeline

Phase 1 — Document Ingestion

Upload
  │
  ▼
Document record
  │
  ▼
Ingestion job
  │
  ▼
Scheduled worker
  │
  ├── Parse
  ├── Chunk
  ├── Generate embeddings
  └── Index
  │
  ▼
Searchable knowledge base

The ingestion architecture is designed so processing does not depend on the browser tab remaining open.

Phase 2 — Hybrid Retrieval

QueryVault combines two complementary search strategies:

                         User Question
                              │
                              ▼
                     Query processing
                              │
              ┌───────────────┴───────────────┐
              │                               │
              ▼                               ▼
       Dense retrieval                 Lexical retrieval
          pgvector                         PostgreSQL FTS
              │                               │
              └───────────────┬───────────────┘
                              ▼
                    Reciprocal Rank Fusion
                              │
                              ▼
                         Re-ranking
                              │
                              ▼
                     Top evidence chunks

Phase 3 — Grounded Generation

Top evidence chunks
        │
        ▼
 Context builder
        │
        ▼
 Grounded prompt
        │
        ▼
      LLM
        │
        ▼
Citation / evidence gate
        │
        ▼
Streamed answer + sources

⭐ Key Features

📄 Document Knowledge Base

Upload and manage documents.

Track document processing status.

Store source files in private Supabase Storage.

Preserve document/page metadata for citations.

Remove documents and their indexed chunks together.

🔎 Hybrid Search

Combines:

Semantic similarity through pgvector

Keyword-sensitive retrieval through PostgreSQL Full-Text Search

Reciprocal Rank Fusion

Re-ranking of retrieved candidates

🤖 Evidence-Grounded Answers

The system builds the LLM context from retrieved document evidence and validates citation/evidence information before returning the response.

💬 Conversational Q&A

Thread-based conversations

Streaming responses

Markdown rendering

Source/citation display

Retrieved evidence inspection

Conversation history

🔐 Multi-Tenant Security

Supabase Authentication

PostgreSQL Row-Level Security

Server-side privileged credentials

Protected worker authentication

Private document storage

⚙️ Durable Background Processing

Document ingestion is represented as database-backed jobs and executed through a scheduled worker flow.

📊 Observability

Includes infrastructure for:

Health endpoints

Query tracing

Telemetry

Rate limiting

Structured error handling

Runtime configuration validation

Scheduler/worker checks

🧰 Technology Stack

<table>
<tr>
<th>Layer</th>
<th>Technology</th>
<th>Role</th>
</tr>
<tr>
<td><b>Frontend</b></td>
<td>React 19 + TypeScript</td>
<td>Interactive product UI</td>
</tr>
<tr>
<td><b>Application</b></td>
<td>TanStack Start</td>
<td>Full-stack routing, SSR and server APIs</td>
</tr>
<tr>
<td><b>Runtime</b></td>
<td>Node.js 22 / Nitro</td>
<td>Application runtime</td>
</tr>
<tr>
<td><b>Database</b></td>
<td>Supabase PostgreSQL</td>
<td>Application and RAG data</td>
</tr>
<tr>
<td><b>Vector Search</b></td>
<td>pgvector + HNSW</td>
<td>Semantic retrieval</td>
</tr>
<tr>
<td><b>Lexical Search</b></td>
<td>PostgreSQL FTS</td>
<td>Keyword-aware retrieval</td>
</tr>
<tr>
<td><b>Authentication</b></td>
<td>Supabase Auth</td>
<td>User authentication</td>
</tr>
<tr>
<td><b>File Storage</b></td>
<td>Supabase Storage</td>
<td>Private document storage</td>
</tr>
<tr>
<td><b>AI</b></td>
<td>OpenAI-compatible AI gateway</td>
<td>Generation and embeddings</td>
</tr>
<tr>
<td><b>UI</b></td>
<td>Tailwind CSS + Radix UI</td>
<td>Design system and components</td>
</tr>
<tr>
<td><b>Testing</b></td>
<td>Vitest + Testing Library</td>
<td>Automated validation</td>
</tr>
<tr>
<td><b>CI / Deployment</b></td>
<td>GitHub Actions + Docker</td>
<td>Automation and deployment workflows</td>
</tr>
</table>

📂 Project Structure

QueryVault-Project/
│
├── src/
│   ├── components/
│   │   ├── ai-elements/       # Chat / streaming UI primitives
│   │   ├── queryvault/        # Product-specific UI
│   │   └── ui/                # Reusable UI components
│   │
│   ├── integrations/
│   │   └── supabase/          # Supabase clients & auth handling
│   │
│   ├── lib/
│   │   ├── config/            # Runtime / environment validation
│   │   ├── ingestion/         # Durable ingestion worker
│   │   ├── observability/     # Health, telemetry & tracing
│   │   └── retrieval/          # RAG retrieval pipeline
│   │
│   ├── routes/
│   │   ├── api/
│   │   │   ├── chat.ts        # Streaming chat endpoint
│   │   │   ├── health.ts      # Health endpoint
│   │   │   └── public/
│   │   │       └── worker-drain.ts
│   │   ├── auth.tsx           # Authentication
│   │   ├── chat.*.tsx         # Chat experience
│   │   └── reference.tsx      # Technical reference
│   │
│   └── server.ts              # Server entry / checks
│
├── supabase/
│   ├── migrations/            # Schema, RLS & infrastructure
│   └── bootstrap.sql          # Consolidated provisioning
│
├── evaluation/                # RAG evaluation dataset & runner
├── local-stack/               # Standalone FastAPI reference stack
├── docs/                      # Deployment, security & testing
├── Dockerfile
└── package.json

🚀 Getting Started

Prerequisites

Install:

Node.js 22+

npm

A Supabase project

An AI provider/API key supported by the configured gateway

Supabase CLI for migration-based provisioning

1. Clone the repository

git clone https://github.com/darshsoam07/QueryVault-Project.git
cd QueryVault-Project

2. Install dependencies

npm install

3. Configure environment variables

cp .env.example .env

Populate the variables documented in .env.example.

🔒 Never commit .env, service-role keys, AI API keys, worker secrets, or production credentials.

4. Provision Supabase

Preferred migration workflow:

supabase link --project-ref <your-project-ref>
supabase db push

For first-time consolidated provisioning, the repository also provides:

supabase/bootstrap.sql

See docs/DEPLOYMENT.md for the full procedure.

5. Start the application

npm run dev

🧪 Testing

QueryVault includes automated validation around application behavior, security, retrieval, ingestion and operational workflows.

Validation commands

npm test
npm run typecheck
npm run lint

RAG evaluation

npm run eval

Quality-gated evaluation:

npm run eval:gate

Current repository validation

Area

Coverage

Automated tests

254 passing

RLS isolation tests

32

RAG ground-truth cases

13

TypeScript

Included

ESLint

Included

Worker / scheduler behavior

Included

Security / configuration

Included

Test counts can change as the codebase evolves. Treat the repository's current test output as the authoritative result.

🔐 Security

Security is treated as an architectural boundary.

Tenant isolation

Authenticated User
       │
       ▼
 Supabase Auth
       │
       ▼
 PostgreSQL RLS
       │
       ├── Documents
       ├── Chunks
       ├── Threads
       ├── Messages
       └── Operational Records

Server-side secrets

Privileged credentials and worker secrets are kept on the server and are not intended for browser exposure.

Private document storage

Uploaded files are stored in a private storage bucket and accessed through controlled application flows.

Security documentation

See docs/SECURITY.md.

📚 Documentation

Document

Description

ARCHITECTURE.md

End-to-end architecture

docs/DEPLOYMENT.md

Deployment and Supabase setup

docs/SECURITY.md

Security model and considerations

docs/TESTING.md

Test strategy and validation

docs/DOCKER.md

Docker workflow

docs/DECISIONS.md

Architecture decisions

CHANGELOG.md

Project changes

⚠️ Current Limitations

A few deployment-state considerations remain intentionally documented:

The ingestion scheduler requires application to a live Supabase project for production operation.

Docker configuration is included, but image build/push requires a working container environment.

Live RAG evaluation depends on external AI/database credentials and service availability.

These are deployment considerations rather than assumptions hidden from the user.

🗺️ Future Scope

Potential extensions include:

📑 Additional document formats and richer parsing

🌐 Broader knowledge-source connectors

🧠 Improved retrieval/reranking strategies

📈 More detailed evaluation dashboards

👥 Advanced team/workspace administration

🔍 More granular evidence exploration

☁️ Expanded production deployment automation

🎓 Mini-Project Summary

Problem Statement

Users often need to find and understand information distributed across multiple documents. Keyword search may miss semantic relationships, while general-purpose LLMs may produce answers that are difficult to verify.

Proposed Solution

QueryVault implements a document-grounded conversational assistant using Retrieval-Augmented Generation. Documents are processed into searchable chunks, relevant evidence is retrieved using hybrid search, and an LLM generates an answer from that evidence.

Key Technical Contribution

The project goes beyond a basic RAG prototype by incorporating:

Hybrid semantic + lexical retrieval

Citation/evidence validation

Multi-tenant PostgreSQL RLS

Durable background ingestion

Private document storage

Observability and operational controls

Automated security and RAG testing

End Result

User
 │
 │ uploads documents
 ▼
QueryVault Knowledge Base
 │
 │ asks a question
 ▼
Hybrid Retrieval
 │
 │ finds relevant evidence
 ▼
Grounded LLM Generation
 │
 │ validates sources
 ▼
Answer + Citations

👤 Author

<div align="center">

Darsh Soam



QueryVault — AI-powered, evidence-grounded document intelligence

View Repository →

</div>

<div align="center">

Built with React · TanStack Start · Supabase · PostgreSQL · pgvector · RAG

</div>
