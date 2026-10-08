from fastapi import APIRouter

from app.config import get_settings
from app.models.schemas import HealthOut, StatsOut
from app.services import document_service, embedding_service, llm_service, vector_store

router = APIRouter(tags=["system"])


@router.get("/health", response_model=HealthOut)
def health() -> HealthOut:
    settings = get_settings()
    reachable, model_available = llm_service.ollama_status()
    try:
        chunks = vector_store.count_chunks()
        store_status = "ok"
    except Exception:  # noqa: BLE001
        chunks = 0
        store_status = "error"

    return HealthOut(
        backend="ok",
        ollama_reachable=reachable,
        ollama_base_url=settings.ollama_base_url,
        model=settings.ollama_model,
        model_available=model_available,
        embedding_model=settings.embedding_model,
        embedding_loaded=embedding_service.is_loaded(),
        vector_store=store_status,
        vector_chunks=chunks,
        documents=document_service.counts()["documents"],
    )


@router.get("/stats", response_model=StatsOut)
def stats() -> StatsOut:
    return StatsOut(**document_service.counts())


@router.get("/settings")
def read_settings() -> dict:
    settings = get_settings()
    return {
        "ollama_model": settings.ollama_model,
        "embedding_model": settings.embedding_model,
        "vector_store": "Chroma",
        "collection": settings.chroma_collection,
        "retrieval_k": settings.retrieval_k,
        "chunk_size": settings.chunk_size,
        "chunk_overlap": settings.chunk_overlap,
        "max_upload_mb": settings.max_upload_mb,
    }
