import { VaultMark, Wordmark } from "@/components/queryvault/brand";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Copy } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/reference")({
  head: () => ({
    meta: [
      { title: "Python RAG Reference — QueryVault" },
      {
        name: "description",
        content:
          "Production-grade Python reference for a multi-document RAG service: LangChain loaders, chunking, embeddings, Chroma vector store, and a FastAPI query API.",
      },
      { property: "og:title", content: "Python RAG Reference — QueryVault" },
      {
        property: "og:description",
        content: "LangChain + Ollama + Chroma + FastAPI blueprint for multi-document RAG.",
      },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: ReferencePage,
});

const FILES: Array<{ id: string; path: string; language: string; code: string }> = [
  {
    id: "structure",
    path: "project structure",
    language: "text",
    code: `docmind/
├── app/
│   ├── __init__.py
│   ├── config.py            # pydantic-settings, env-driven
│   ├── main.py              # FastAPI app + routes
│   ├── ingest.py            # load -> split -> embed -> persist
│   ├── retriever.py         # vector store + retrieval strategy
│   ├── chain.py             # RAG chain with citations
│   └── schemas.py           # request/response models
├── data/
│   ├── raw/                 # uploaded source documents
│   └── chroma/              # persisted vector index
├── tests/
│   ├── test_ingest.py
│   └── test_chain.py
├── .env.example
├── requirements.txt
└── README.md`,
  },
  {
    id: "config",
    path: "app/config.py",
    language: "python",
    code: `from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Models
    llm_model: str = "llama3.1:8b"
    embed_model: str = "nomic-embed-text"
    ollama_base_url: str = "http://localhost:11434"

    # Chunking
    chunk_size: int = 1000
    chunk_overlap: int = 200

    # Retrieval
    top_k: int = 6
    score_threshold: float = 0.25

    # Storage
    raw_dir: Path = Path("data/raw")
    chroma_dir: Path = Path("data/chroma")
    collection: str = "docmind"


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    settings.raw_dir.mkdir(parents=True, exist_ok=True)
    settings.chroma_dir.mkdir(parents=True, exist_ok=True)
    return settings`,
  },
  {
    id: "ingest",
    path: "app/ingest.py",
    language: "python",
    code: `import hashlib
import logging
from pathlib import Path

from langchain_chroma import Chroma
from langchain_community.document_loaders import (
    Docx2txtLoader,
    PyPDFLoader,
    TextLoader,
)
from langchain_core.documents import Document
from langchain_ollama import OllamaEmbeddings
from langchain_text_splitters import RecursiveCharacterTextSplitter

from app.config import get_settings

logger = logging.getLogger(__name__)

LOADERS = {".pdf": PyPDFLoader, ".docx": Docx2txtLoader, ".txt": TextLoader, ".md": TextLoader}


def get_embeddings() -> OllamaEmbeddings:
    settings = get_settings()
    return OllamaEmbeddings(model=settings.embed_model, base_url=settings.ollama_base_url)


def get_vector_store() -> Chroma:
    settings = get_settings()
    return Chroma(
        collection_name=settings.collection,
        embedding_function=get_embeddings(),
        persist_directory=str(settings.chroma_dir),
    )


def load_document(path: Path) -> list[Document]:
    loader_cls = LOADERS.get(path.suffix.lower())
    if loader_cls is None:
        raise ValueError(f"Unsupported file type: {path.suffix}")
    return loader_cls(str(path)).load()


def split_documents(docs: list[Document]) -> list[Document]:
    settings = get_settings()
    splitter = RecursiveCharacterTextSplitter(
        chunk_size=settings.chunk_size,
        chunk_overlap=settings.chunk_overlap,
        separators=["\\n\\n", "\\n", ". ", " ", ""],
        length_function=len,
    )
    return splitter.split_documents(docs)


def ingest_file(path: Path, owner_id: str) -> dict:
    """Idempotent ingestion: content hash is the document id, so re-uploads replace."""
    digest = hashlib.sha256(path.read_bytes()).hexdigest()[:16]

    store = get_vector_store()
    store.delete(where={"doc_id": digest})  # replace previous version

    pages = load_document(path)
    chunks = split_documents(pages)
    if not chunks:
        raise ValueError("Document produced no text. Scanned PDFs require OCR.")

    for index, chunk in enumerate(chunks):
        chunk.metadata.update(
            {
                "doc_id": digest,
                "owner_id": owner_id,
                "filename": path.name,
                "chunk_index": index,
                "page": chunk.metadata.get("page", 0) + 1,
            }
        )

    ids = [f"{digest}:{i}" for i in range(len(chunks))]
    store.add_documents(chunks, ids=ids)

    logger.info("ingested %s chunks=%d doc_id=%s", path.name, len(chunks), digest)
    return {"doc_id": digest, "filename": path.name, "chunks": len(chunks), "pages": len(pages)}`,
  },
  {
    id: "chain",
    path: "app/chain.py",
    language: "python",
    code: `from langchain_core.output_parsers import StrOutputParser
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.runnables import RunnableLambda, RunnablePassthrough
from langchain_ollama import ChatOllama

from app.config import get_settings
from app.ingest import get_vector_store

SYSTEM = """You are DocMind, a precise document analyst.

Rules:
- Answer ONLY from the numbered context passages.
- If the context lacks the answer, reply exactly: "I don't know based on the provided documents."
- Cite passages inline as [1], [2].
- Never invent filenames, page numbers, or facts."""

PROMPT = ChatPromptTemplate.from_messages(
    [
        ("system", SYSTEM),
        ("human", "Context:\\n{context}\\n\\nChat history:\\n{history}\\n\\nQuestion: {question}"),
    ]
)


def format_context(docs) -> str:
    return "\\n\\n---\\n\\n".join(
        f"[{i + 1}] ({d.metadata['filename']}, page {d.metadata['page']})\\n{d.page_content}"
        for i, d in enumerate(docs)
    )


def build_retriever(owner_id: str, doc_ids: list[str] | None = None):
    settings = get_settings()
    where: dict = {"owner_id": owner_id}
    if doc_ids:
        where = {"$and": [{"owner_id": owner_id}, {"doc_id": {"$in": doc_ids}}]}

    return get_vector_store().as_retriever(
        search_type="similarity_score_threshold",
        search_kwargs={
            "k": settings.top_k,
            "score_threshold": settings.score_threshold,
            "filter": where,
        },
    )


def build_chain(owner_id: str, doc_ids: list[str] | None = None):
    settings = get_settings()
    llm = ChatOllama(
        model=settings.llm_model,
        base_url=settings.ollama_base_url,
        temperature=0.1,
    )
    retriever = build_retriever(owner_id, doc_ids)

    return (
        {
            "context": RunnableLambda(lambda x: x["question"]) | retriever | format_context,
            "question": RunnableLambda(lambda x: x["question"]),
            "history": RunnableLambda(lambda x: x.get("history", "")),
        }
        | PROMPT
        | llm
        | StrOutputParser()
    ), retriever`,
  },
  {
    id: "main",
    path: "app/main.py",
    language: "python",
    code: `import logging
import shutil
import time
import uuid
from pathlib import Path

from fastapi import Depends, FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.chain import build_chain
from app.config import get_settings
from app.ingest import ingest_file

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="DocMind RAG API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

MAX_UPLOAD_BYTES = 25 * 1024 * 1024


class QueryRequest(BaseModel):
    question: str = Field(min_length=3, max_length=2000)
    doc_ids: list[str] | None = None
    history: str = ""


def current_owner() -> str:
    """Replace with real auth (JWT/session). Every query is scoped to this id."""
    return "demo-user"


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/documents")
async def upload(file: UploadFile = File(...), owner: str = Depends(current_owner)) -> dict:
    settings = get_settings()
    if Path(file.filename).suffix.lower() not in {".pdf", ".docx", ".txt", ".md"}:
        raise HTTPException(415, "Unsupported file type")

    target = settings.raw_dir / f"{uuid.uuid4()}{Path(file.filename).suffix}"
    size = 0
    with target.open("wb") as sink:
        while chunk := await file.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_UPLOAD_BYTES:
                target.unlink(missing_ok=True)
                raise HTTPException(413, "File exceeds 25 MB")
            sink.write(chunk)

    try:
        return ingest_file(target, owner)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@app.post("/query")
def query(request: QueryRequest, owner: str = Depends(current_owner)) -> dict:
    started = time.perf_counter()
    chain, retriever = build_chain(owner, request.doc_ids)

    docs = retriever.invoke(request.question)
    answer = chain.invoke({"question": request.question, "history": request.history})

    return {
        "answer": answer,
        "sources": [
            {
                "filename": d.metadata["filename"],
                "page": d.metadata["page"],
                "doc_id": d.metadata["doc_id"],
                "snippet": d.page_content[:400],
            }
            for d in docs
        ],
        "latency_ms": round((time.perf_counter() - started) * 1000),
    }


@app.post("/query/stream")
def query_stream(request: QueryRequest, owner: str = Depends(current_owner)):
    chain, _ = build_chain(owner, request.doc_ids)

    def token_stream():
        for token in chain.stream({"question": request.question, "history": request.history}):
            yield token

    return StreamingResponse(token_stream(), media_type="text/plain")`,
  },
  {
    id: "requirements",
    path: "requirements.txt",
    language: "text",
    code: `fastapi==0.115.6
uvicorn[standard]==0.34.0
pydantic==2.10.4
pydantic-settings==2.7.0
python-multipart==0.0.20
langchain==0.3.14
langchain-community==0.3.14
langchain-ollama==0.2.2
langchain-chroma==0.2.0
langchain-text-splitters==0.3.5
chromadb==0.6.3
pypdf==5.1.0
docx2txt==0.8
pytest==8.3.4`,
  },
];

function CodeBlock({ code }: { code: string }) {
  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="icon-sm"
        className="absolute right-2 top-2 z-10"
        aria-label="Copy code"
        onClick={() => {
          void navigator.clipboard.writeText(code);
          toast.success("Copied to clipboard");
        }}
      >
        <Copy className="text-muted-foreground" />
      </Button>
      <pre className="max-h-[62vh] overflow-auto rounded-xl border border-border/60 bg-surface/60 p-4 font-mono text-[12px] leading-relaxed text-foreground">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function ReferencePage() {
  return (
    <main className="grid-void min-h-screen">
      <div className="mx-auto max-w-4xl px-6 py-10">
        <div className="flex items-center justify-between">
          <Link to="/chat" className="inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-cyan">
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to workspace
          </Link>
          <div className="flex items-center gap-2">
            <VaultMark className="h-5 w-5" />
            <Wordmark className="text-[13px]" />
          </div>
        </div>

        <h1 className="mt-8 text-3xl font-semibold tracking-tight text-foreground">
          Python <span className="text-gradient-brand">RAG reference</span>
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          The same architecture this app runs, expressed as a self-hosted Python service:
          LangChain loaders, recursive chunking at 1000/200, Ollama embeddings, a persisted Chroma
          index, and a FastAPI query API with citations and streaming.
        </p>
        <p className="mt-4 max-w-2xl rounded-lg border border-border/60 bg-surface/40 p-4 text-sm leading-relaxed text-muted-foreground">
          A complete, runnable version of this stack ships in the repository under{" "}
          <code className="font-mono text-foreground">local-stack/</code> — FastAPI + LangChain +
          persistent Chroma + HuggingFace <code className="font-mono">all-MiniLM-L6-v2</code> +
          Ollama <code className="font-mono">llama3</code>, with a React/Vite frontend, SQLite chat
          history and a Docker Compose file. See{" "}
          <code className="font-mono text-foreground">local-stack/README.md</code> to run it.
        </p>



        <Tabs defaultValue="structure" className="mt-8">
          <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1 bg-surface/50 p-1">
            {FILES.map((file) => (
              <TabsTrigger key={file.id} value={file.id} className="font-mono text-[11px]">
                {file.path}
              </TabsTrigger>
            ))}
          </TabsList>
          {FILES.map((file) => (
            <TabsContent key={file.id} value={file.id} className="mt-4">
              <CodeBlock code={file.code} />
            </TabsContent>
          ))}
        </Tabs>

        <section className="mt-10 rounded-xl border border-border/60 bg-surface/40 p-5">
          <h2 className="text-sm font-semibold text-foreground">Run it locally</h2>
          <pre className="mt-3 overflow-x-auto font-mono text-[12px] leading-relaxed text-muted-foreground">
{`ollama pull llama3.1:8b && ollama pull nomic-embed-text
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000`}
          </pre>
        </section>
      </div>
    </main>
  );
}
