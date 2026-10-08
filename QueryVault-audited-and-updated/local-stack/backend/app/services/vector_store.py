"""Persistent Chroma vector store. Created once, reused for the process lifetime."""

from functools import lru_cache
from typing import Optional

from langchain_chroma import Chroma
from langchain_core.documents import Document

from app.config import get_settings
from app.services.embedding_service import get_embeddings


@lru_cache(maxsize=1)
def get_vector_store() -> Chroma:
    settings = get_settings()
    return Chroma(
        collection_name=settings.chroma_collection,
        embedding_function=get_embeddings(),
        persist_directory=settings.chroma_dir,
    )


def add_chunks(chunks: list[Document], ids: list[str]) -> None:
    get_vector_store().add_documents(documents=chunks, ids=ids)


def delete_document(document_id: str) -> None:
    get_vector_store().delete(where={"document_id": document_id})


def count_chunks(document_id: Optional[str] = None) -> int:
    collection = get_vector_store()._collection  # noqa: SLF001 - Chroma has no public count API
    if document_id:
        return len(collection.get(where={"document_id": document_id}, include=[])["ids"])
    return collection.count()


def similarity_search(
    query: str, k: int, document_ids: Optional[list[str]] = None
) -> list[tuple[Document, float]]:
    where = None
    if document_ids:
        where = (
            {"document_id": document_ids[0]}
            if len(document_ids) == 1
            else {"$or": [{"document_id": doc_id} for doc_id in document_ids]}
        )
    return get_vector_store().similarity_search_with_relevance_scores(query, k=k, filter=where)
