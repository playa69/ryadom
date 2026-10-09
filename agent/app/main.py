"""Точка входа сервиса agent «Слышу Рядом».

Упрощённый агент: контракт agent-api целиком (REST + WebSocket, текст и голос), ответы чат-модели
и распознавание речи через прокси программы, озвучка Qwen TTS / SaluteSpeech / espeak-ng, диалоги в памяти.
Нужен, чтобы проверить API, голос и интеграцию с приложением до появления настоящей логики
(openspec/changes/add-agent-service).
"""

import asyncio
import logging
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.api import dev, dialog_ws, dialogs, health
from app.clients.llm import ChatModel, Recognizer, build_models
from app.clients.speech import CachedTts, TextToSpeech, build_tts
from app.core.config import APP_CONFIG
from app.core.errors import install_error_handlers
from app.services.dialog_store import GREETINGS, DialogStore
from app.services.replies import CRISIS_REPLY, REPLIES, split_sentences

logger = logging.getLogger("agent")

# Всё, что агент произносит: приветствия, кризисный ответ (он важнее) и шаблонные ответы.
SPOKEN_PHRASES = (*GREETINGS, CRISIS_REPLY, *REPLIES)


class SkipServiceEndpoints(logging.Filter):
    """Служебные эндпоинты не пишутся в access-лог (specs/agent-api «Служебные эндпоинты»)."""

    PREFIXES = ("/health", "/version", "/metrics")

    def filter(self, record: logging.LogRecord) -> bool:
        # uvicorn.access: args = (клиент, метод, путь, версия HTTP, статус)
        args = record.args
        path = str(args[2]).split("?")[0] if isinstance(args, tuple) and len(args) >= 3 else ""
        return not path.startswith(self.PREFIXES)


def _quiet_service_endpoints() -> None:
    access = logging.getLogger("uvicorn.access")
    if not any(isinstance(f, SkipServiceEndpoints) for f in access.filters):
        access.addFilter(SkipServiceEndpoints())


def create_app(
    tts_factory: Callable[[], TextToSpeech | None] | None = None,
    models_factory: Callable[[], tuple[ChatModel | None, Recognizer | None]] | None = None,
) -> FastAPI:
    """Собирает FastAPI-приложение. Фабрики подменяют тесты; по умолчанию озвучка и модели берутся из конфига."""
    logging.basicConfig(level=APP_CONFIG.app.log_lvl, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    _quiet_service_endpoints()
    factory = tts_factory or (lambda: build_tts(APP_CONFIG.speech))
    models = models_factory or (lambda: build_models(APP_CONFIG.llm))

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.tts = factory()
        app.state.chat, app.state.recognizer = models()
        logger.info(
            "agent started: tts=%s llm=%s stt=%s",
            app.state.tts.name if app.state.tts else "none",
            app.state.chat.name if app.state.chat else "none",
            app.state.recognizer.name if app.state.recognizer else "none",
        )
        # Звук должен начаться за 0,9 с после текста, иначе клиент прочтёт его сам, а облачный синтез
        # медленнее. Всё, что агент говорит, шаблонное: готовим звук всех фраз заранее.
        warm_up = None
        if isinstance(app.state.tts, CachedTts):
            sentences = [part for phrase in SPOKEN_PHRASES for part in split_sentences(phrase)]
            warm_up = asyncio.create_task(app.state.tts.warm_up(sentences))
        try:
            yield
        finally:
            if warm_up is not None:
                warm_up.cancel()
            for client in (app.state.tts, app.state.chat, app.state.recognizer):
                if client is not None:
                    await client.aclose()

    app = FastAPI(title="ryadom-agent", version=APP_CONFIG.app.version, lifespan=lifespan)
    app.state.store = DialogStore(default_voice=APP_CONFIG.speech.default_voice)
    app.state.tts = None
    app.state.chat = None
    app.state.recognizer = None
    app.state.tts_mode = "auto"  # dev-переключатель озвучки, см. app/api/dev.py
    install_error_handlers(app)
    app.include_router(health.router)
    app.include_router(dialogs.router)
    app.include_router(dialog_ws.router)
    app.include_router(dev.router)
    return app


app = create_app()
