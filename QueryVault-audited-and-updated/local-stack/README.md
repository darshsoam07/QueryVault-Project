# Archived/reference local RAG stack — not used by the production QueryVault application

> This directory is a self-contained FastAPI + Chroma + Ollama reference implementation.
> It is **not** connected to Supabase and is not used by the production TanStack Start
> QueryVault application, its deployment, CI, or tests. Keep it only for local RAG
> experimentation; use the repository root application for production work.

A real, working Retrieval-Augmented Generation application that runs entirely on your
machine: FastAPI + LangChain + Chroma + HuggingFace embeddings + Ollama (Llama 3),
with a React/Vite/TypeScript frontend.

Nothing in this stack is mocked. Every document, chunk count, citation and answer
comes from the actual pipeline.

## Requirements

- Python 3.11+
- Node.js 20+
- [Ollama](https://ollama.com/download)

## 1. Ollama

```bash
ollama serve          # keep running
ollama pull llama3
```

## 2. Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --reload --port 8000
```

API docs: http://localhost:8000/docs

The first start downloads `all-MiniLM-L6-v2` (~90 MB) once and loads it into memory
for the process lifetime.

## 3. Frontend

```bash
cd frontend
npm install
npm run dev
```

App: http://localhost:5173 (Vite proxies `/api` to the backend).

## How RAG works here

```
Upload PDF
  -> validate (type, size, magic bytes) and store in data/uploads
  -> PyPDFLoader extracts text per page (page numbers preserved)
  -> RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=200)
  -> HuggingFaceEmbeddings(all-MiniLM-L6-v2)
  -> Chroma persistent collection "rag_documents" (./data/chroma)
  -> document + chunk metadata written to SQLite

Ask a question
  -> embed the question
  -> Chroma similarity search (top k = 4, configurable)
  -> build context with document name + page metadata
  -> strict grounded system prompt -> Llama 3 via Ollama
  -> answer + citations built from the retrieved chunks only
```

Each chunk carries `document_id`, `document_name`, `source`, `page_number` and
`chunk_id`, so citations always point at real retrieved evidence.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Backend, Ollama, model, vector store status |
| GET | `/api/stats` | Document / chunk / conversation counts |
| GET | `/api/settings` | Effective backend configuration |
| POST | `/api/documents/upload` | Upload + ingest a PDF |
| GET | `/api/documents` | List documents with live status |
| GET | `/api/documents/{id}` | Single document |
| DELETE | `/api/documents/{id}` | Delete document, vectors and file |
| POST | `/api/documents/{id}/reindex` | Re-run the pipeline for one document |
| POST | `/api/chat` | Ask a question, get answer + sources |
| GET | `/api/conversations` | Chat history |
| GET | `/api/conversations/{id}/messages` | Messages in a conversation |
| DELETE | `/api/conversations/{id}` | Delete a conversation |

## Persistence

- Vectors: `backend/data/chroma` (survives restarts, never rebuilt on boot)
- Files: `backend/data/uploads`
- Metadata and chat history: `backend/data/app.db` (SQLite)

## Configuration

Everything is set in `backend/.env` (see `.env.example`): Ollama URL and model,
embedding model, Chroma directory, retrieval `k`, chunk size/overlap, upload limit,
CORS origins.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "Unable to connect to Ollama" | Run `ollama serve` and confirm `http://localhost:11434` |
| "model 'llama3' is not installed" | `ollama pull llama3` |
| "No selectable text was found" | The PDF is scanned; OCR it before uploading |
| Frontend shows "Can't reach the backend" | Start uvicorn on port 8000 |
| Slow first answer | Llama 3 loads into memory on first generation |
| Want a clean slate | Delete `backend/data/` and restart the backend |

## Docker

```bash
docker compose up --build
```

Runs the backend on 8000 and the frontend dev server on 5173. Ollama runs on the
host; the containers reach it through `host.docker.internal`.
