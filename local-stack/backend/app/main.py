import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import chat, documents, health
from app.config import get_settings
from app.models.database import init_db
from app.services.embedding_service import get_embeddings
from app.services.vector_store import get_vector_store

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s :: %(message)s"
)
logger = logging.getLogger("queryvault")


@asynccontextmanager
async def lifespan(_: FastAPI):
    settings = get_settings()
    init_db()
    logger.info("Loading embedding model %s", settings.embedding_model)
    get_embeddings()
    logger.info("Opening persistent Chroma collection %s", settings.chroma_collection)
    get_vector_store()
    logger.info("QueryVault backend ready")
    yield


settings = get_settings()
app = FastAPI(title=settings.app_name, version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router, prefix=settings.api_prefix)
app.include_router(documents.router, prefix=settings.api_prefix)
app.include_router(chat.router, prefix=settings.api_prefix)


@app.get("/")
def root() -> dict:
    return {"service": settings.app_name, "docs": "/docs", "api": settings.api_prefix}
