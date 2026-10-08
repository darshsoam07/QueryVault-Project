from fastapi import APIRouter, BackgroundTasks, File, HTTPException, UploadFile

from app.config import get_settings
from app.models.schemas import DocumentOut
from app.services import document_service, ingestion_service, vector_store

router = APIRouter(prefix="/documents", tags=["documents"])

ALLOWED_TYPES = {"application/pdf", "application/x-pdf"}


def _to_out(record: dict) -> DocumentOut:
    return DocumentOut(
        id=record["id"],
        filename=record["filename"],
        file_size=record["file_size"],
        file_type=record["file_type"],
        upload_time=record["upload_time"],
        status=record["status"],
        page_count=record["page_count"],
        chunk_count=record["chunk_count"],
        error_message=record["error_message"],
    )


@router.post("/upload", response_model=DocumentOut, status_code=201)
async def upload_document(
    background_tasks: BackgroundTasks, file: UploadFile = File(...)
) -> DocumentOut:
    settings = get_settings()
    filename = document_service.sanitize_filename(file.filename or "document.pdf")

    if not filename.lower().endswith(".pdf") or (
        file.content_type and file.content_type not in ALLOWED_TYPES
    ):
        raise HTTPException(status_code=400, detail="Only PDF files are supported right now.")

    payload = await file.read()
    if not payload:
        raise HTTPException(status_code=400, detail="That file is empty.")
    if len(payload) > settings.max_upload_mb * 1024 * 1024:
        raise HTTPException(
            status_code=413,
            detail=f"Files must be smaller than {settings.max_upload_mb} MB.",
        )
    if not payload.startswith(b"%PDF"):
        raise HTTPException(status_code=400, detail="That file is not a valid PDF.")

    document_id, stored_path = ingestion_service.new_stored_path(filename)
    with open(stored_path, "wb") as handle:
        handle.write(payload)

    document_service.create_document(document_id, filename, stored_path, len(payload))
    background_tasks.add_task(ingestion_service.ingest_document, document_id)

    record = document_service.get_document(document_id)
    assert record is not None
    return _to_out(record)


@router.get("", response_model=list[DocumentOut])
def list_documents() -> list[DocumentOut]:
    return [_to_out(record) for record in document_service.list_documents()]


@router.get("/{document_id}", response_model=DocumentOut)
def get_document(document_id: str) -> DocumentOut:
    record = document_service.get_document(document_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Document not found.")
    return _to_out(record)


@router.delete("/{document_id}", status_code=204)
def delete_document(document_id: str) -> None:
    record = document_service.get_document(document_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Document not found.")
    vector_store.delete_document(document_id)
    document_service.delete_document(document_id)


@router.post("/{document_id}/reindex", response_model=DocumentOut)
def reindex_document(
    document_id: str, background_tasks: BackgroundTasks
) -> DocumentOut:
    record = document_service.get_document(document_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Document not found.")
    document_service.set_status(document_id, "parsing")
    background_tasks.add_task(ingestion_service.reindex_document, document_id)
    record = document_service.get_document(document_id)
    assert record is not None
    return _to_out(record)
