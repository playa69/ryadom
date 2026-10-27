"""Точка входа сервиса agent «Слышу Рядом».

Контракт agent-api целиком (REST + WebSocket, текст и голос). Голос — Gemini Live (речь в речь, app/api/dialog_live.py);
текстовая модель прокси программы пишет только фоновые тексты (итоги разговоров и недели, заметки памяти). Диалоги живут в памяти
с копией в PostgreSQL (DIALOG_DATABASE_URL): они переживают перезапуск и выкат пода. Память агента — заметки в PostgreSQL и поиск
по прошлым разговорам в Cognee.
"""

import asyncio
import logging
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from typing import TYPE_CHECKING, Any

from fastapi import FastAPI

from app.api import dialog_ws, dialogs, digests, health, memory
from app.clients.cognee import build_cognee_client
from app.clients.background_model import BackgroundModel, ProxyBackgroundModel, build_background_model
from app.clients.speech import CachedTts, TextToSpeech
from app.core.config import APP_CONFIG, MemorySettings
from app.core.errors import install_error_handlers
from app.core.metrics import DIALOG_DB_ERRORS_TOTAL
from app.core.reclaim import MemoryReclaimer
from app.core.tracing import build_tracer
from app.memory.backend import MemoryBackend
from app.memory.cognee_backend import CogneeMemoryBackend
from app.memory.extractor import NotesExtractor
from app.services.dialog_db import DialogDatabase
from app.services.dialog_store import GREETINGS, DialogStore
from app.services.gemini_budget import TokenBudget
from app.services.langfuse_usage import start_langfuse_sink
from app.services.replies import CRISIS_REPLY, REPEAT_REQUEST, split_sentences

if TYPE_CHECKING:
    from app.clients.gemini_live import LiveConnector

logger = logging.getLogger("agent")

# Готовые фразы агента: приветствия, кризисный ответ (он важнее) и просьба повторить. Их озвучивает голос Gemini и запоминает
# память фраз: клиент ждёт приветствие не дольше 0,9 с, а новая сессия Gemini открывается около секунды.
SPOKEN_PHRASES = (*GREETINGS, CRISIS_REPLY, REPEAT_REQUEST)
# Сколько сессий Gemini прогрев держит открытыми одновременно (фраза — сессия): 16 открытий разом на старте Google встречал
# отказами, и после них половина фраз оставалась не прогретой.
WARM_UP_GEMINI_SESSIONS = 3


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


NATIVE_TELEMETRY_OFF: Any = {
    "tracing": False,
    "metrics": False,
    "logs": False,
    "operation_spans": False,
    "auto_configure": False,
}


def _build_live() -> "LiveConnector":
    from app.clients.gemini_live import build_live

    return build_live(APP_CONFIG.gemini)


def _build_notes_model(memory_cfg: MemorySettings) -> ProxyBackgroundModel | None:
    """Модель извлечения заметок: свой экземпляр фоновой модели (`MEMORY_NOTES_MODEL`, по умолчанию `LLM_CHAT_MODEL`).
    Нет ключа прокси — извлечения нет, разговор идёт как раньше."""
    cfg = APP_CONFIG.background_model
    if cfg.api_key is None or not cfg.base_url:
        return None
    return ProxyBackgroundModel(
        cfg.base_url,
        cfg.api_key.get_secret_value(),
        memory_cfg.notes_model or cfg.chat_model,
        max_tokens=600,
        temperature=0.0,
        timeout_seconds=max(cfg.timeout_seconds, 30),
    )


