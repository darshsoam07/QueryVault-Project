import os
import re
from datetime import datetime, timezone
from typing import Any, Optional

from app.models.database import get_connection


def sanitize_filename(name: str) -> str:
    base = os.path.basename(name or "document.pdf")
    base = re.sub(r"[^A-Za-z0-9._ \-()]+", "_", base).strip() or "document.pdf"
    return base[:180]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def create_document(
    document_id: str, filename: str, stored_path: str, file_size: int
) -> None:
    with get_connection() as conn:
        conn.execute(
            """INSERT INTO documents
               (id, filename, stored_path, file_size, file_type, upload_time, status)
               VALUES (?, ?, ?, ?, 'application/pdf', ?, 'uploading')""",
            (document_id, filename, stored_path, file_size, _now()),
        )


def set_status(document_id: str, status: str) -> None:
    with get_connection() as conn:
        conn.execute("UPDATE documents SET status = ? WHERE id = ?", (status, document_id))


def mark_ready(document_id: str, page_count: int, chunk_count: int) -> None:
    with get_connection() as conn:
        conn.execute(
            """UPDATE documents
               SET status = 'ready', page_count = ?, chunk_count = ?, error_message = NULL
               WHERE id = ?""",
            (page_count, chunk_count, document_id),
        )


def mark_error(document_id: str, message: str) -> None:
    with get_connection() as conn:
        conn.execute(
            "UPDATE documents SET status = 'error', error_message = ? WHERE id = ?",
            (message, document_id),
        )


def reset_for_reindex(document_id: str) -> None:
    with get_connection() as conn:
        conn.execute(
            """UPDATE documents
               SET status = 'parsing', chunk_count = 0, page_count = 0, error_message = NULL
               WHERE id = ?""",
            (document_id,),
        )


def list_documents() -> list[dict[str, Any]]:
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT * FROM documents ORDER BY upload_time DESC"
        ).fetchall()
    return [dict(row) for row in rows]


def get_document(document_id: str) -> Optional[dict[str, Any]]:
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM documents WHERE id = ?", (document_id,)).fetchone()
    return dict(row) if row else None


def delete_document(document_id: str) -> Optional[dict[str, Any]]:
    record = get_document(document_id)
    if record is None:
        return None
    with get_connection() as conn:
        conn.execute("DELETE FROM documents WHERE id = ?", (document_id,))
    try:
        os.remove(record["stored_path"])
    except OSError:
        pass
    return record


def counts() -> dict[str, int]:
    with get_connection() as conn:
        docs = conn.execute("SELECT COUNT(*) AS c FROM documents").fetchone()["c"]
        ready = conn.execute(
            "SELECT COUNT(*) AS c FROM documents WHERE status = 'ready'"
        ).fetchone()["c"]
        chunks = conn.execute(
            "SELECT COALESCE(SUM(chunk_count), 0) AS c FROM documents"
        ).fetchone()["c"]
        convos = conn.execute("SELECT COUNT(*) AS c FROM conversations").fetchone()["c"]
        msgs = conn.execute("SELECT COUNT(*) AS c FROM messages").fetchone()["c"]
    return {
        "documents": docs,
        "ready_documents": ready,
        "chunks": chunks,
        "conversations": convos,
        "messages": msgs,
    }
