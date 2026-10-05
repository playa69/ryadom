"""Точка входа сервиса agent «Слышу Рядом».

Упрощённый агент: контракт agent-api целиком (REST + WebSocket, текст и голос), шаблонные ответы,
диалоги в памяти, озвучка через SaluteSpeech или espeak-ng. Нужен, чтобы проверить API, озвучку и
интеграцию с приложением до появления настоящей логики (openspec/changes/add-agent-service).
"""

import logging
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.api import dev, dialog_ws, dialogs, health
from app.clients.speech import TextToSpeech, build_tts
from app.core.config import APP_CONFIG
from app.core.errors import install_error_handlers
from app.services.dialog_store import DialogStore

logger = logging.getLogger("agent")


def create_app(tts_factory: Callable[[], TextToSpeech | None] | None = None) -> FastAPI:
    """Собирает FastAPI-приложение. `tts_factory` подменяют тесты; по умолчанию озвучка берётся из конфига."""
    logging.basicConfig(level=APP_CONFIG.app.log_lvl, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    factory = tts_factory or (lambda: build_tts(APP_CONFIG.speech))

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.tts = factory()
        logger.info("agent started: tts=%s", app.state.tts.name if app.state.tts else "none")
        try:
            yield
        finally:
            if app.state.tts is not None:
                await app.state.tts.aclose()

    app = FastAPI(title="ryadom-agent", version=APP_CONFIG.app.version, lifespan=lifespan)
    app.state.store = DialogStore()
    app.state.tts = None
    install_error_handlers(app)
    app.include_router(health.router)
    app.include_router(dialogs.router)
    app.include_router(dialog_ws.router)
    app.include_router(dev.router)
    return app


app = create_app()
