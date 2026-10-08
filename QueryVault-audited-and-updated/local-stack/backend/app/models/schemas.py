from typing import Literal, Optional

from pydantic import BaseModel, Field

DocumentStatus = Literal[
    "uploading", "parsing", "chunking", "embedding", "indexing", "ready", "error"
]


class DocumentOut(BaseModel):
    id: str
    filename: str
    file_size: int
    file_type: str
    upload_time: str
    status: DocumentStatus
    page_count: int
    chunk_count: int
    error_message: Optional[str] = None


class Source(BaseModel):
    document_id: str
    document_name: str
    page_number: int
    chunk_id: str
    relevance_score: float
    snippet: str


class ChatRequest(BaseModel):
    question: str = Field(min_length=1, max_length=4000)
    conversation_id: Optional[str] = None
    document_ids: Optional[list[str]] = None
    k: Optional[int] = Field(default=None, ge=1, le=20)


class ChatResponse(BaseModel):
    conversation_id: str
    answer: str
    sources: list[Source]
    retrieved_chunks: list[Source]
    grounded: bool


class MessageOut(BaseModel):
    id: str
    role: str
    content: str
    sources: list[Source] = []
    created_at: str


class ConversationOut(BaseModel):
    id: str
    title: str
    created_at: str
    updated_at: str


class HealthOut(BaseModel):
    backend: str
    ollama_reachable: bool
    ollama_base_url: str
    model: str
    model_available: bool
    embedding_model: str
    embedding_loaded: bool
    vector_store: str
    vector_chunks: int
    documents: int


class StatsOut(BaseModel):
    documents: int
    ready_documents: int
    chunks: int
    conversations: int
    messages: int
