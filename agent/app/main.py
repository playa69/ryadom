"""Точка входа сервиса agent «Слышу Рядом».

Упрощённый агент: контракт agent-api целиком (REST + WebSocket, текст и голос), ответы чат-модели
и распознавание речи через прокси программы, озвучка Qwen TTS / SaluteSpeech / espeak-ng, диалоги в памяти.
Нужен, чтобы проверить API, голос и интеграцию с приложением до появления настоящей логики
(openspec/changes/add-agent-service).

Голосовой конвейер задаёт `VOICE_PIPELINE`: `cascade` (по умолчанию) или `gemini_live` (речь в речь через Gemini Live).
В режиме gemini_live каскад остаётся запасным: если Gemini недоступен, реплики обрабатывает он (`GEMINI_FALLBACK`).
"""

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from typing import TYPE_CHECKING

from fastapi import FastAPI

from app.api import dev, dialog_ws, dialogs, health
from app.clients.llm import ChatModel, Recognizer, build_models
from app.clients.speech import CachedTts, FailoverTts, TextToSpeech, build_tts
from app.core.config import APP_CONFIG
from app.core.errors import install_error_handlers
from app.services.breaker import CircuitBreaker
from app.services.dialog_store import GREETINGS, DialogStore
from app.services.replies import CRISIS_REPLY, REPLIES, split_sentences

if TYPE_CHECKING:
    from app.clients.gemini_live import LiveConnector

logger = logging.getLogger("agent")

# Всё, что агент произносит: приветствия, кризисный ответ (он важнее) и шаблонные ответы.
SPOKEN_PHRASES = (*GREETINGS, CRISIS_REPLY, *REPLIES)
# Что нужно заранее озвучить голосом Gemini: приветствие должно зазвучать за 0,9 с, кризисный ответ важнее всего.
LIVE_SPOKEN_PHRASES = (*GREETINGS, CRISIS_REPLY)
PROBE_TICK_SECONDS = 1.0
PROBE_TIMEOUT_SECONDS = 10


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


def _warm_up_task(cache: object, phrases: tuple[str, ...]) -> "asyncio.Task[None] | None":
    if not isinstance(cache, CachedTts):
        return None
    sentences = [part for phrase in phrases for part in split_sentences(phrase)]
    return asyncio.create_task(cache.warm_up(sentences))


async def _probe_gemini(live: "LiveConnector", breaker: CircuitBreaker) -> None:
    """Пока размыкатель разомкнут, раз в паузу проверяет Gemini: открыл и закрыл соединение — значит ожил, реплики вернутся к нему."""
    while True:
        await asyncio.sleep(PROBE_TICK_SECONDS)
        if not breaker.probe_due():
            continue
        breaker.begin_probe()
        try:
            link = await asyncio.wait_for(live.open("male", "Проверка соединения."), PROBE_TIMEOUT_SECONDS)
            await link.aclose()
        except asyncio.CancelledError:
            raise
        except Exception as error:  # noqa: BLE001
            breaker.record_failure("probe_failed")
            logger.warning("gemini probe failed: %s", error)
        else:
            breaker.record_success()
            logger.info("gemini probe ok: реплики возвращаются к Gemini Live")


