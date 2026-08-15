"""Ollama / Llama 3 client. One reusable instance per process."""

from functools import lru_cache

import httpx
from langchain_ollama import ChatOllama

from app.config import get_settings


class LLMUnavailable(Exception):
    """Raised with a user-facing message when Ollama or the model is not usable."""


@lru_cache(maxsize=1)
def get_llm() -> ChatOllama:
    settings = get_settings()
    return ChatOllama(
        base_url=settings.ollama_base_url,
        model=settings.ollama_model,
        temperature=0.1,
        timeout=settings.ollama_timeout_seconds,
    )


def ollama_status() -> tuple[bool, bool]:
    """Returns (ollama_reachable, model_available)."""
    settings = get_settings()
    try:
        response = httpx.get(f"{settings.ollama_base_url}/api/tags", timeout=3.0)
        response.raise_for_status()
        models = [m.get("name", "") for m in response.json().get("models", [])]
    except Exception:  # noqa: BLE001
        return False, False
    wanted = settings.ollama_model
    available = any(name == wanted or name.split(":")[0] == wanted.split(":")[0] for name in models)
    return True, available


def generate(system_prompt: str, user_prompt: str) -> str:
    settings = get_settings()
    reachable, available = ollama_status()
    if not reachable:
        raise LLMUnavailable(
            "Unable to connect to Ollama. Make sure Ollama is running locally "
            f"({settings.ollama_base_url}) and that the {settings.ollama_model} model is installed."
        )
    if not available:
        raise LLMUnavailable(
            f"The model '{settings.ollama_model}' is not installed in Ollama. "
            f"Run: ollama pull {settings.ollama_model}"
        )
    try:
        response = get_llm().invoke(
            [("system", system_prompt), ("human", user_prompt)]
        )
    except Exception as exc:  # noqa: BLE001
        raise LLMUnavailable(f"The local model failed to respond in time: {exc}") from exc
    return str(response.content).strip()
