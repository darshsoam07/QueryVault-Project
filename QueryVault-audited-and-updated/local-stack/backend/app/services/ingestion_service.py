"""Upload -> parse -> chunk -> embed -> index pipeline."""

import uuid
from pathlib import Path

from langchain_community.document_loaders import PyPDFLoader
from langchain_core.documents import Document
from langchain_text_splitters import RecursiveCharacterTextSplitter

from app.config import get_settings
from app.services import document_service, vector_store


class IngestionError(Exception):
    """Raised with a human-readable reason when ingestion fails."""


def _splitter() -> RecursiveCharacterTextSplitter:
    settings = get_settings()
    return RecursiveCharacterTextSplitter(
        chunk_size=settings.chunk_size,
        chunk_overlap=settings.chunk_overlap,
        separators=["\n\n", "\n", ". ", " ", ""],
    )


def load_pdf(path: str, document_id: str, filename: str) -> list[Document]:
    try:
        pages = PyPDFLoader(path).load()
    except Exception as exc:  # noqa: BLE001
        raise IngestionError(
            "This PDF could not be parsed. It may be corrupted or password protected."
        ) from exc

    docs: list[Document] = []
    for index, page in enumerate(pages):
        text = (page.page_content or "").strip()
        if not text:
            continue
        page_number = int(page.metadata.get("page", index)) + 1
        docs.append(
            Document(
                page_content=text,
                metadata={
                    "document_id": document_id,
                    "document_name": filename,
                    "source": filename,
                    "page_number": page_number,
                },
            )
        )

    if not docs:
        raise IngestionError(
            "No selectable text was found in this PDF. Scanned documents need OCR first."
        )
    return docs


def ingest_document(document_id: str) -> None:
    """Runs the real pipeline, writing each stage back to SQLite as it goes."""
    record = document_service.get_document(document_id)
    if record is None:
        return

    try:
        document_service.set_status(document_id, "parsing")
        pages = load_pdf(record["stored_path"], document_id, record["filename"])
        page_count = max(int(page.metadata["page_number"]) for page in pages)

        document_service.set_status(document_id, "chunking")
        chunks = _splitter().split_documents(pages)
        for position, chunk in enumerate(chunks):
            chunk.metadata["chunk_id"] = f"{document_id}:{position}"
            chunk.metadata["chunk_index"] = position

        document_service.set_status(document_id, "embedding")
        ids = [chunk.metadata["chunk_id"] for chunk in chunks]

        document_service.set_status(document_id, "indexing")
        vector_store.add_chunks(chunks, ids)

        document_service.mark_ready(document_id, page_count=page_count, chunk_count=len(chunks))
    except IngestionError as exc:
        document_service.mark_error(document_id, str(exc))
    except Exception as exc:  # noqa: BLE001
        document_service.mark_error(document_id, f"Indexing failed: {exc}")


def reindex_document(document_id: str) -> None:
    vector_store.delete_document(document_id)
    document_service.reset_for_reindex(document_id)
    ingest_document(document_id)


def new_stored_path(filename: str) -> tuple[str, str]:
    settings = get_settings()
    document_id = str(uuid.uuid4())
    stored = Path(settings.upload_dir) / f"{document_id}.pdf"
    return document_id, str(stored)
