import json
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from app.models.database import get_connection


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def create_conversation(title: str) -> str:
    conversation_id = str(uuid.uuid4())
    now = _now()
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
            (conversation_id, title[:80] or "New conversation", now, now),
        )
    return conversation_id


def ensure_conversation(conversation_id: Optional[str], title: str) -> str:
    if conversation_id:
        with get_connection() as conn:
            row = conn.execute(
                "SELECT id FROM conversations WHERE id = ?", (conversation_id,)
            ).fetchone()
        if row:
            return conversation_id
    return create_conversation(title)


def add_message(
    conversation_id: str, role: str, content: str, sources: Optional[list[dict]] = None
) -> None:
    with get_connection() as conn:
        conn.execute(
            """INSERT INTO messages (id, conversation_id, role, content, sources, created_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (
                str(uuid.uuid4()),
                conversation_id,
                role,
                content,
                json.dumps(sources or []),
                _now(),
            ),
        )
        conn.execute(
            "UPDATE conversations SET updated_at = ? WHERE id = ?", (_now(), conversation_id)
        )


def list_conversations() -> list[dict[str, Any]]:
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT * FROM conversations ORDER BY updated_at DESC"
        ).fetchall()
    return [dict(row) for row in rows]


def list_messages(conversation_id: str) -> list[dict[str, Any]]:
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at",
            (conversation_id,),
        ).fetchall()
    messages = []
    for row in rows:
        item = dict(row)
        item["sources"] = json.loads(item.get("sources") or "[]")
        messages.append(item)
    return messages


def delete_conversation(conversation_id: str) -> None:
    with get_connection() as conn:
        conn.execute("DELETE FROM messages WHERE conversation_id = ?", (conversation_id,))
        conn.execute("DELETE FROM conversations WHERE id = ?", (conversation_id,))
