"""Точка входа сервиса agent «Слышу Рядом».

Lifespan собирает контекст приложения (LLM-клиент, журнал диалогов,
checkpointer, граф хода) в app.state.ctx и закрывает его на shutdown.
"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.api.deps import AppContext
from app.api.internal.router import router as internal_router
from app.api.internal.ws import router as ws_router
from app.clients.llm import CloudRuLLMClient
from app.core.config import APP_CONFIG
from app.graph.checkpointer import create_checkpointer
from app.graph.turn_graph import build_turn_graph
from app.services.dialogs import DialogStore


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Собирает контекст приложения на старте и освобождает ресурсы на shutdown."""
    llm = CloudRuLLMClient(
        base_url=APP_CONFIG.llm.base_url,
        api_key=APP_CONFIG.llm.api_key.get_secret_value(),
        timeout_seconds=APP_CONFIG.llm.timeout_seconds,
    )
    store = await DialogStore.create(APP_CONFIG.pg.sqlalchemy_database_uri)
    try:
        async with create_checkpointer(
            APP_CONFIG.pg.plain_dsn,
            min_size=APP_CONFIG.pg.checkpoint_pool_min_size,
            max_size=APP_CONFIG.pg.checkpoint_pool_max_size,
        ) as checkpointer:
            graph = build_turn_graph(llm, model=APP_CONFIG.llm.chat_model, checkpointer=checkpointer)
            app.state.ctx = AppContext(llm=llm, store=store, checkpointer=checkpointer, graph=graph)
            yield
    finally:
        await llm.aclose()
        await store.close()


def create_app() -> FastAPI:
    """Собирает FastAPI-приложение agent."""
    app = FastAPI(title="ryadom-agent", version=APP_CONFIG.app.version, lifespan=lifespan)
    app.include_router(internal_router)
    app.include_router(ws_router)

    @app.get("/health", include_in_schema=False)
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/version", include_in_schema=False)
    async def version() -> dict[str, str]:
        return {"version": APP_CONFIG.app.version}

    return app


app = create_app()
