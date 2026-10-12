"""Точка входа сервиса agent «Слышу Рядом».

Упрощённый агент: контракт agent-api целиком (REST + WebSocket, текст и голос), ответы чат-модели
и распознавание речи через прокси программы, озвучка Qwen TTS / SaluteSpeech / espeak-ng, диалоги в памяти с копией
на диске (DIALOG_DB_PATH): они переживают перезапуск и выкат пода.
Нужен, чтобы проверить API, голос и интеграцию с приложением до появления настоящей логики
(openspec/changes/add-agent-service).
"""

import asyncio
import logging
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager

from typing import TYPE_CHECKING

from fastapi import FastAPI

from app.api import dev, dialog_ws, dialogs, health
from app.clients.llm import ChatModel, Recognizer, build_models
from app.clients.speech import CachedTts, TextToSpeech, build_tts
from app.core.config import APP_CONFIG
from app.core.errors import install_error_handlers
from app.core.metrics import DIALOG_DB_ERRORS_TOTAL
from app.services.dialog_db import DialogDatabase
from app.services.dialog_store import GREETINGS, DialogStore
from app.services.replies import CRISIS_REPLY, REPLIES, split_sentences

if TYPE_CHECKING:
    from app.clients.gemini_live import LiveConnector

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
    live_factory: Callable[[], "LiveConnector | None"] | None = None,
    database_factory: Callable[[], DialogDatabase | None] | None = None,
) -> FastAPI:
    """Собирает FastAPI-приложение. Фабрики подменяют тесты; по умолчанию озвучка и модели берутся из конфига.

    `DIALOG_DB_PATH` (или `database_factory` в тестах) подключает диск к хранилищу диалогов; не открылся — диалоги остаются
    в памяти, агент не падает, но пишет об этом в журнал (ошибка) и показывает `dialogs: memory` в `/health/ready`.

    `VOICE_PIPELINE=gemini_live` (или `live_factory` в тестах) включает речь в речь через Gemini Live: чат и
    распознавание не создаются, фиксированные фразы озвучивает тот же голос Gemini.
    """
    logging.basicConfig(level=APP_CONFIG.app.log_lvl, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    _quiet_service_endpoints()
    if live_factory is None and APP_CONFIG.voice.pipeline == "gemini_live":

        def live_factory() -> "LiveConnector":
            from app.clients.gemini_live import build_live

            return build_live(APP_CONFIG.gemini)

    factory = tts_factory or (lambda: build_tts(APP_CONFIG.speech))
    models = models_factory or (lambda: build_models(APP_CONFIG.llm))
    make_database = database_factory or (
        lambda: DialogDatabase(APP_CONFIG.dialog.db_path) if APP_CONFIG.dialog.db_path else None
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        store: DialogStore = app.state.store
        database = make_database()
        if database is not None:
            store.require_disk()  # задан в настройках: пока не подключён, стирание людей отвечает ошибкой, а не «204»
            try:
                await store.attach(database, APP_CONFIG.dialog.db_flush_ms / 1000)
            except Exception:  # noqa: BLE001
                DIALOG_DB_ERRORS_TOTAL.labels("open").inc()
                logger.exception(
                    "dialog db is NOT available (%s): dialogs are kept in memory only and will be lost on restart",
                    getattr(database, "path", "?"),
                )
        live = live_factory() if live_factory is not None else None
        app.state.live = live
        if tts_factory is not None or live is None:
            app.state.tts = factory()
        else:
            from app.clients.gemini_live import GeminiLiveTts

            voice_tts = GeminiLiveTts(live)
            items = APP_CONFIG.speech.tts_cache_items
            app.state.tts = CachedTts(voice_tts, items) if items else voice_tts
        if live is not None and models_factory is None:
            app.state.chat, app.state.recognizer = None, None  # речь в речь: чат и распознавание не нужны
        else:
            app.state.chat, app.state.recognizer = models()
        logger.info(
            "agent started: pipeline=%s tts=%s llm=%s stt=%s dialogs=%s",
            live.name if live else "cascade",
            app.state.tts.name if app.state.tts else "none",
            app.state.chat.name if app.state.chat else "none",
            app.state.recognizer.name if app.state.recognizer else "none",
            "sqlite" if store.persistent else "memory",
        )
        # Приветствие должно зазвучать за 0,9 с, иначе клиент прочтёт его сам, а облачный синтез медленнее.
        # Фиксированные фразы (приветствия, шаблоны, кризисный ответ) готовим заранее; ответы модели так не подготовить.
        warm_up = None
        if isinstance(app.state.tts, CachedTts):
            phrases = (*GREETINGS, CRISIS_REPLY) if live is not None else SPOKEN_PHRASES
            sentences = [part for phrase in phrases for part in split_sentences(phrase)]
            warm_up = asyncio.create_task(app.state.tts.warm_up(sentences))
        try:
            yield
        finally:
            if warm_up is not None:
                warm_up.cancel()
            await store.detach()  # дописать на диск всё несохранённое, пока сокеты ещё закрываются
            for client in (app.state.tts, app.state.chat, app.state.recognizer, live):
                if client is not None:
                    await client.aclose()

    app = FastAPI(title="ryadom-agent", version=APP_CONFIG.app.version, lifespan=lifespan)
    app.state.store = DialogStore(default_voice=APP_CONFIG.speech.default_voice)
    app.state.tts = None
    app.state.chat = None
    app.state.recognizer = None
    app.state.live = None
    app.state.tts_mode = "auto"  # dev-переключатель озвучки, см. app/api/dev.py
    install_error_handlers(app)
    app.include_router(health.router)
    app.include_router(dialogs.router)
    app.include_router(dialog_ws.router)
    app.include_router(dev.router)
    return app


app = create_app()