def create_app(
    live_factory: Callable[[], "LiveConnector"] | None = None,
    tts_factory: Callable[[], TextToSpeech | None] | None = None,
    background_factory: Callable[[], BackgroundModel | None] | None = None,
    database_factory: Callable[[], DialogDatabase | None] | None = None,
    memory_settings: MemorySettings | None = None,
) -> FastAPI:
    """Собирает FastAPI-приложение. Фабрики подменяют тесты; по умолчанию всё берётся из конфига.

    Голос — Gemini Live (`live_factory`; по умолчанию `build_live(GEMINI_*)`, без `GEMINI_API_KEY` сервис не стартует). Фиксированные
    фразы (приветствие, кризисный ответ, просьба повторить) озвучивает тот же голос Gemini (`GeminiLiveTts`) с памятью фраз
    (`tts_factory` в тестах подменяет озвучку).

    Фоновая модель (`background_factory`; по умолчанию `LLM_*`, прокси программы) пишет фоновые тексты: итоги разговоров и недели.
    Нет ключа прокси — модели нет, итоги не подводятся, а разговор идёт как обычно.

    Хранилище диалогов (`DIALOG_DATABASE_URL` → PostgreSQL; в тестах — `database_factory`): не открылось —
    диалоги остаются в памяти, агент не падает, но пишет об этом в журнал (ошибка) и показывает `dialogs: memory`
    в `/health/ready`.

    Память агента (`MEMORY_*`, или `memory_settings` в тестах) — датасеты Cognee (`app/memory/cognee_backend.py`):
    транскрипт после разговора, сводка в разговор, согласие человека. Хранилище диалогов память не определяет.

    Учёт токенов Gemini (`GEMINI_TPM_LIMIT`, app/services/gemini_budget.py) создаётся всегда (при лимите 0 он выключен): окно
    только измеряется, а после отказа Google по квоте включается пауза.
    """
    logging.basicConfig(level=APP_CONFIG.app.log_lvl, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    _quiet_service_endpoints()
    make_live = live_factory or _build_live
    make_background = background_factory or (lambda: build_background_model(APP_CONFIG.background_model))

    def make_configured_database() -> DialogDatabase | None:
        # DIALOG_DATABASE_URL задан — диалоги в PostgreSQL; пусто — только в памяти процесса (разработка).
        if APP_CONFIG.dialog.database_url:
            return DialogDatabase(
                APP_CONFIG.dialog.database_url,
                min_size=APP_CONFIG.dialog.db_pool_min_size,
                max_size=APP_CONFIG.dialog.db_pool_max_size,
                max_idle=APP_CONFIG.dialog.db_pool_max_idle_seconds,
                max_lifetime=APP_CONFIG.dialog.db_pool_max_lifetime_seconds,
            )
        return None

    make_database = database_factory or make_configured_database
    memory_cfg = memory_settings or APP_CONFIG.memory

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        store: DialogStore = app.state.store
        # Хранилище диалогов (PostgreSQL) и память (Cognee) независимы. Без хранилища диалоги живут в памяти процесса
        # и пропадают при перезапуске (разработка).
        database = make_database()
        if database is not None:
            store.require_disk()  # задан в настройках: пока не подключён, стирание людей отвечает ошибкой, а не «204»
            try:
                await store.attach(database, APP_CONFIG.dialog.db_flush_ms / 1000)
            except Exception:  # noqa: BLE001
                DIALOG_DB_ERRORS_TOTAL.labels("open").inc()
                logger.exception(
                    "dialog db is NOT available (%s): dialogs are kept in memory only and will be lost on restart",
                    getattr(database, "label", "?"),  # не path/dsn: в DSN пароль
                )
        cognee_client = build_cognee_client(memory_cfg)
        if cognee_client is not None:
            try:
                await cognee_client.connect()
            except Exception:  # noqa: BLE001 - память недоступна до первого удачного перелогина, агент работает
                logger.exception("cognee login failed at startup")
        memory_service: MemoryBackend = CogneeMemoryBackend(cognee_client, memory_cfg, lambda: store.database)
        store.memory = memory_service
        app.state.memory = memory_service
        if isinstance(memory_service, CogneeMemoryBackend):
            memory_service.start_outbox()  # очередь индекса прошлых разговоров в Cognee
        notes_model = _build_notes_model(memory_cfg)
        if notes_model is not None and isinstance(memory_service, CogneeMemoryBackend):
            memory_service.set_extractor(NotesExtractor(notes_model, memory_service.notes))
        if memory_service.status() == "unavailable":
            logger.error("memory is NOT available: no COGNEE_BASE_URL/COGNEE_SERVICE_EMAIL/COGNEE_SERVICE_PASSWORD")
        live = make_live()
        app.state.live = live
        budget = TokenBudget(APP_CONFIG.gemini)
        app.state.budget = budget
        tracer = build_tracer(APP_CONFIG.langfuse)
        app.state.tracer = tracer
        if tts_factory is not None:
            app.state.tts = tts_factory()
            warm_up_parallel = 1  # по одной фразе за раз
        else:
            from app.clients.gemini_live import GeminiLiveTts

            voice_tts = GeminiLiveTts(live, budget=budget)
            items = APP_CONFIG.speech.tts_cache_items
            app.state.tts = CachedTts(voice_tts, items) if items else voice_tts
            warm_up_parallel = WARM_UP_GEMINI_SESSIONS
        # Фоновая модель: итоги разговоров и недели (заметки памяти берут свой экземпляр, `_build_notes_model`).
        background = make_background()
        if background is None:
            logger.warning("background model is not configured (AGENT_API_TOKEN, LLM_BASE_URL): recaps and weekly digests are off")
        app.state.background = background
        store.recap_model = background
        store.recap_timeout_seconds = APP_CONFIG.dialog.recap_timeout_seconds
        store.retention_days = APP_CONFIG.dialog.retention_days
        logger.info(
            "agent started: voice=%s tts=%s background=%s dialogs=%s memory=%s tracing=%s gemini budget limit=%d (measure only)",
            live.name,
            app.state.tts.name if app.state.tts else "none",
            background.name if background else "none",
            store.persistence,
            memory_service.status(),
            tracer.name,
            APP_CONFIG.gemini.tpm_limit if budget.enabled else 0,
        )
        # Приветствие должно зазвучать за 0,9 с, иначе клиент прочтёт его сам, а открытие сессии Gemini занимает около секунды.
        # Фиксированные фразы (приветствия, кризисный ответ, просьба повторить) готовим заранее и держим в памяти фраз: каждая
        # звучит оттуда тем же голосом, без новой сессии Gemini на показ. Ответы модели так не подготовить: их звук приходит
        # от самой модели.
        warm_up = None
        if isinstance(app.state.tts, CachedTts):
            sentences = [part for phrase in SPOKEN_PHRASES for part in split_sentences(phrase)]
            warm_up = asyncio.create_task(app.state.tts.warm_up(sentences, parallel=warm_up_parallel))
        langfuse = start_langfuse_sink(APP_CONFIG.langfuse)
        # Давно неактивные люди уходят из памяти пода (с диском), метрики памяти обновляются; останавливается до `detach`.
        evictor = asyncio.create_task(store.evict_loop(APP_CONFIG.dialog.evict_interval_seconds), name="dialog-evictor")
        # После прогрева стартовые объекты замораживаются для сборщика мусора, дальше память раз в MEMORY_RECLAIM_SECONDS
        # возвращается системе (app/core/reclaim.py).
        reclaimer = MemoryReclaimer(APP_CONFIG.memory_reclaim.seconds)
        reclaimer.start(warm_up)
        try:
            yield
        finally:
            evictor.cancel()
            await asyncio.gather(evictor, return_exceptions=True)
            await reclaimer.stop()
            if langfuse is not None:
                langfuse.close()
            if warm_up is not None:
                warm_up.cancel()
            if isinstance(memory_service, CogneeMemoryBackend):
                await memory_service.stop_outbox()
            if notes_model is not None:
                await memory_service.drain()  # дописать идущие проходы извлечения
                await notes_model.aclose()
            if cognee_client is not None:
                await memory_service.drain()  # дождаться идущих записей и prefetch'ей Cognee
                await cognee_client.aclose()
            await store.detach()  # дописать на диск всё несохранённое, пока сокеты ещё закрываются
            store.memory = None
            for client in (app.state.tts, background, live):
                if client is not None:
                    await client.aclose()
            await tracer.aclose()  # отправить в Langfuse накопленные трассы

    # Встроенная телеметрия FastAPI (OpenTelemetry) включается сама, когда в образе есть opentelemetry-sdk (его тянет langfuse), и
    # без отключения отправляла бы в Langfuse трассы каждого запроса, в том числе GET /health каждые 10 секунд, а пути запросов
    # несут id человека. В Langfuse уходят только наши трассы ходов (app/core/tracing.py).
    app = FastAPI(title="ryadom-agent", version=APP_CONFIG.app.version, lifespan=lifespan, telemetry=NATIVE_TELEMETRY_OFF)
    app.state.store = DialogStore(
        default_voice=APP_CONFIG.speech.default_voice,
        idle_evict_seconds=APP_CONFIG.dialog.idle_evict_seconds,
        max_users_in_memory=APP_CONFIG.dialog.max_users_in_memory,
        idle_end_seconds=APP_CONFIG.dialog.idle_end_seconds,
    )
    app.state.tts = None  # озвучка фраз (в lifespan)
    app.state.background = None  # фоновая модель итогов (в lifespan)
    app.state.live = None  # Gemini Live (в lifespan)
    app.state.memory = None
    app.state.budget = None  # учёт токенов Gemini (в lifespan)
    app.state.tracer = None  # подменяется в lifespan (build_tracer); None до старта приложения
    install_error_handlers(app)
    app.include_router(health.router)
    app.include_router(dialogs.router)
    app.include_router(memory.router)
    app.include_router(digests.router)
    app.include_router(dialog_ws.router)
    return app


app = create_app()
