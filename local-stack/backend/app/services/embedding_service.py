"""Single, process-wide embedding model instance."""

from functools import lru_cache

from langchain_huggingface import HuggingFaceEmbeddings

from app.config import get_settings

_loaded = False


@lru_cache(maxsize=1)
def get_embeddings() -> HuggingFaceEmbeddings:
    global _loaded
    settings = get_settings()
    embeddings = HuggingFaceEmbeddings(
        model_name=settings.embedding_model,
        encode_kwargs={"normalize_embeddings": True},
    )
    _loaded = True
    return embeddings


def is_loaded() -> bool:
    return _loaded
