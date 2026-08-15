from fastapi import APIRouter, HTTPException

from app.models.schemas import ChatRequest, ChatResponse, ConversationOut, MessageOut
from app.services import chat_history_service, llm_service, rag_service

router = APIRouter(tags=["chat"])


@router.post("/chat", response_model=ChatResponse)
def chat(payload: ChatRequest) -> ChatResponse:
    question = payload.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="Please enter a question.")

    conversation_id = chat_history_service.ensure_conversation(
        payload.conversation_id, question
    )
    chat_history_service.add_message(conversation_id, "user", question)

    try:
        result = rag_service.answer_question(
            question, document_ids=payload.document_ids, k=payload.k
        )
    except llm_service.LLMUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=500, detail=f"Retrieval failed: {exc}"
        ) from exc

    chat_history_service.add_message(
        conversation_id, "assistant", result["answer"], result["sources"]
    )

    return ChatResponse(
        conversation_id=conversation_id,
        answer=result["answer"],
        sources=result["sources"],
        retrieved_chunks=result["retrieved_chunks"],
        grounded=result["grounded"],
    )


@router.get("/conversations", response_model=list[ConversationOut])
def list_conversations() -> list[ConversationOut]:
    return [ConversationOut(**row) for row in chat_history_service.list_conversations()]


@router.get("/conversations/{conversation_id}/messages", response_model=list[MessageOut])
def list_messages(conversation_id: str) -> list[MessageOut]:
    return [
        MessageOut(
            id=row["id"],
            role=row["role"],
            content=row["content"],
            sources=row["sources"],
            created_at=row["created_at"],
        )
        for row in chat_history_service.list_messages(conversation_id)
    ]


@router.delete("/conversations/{conversation_id}", status_code=204)
def delete_conversation(conversation_id: str) -> None:
    chat_history_service.delete_conversation(conversation_id)
