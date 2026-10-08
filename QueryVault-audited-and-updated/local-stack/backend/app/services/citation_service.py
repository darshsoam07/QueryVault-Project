"""Builds citations strictly from retrieved chunks - never from model output."""

from langchain_core.documents import Document


def to_source(document: Document, score: float) -> dict:
    text = document.page_content.strip().replace("\n", " ")
    return {
        "document_id": document.metadata.get("document_id", ""),
        "document_name": document.metadata.get("document_name", "Unknown document"),
        "page_number": int(document.metadata.get("page_number", 0)),
        "chunk_id": document.metadata.get("chunk_id", ""),
        "relevance_score": round(float(score), 4),
        "snippet": text[:320] + ("..." if len(text) > 320 else ""),
    }


def build_sources(results: list[tuple[Document, float]]) -> list[dict]:
    return [to_source(document, score) for document, score in results]


def dedupe_by_page(sources: list[dict]) -> list[dict]:
    seen: set[tuple[str, int]] = set()
    unique: list[dict] = []
    for source in sources:
        key = (source["document_id"], source["page_number"])
        if key in seen:
            continue
        seen.add(key)
        unique.append(source)
    return unique