def create_app(
    tts_factory: Callable[[], TextToSpeech | None] | None = None,
    models_factory: Callable[[], tuple[ChatModel | None, Recognizer | None]] | None = None,
    live_factory: Callable[[], "LiveConnector | None"] | None = None,
    cascade_tts_factory: Callable[[], TextToSpeech | None] | None = None,
    breaker_factory: Callable[[], CircuitBreaker] | None = None,
) -> FastAPI:
    """Собирает FastAPI-приложение. Фабрики подменяют тесты; по умолчанию озвучка и модели берутся из конфига.

    `VOICE_PIPELINE=gemini_live` (или `live_factory` в тестах) включает речь в речь через Gemini Live. Каскад (чат, распознавание,
    озвучка Qwen) при этом поднимается запасным, если он настроен: Gemini недоступен — реплики и приветствие обрабатывает он.
    """
    logging.basicConfig(level=APP_CONFIG.app.log_lvl, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    _quiet_service_endpoints()
    if live_factory is None and APP_CONFIG.voice.pipeline == "gemini_live":

        def live_factory() -> "LiveConnector":
            from app.clients.gemini_live import build_live

            return build_live(APP_CONFIG.gemini)

    factory = tts_factory or (lambda: build_tts(APP_CONFIG.speech))
    models = models_factory or (lambda: build_models(APP_CONFIG.llm))
    cascade_tts_make = cascade_tts_factory or (lambda: build_tts(APP_CONFIG.speech))
    new_breaker = breaker_factory or (
        lambda: CircuitBreaker(APP_CONFIG.gemini.breaker_failures, APP_CONFIG.gemini.breaker_cooldown_seconds)
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        live = live_factory() if live_factory is not None else None
        app.state.live = live
        app.state.cascade_tts = None
        app.state.breaker = None
        warm_ups: list[asyncio.Task[None] | None] = []
        closers: list[object | None] = []
        probe: asyncio.Task[None] | None = None

        if live is None:
            app.state.tts = factory()
            app.state.chat, app.state.recognizer = models()
            closers = [app.state.tts, app.state.chat, app.state.recognizer]
            # Приветствие должно зазвучать за 0,9 с, иначе клиент прочтёт его сам, а облачный синтез медленнее.
            # Фиксированные фразы (приветствия, шаблоны, кризисный ответ) готовим заранее; ответы модели так не подготовить.
            warm_ups.append(_warm_up_task(app.state.tts, SPOKEN_PHRASES))
            fallback = "-"
        else:
            from app.clients.gemini_live import GeminiLiveTts

            chat: ChatModel | None = None
            recognizer: Recognizer | None = None
            cascade_tts: TextToSpeech | None = None
            if APP_CONFIG.gemini.fallback:
                # Запасной каскад необязателен: нет ключа прокси или LLM_MODE=template — значит отвечать будут шаблоны.
                try:
                    chat, recognizer = models()
                except RuntimeError as error:
                    logger.warning("запасной каскад: модели недоступны (%s), при отказе Gemini ответят шаблоны", error)
                try:
                    cascade_tts = cascade_tts_make()
                except RuntimeError as error:
                    logger.warning("запасной каскад: озвучка недоступна (%s)", error)
            if tts_factory is not None:
                primary: TextToSpeech | None = tts_factory()
            else:
                voice_tts = GeminiLiveTts(live)
                items = APP_CONFIG.speech.tts_cache_items
                primary = CachedTts(voice_tts, items) if items else voice_tts
            wrapped = tts_factory is None and primary is not None and cascade_tts is not None
            app.state.tts = FailoverTts(primary, cascade_tts) if wrapped else primary  # type: ignore[arg-type]
            app.state.cascade_tts = cascade_tts
            app.state.chat, app.state.recognizer = chat, recognizer
            closers = [app.state.tts, None if wrapped else cascade_tts, chat, recognizer, live]
            warm_ups += [_warm_up_task(primary, LIVE_SPOKEN_PHRASES), _warm_up_task(cascade_tts, SPOKEN_PHRASES)]
            breaker = new_breaker()
            app.state.breaker = breaker
            probe = asyncio.create_task(_probe_gemini(live, breaker))
            fallback = "cascade" if chat is not None else "template"

        logger.info(
            "agent started: pipeline=%s tts=%s llm=%s stt=%s fallback=%s",
            live.name if live else "cascade",
            app.state.tts.name if app.state.tts else "none",
            app.state.chat.name if app.state.chat else "none",
            app.state.recognizer.name if app.state.recognizer else "none",
            fallback,
        )
        try:
            yield
        finally:
            for task in (*warm_ups, probe):
                if task is not None:
                    task.cancel()
            for task in (*warm_ups, probe):
                if task is not None:
                    with contextlib.suppress(asyncio.CancelledError, Exception):
                        await task
            for client in closers:
                if client is not None:
                    await client.aclose()  # type: ignore[attr-defined]

    app = FastAPI(title="ryadom-agent", version=APP_CONFIG.app.version, lifespan=lifespan)
    app.state.store = DialogStore(default_voice=APP_CONFIG.speech.default_voice)
    app.state.tts = None
    app.state.chat = None
    app.state.recognizer = None
    app.state.live = None
    app.state.cascade_tts = None
    app.state.breaker = None
    app.state.tts_mode = "auto"  # dev-переключатель озвучки, см. app/api/dev.py
    install_error_handlers(app)
    app.include_router(health.router)
    app.include_router(dialogs.router)
    app.include_router(dialog_ws.router)
    app.include_router(dev.router)
    return app


app = create_app()
