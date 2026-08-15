"""Retrieval + grounded generation."""

from pathlib import Path
from typing import Optional

from app.config import get_settings
from app.services import citation_service, llm_service, vector_store

NO_CONTEXT_ANSWER = (
    "I couldn't find sufficient information about this in the uploaded documents."
)

PROMPT_PATH = Path(__file__).resolve().parent.parent / "prompts" / "rag_prompt.txt"


def system_prompt() -> str:
    return PROMPT_PATH.read_text(encoding="utf-8")


def build_context(sources: list[dict]) -> str:
    blocks = []
    for index, source in enumerate(sources, start=1):
        blocks.append(
            f"[{index}] Document: {source['document_name']} | Page: {source['page_number']}\n"
            f"{source['snippet_full']}"
        )
    return "\n\n---\n\n".join(blocks)


def answer_question(
    question: str,
    document_ids: Optional[list[str]] = None,
    k: Optional[int] = None,
) -> dict:
    settings = get_settings()
    top_k = k or settings.retrieval_k

    results = vector_store.similarity_search(question, k=top_k, document_ids=document_ids)
    if not results:
        return {
            "answer": NO_CONTEXT_ANSWER,
            "sources": [],
            "retrieved_chunks": [],
            "grounded": False,
        }

    retrieved = citation_service.build_sources(results)
    context_rows = [
        {**source, "snippet_full": document.page_content}
        for source, (document, _score) in zip(retrieved, results)
    ]

    answer = llm_service.generate(
        system_prompt(),
        f"Context:\n\n{build_context(context_rows)}\n\nQuestion: {question}",
    )

    grounded = NO_CONTEXT_ANSWER.lower()[:40] not in answer.lower()
    sources = citation_service.dedupe_by_page(retrieved) if grounded else []
    return {
        "answer": answer,
        "sources": sources,
        "retrieved_chunks": retrieved,
        "grounded": grounded,
    }
