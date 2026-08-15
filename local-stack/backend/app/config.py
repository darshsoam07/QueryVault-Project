from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_name: str = "QueryVault RAG API"
    api_prefix: str = "/api"
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"

    ollama_base_url: str = "http://localhost:11434"
    ollama_model: str = "llama3"
    ollama_timeout_seconds: int = 180

    embedding_model: str = "sentence-transformers/all-MiniLM-L6-v2"

    chroma_dir: str = "./data/chroma"
    chroma_collection: str = "rag_documents"
    upload_dir: str = "./data/uploads"
    database_url: str = "sqlite:///./data/app.db"

    chunk_size: int = 1000
    chunk_overlap: int = 200
    retrieval_k: int = 4
    max_upload_mb: int = 50

    @property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    def ensure_dirs(self) -> None:
        Path(self.chroma_dir).mkdir(parents=True, exist_ok=True)
        Path(self.upload_dir).mkdir(parents=True, exist_ok=True)
        Path("./data").mkdir(parents=True, exist_ok=True)


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    settings.ensure_dirs()
    return settings
