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

from typing import TYPE_CHECKING, Any

from fastapi import FastAPI

from app.api import dev, dialog_ws, dialogs, health, memory
from app.clients.cognee import CogneeClient, build_cognee_client
from app.clients.llm import ChatModel, Recognizer, build_models
from app.clients.speech import CachedTts, TextToSpeech, build_tts
from app.core.config import APP_CONFIG, MemorySettings
from app.core.errors import install_error_handlers
from app.core.reclaim import MemoryReclaimer
from app.core.metrics import DIALOG_DB_ERRORS_TOTAL
from app.memory.backend import MemoryBackend
from app.memory.cognee_backend import CogneeMemoryBackend
from app.memory.llm import ExtractionModel, build_memory_llm
from app.memory.service import MemoryService
from app.memory.worker import MemoryWorker
from app.core.tracing import build_tracer
from app.services.dialog_db import DialogDatabase
from app.services.dialog_store import GREETINGS, DialogStore
from app.services.langfuse_usage import start_langfuse_sink
from app.services.gemini_budget import CascadeFallback, TokenBudget
from app.services.replies import CRISIS_REPLY, REPLIES, split_sentences

if TYPE_CHECKING:
    from app.clients.gemini_live import LiveConnector

logger = logging.getLogger("agent")

# Всё, что агент произносит: приветствия, кризисный ответ (он важнее) и шаблонные ответы.
SPOKEN_PHRASES = (*GREETINGS, CRISIS_REPLY, *REPLIES)

FallbackParts = tuple[ChatModel | None, Recognizer | None, TextToSpeech | None]


def _build_fallback() -> FallbackParts:
    """Каскад как запасной путь режима gemini_live: чат, распознавание и озвучка из `LLM_MODE`, `LLM_BASE_URL`, `TTS_MODE`,
    `QWEN_TTS_*`, `AGENT_API_TOKEN`. Не настроено что-то — без этой части (а не отказ старта: режиму Gemini они не нужны)."""
    chat: ChatModel | None = None
    recognizer: Recognizer | None = None
    tts: TextToSpeech | None = None
    try:
        chat, recognizer = build_models(APP_CONFIG.llm)
    except RuntimeError as error:
        logger.warning("cascade fallback without chat and stt: %s", error)
    try:
        tts = build_tts(APP_CONFIG.speech)
    except RuntimeError as error:
        logger.warning("cascade fallback without tts: %s", error)
    return chat, recognizer, tts


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


def create_app(
    tts_factory: Callable[[], TextToSpeech | None] | None = None,
    models_factory: Callable[[], tuple[ChatModel | None, Recognizer | None]] | None = None,
    live_factory: Callable[[], "LiveConnector | None"] | None = None,
    database_factory: Callable[[], DialogDatabase | None] | None = None,
    memory_settings: MemorySettings | None = None,
    memory_model_factory: Callable[[], ExtractionModel | None] | None = None,
    fallback_factory: Callable[[], FallbackParts] | None = None,
) -> FastAPI:
    """Собирает FastAPI-приложение. Фабрики подменяют тесты; по умолчанию озвучка и модели берутся из конфига.

    `DIALOG_DB_PATH` (или `database_factory` в тестах) подключает диск к хранилищу диалогов; не открылся — диалоги остаются
    в памяти, агент не падает, но пишет об этом в журнал (ошибка) и показывает `dialogs: memory` в `/health/ready`.

    `VOICE_PIPELINE=gemini_live` (или `live_factory` в тестах) включает речь в речь через Gemini Live: чат и
    распознавание не создаются, фиксированные фразы озвучивает тот же голос Gemini.

    Память агента (`MEMORY_*`, или `memory_settings`/`memory_model_factory` в тестах) живёт в том же файле, что диалоги: без диска
    она выключена. Воркер памяти запускается после подключения диска и останавливается до его закрытия. При
    `MEMORY_BACKEND=cognee` память — датасеты Cognee (`app/memory/cognee_backend.py`): диск и воркер не подключаются,
    диалоги живут только в памяти процесса.

    Бюджет токенов Gemini (`GEMINI_TPM_LIMIT`, app/services/gemini_budget.py) создаётся в режиме gemini_live всегда (при лимите
    0 он выключен). При `GEMINI_TPM_ENFORCE` собирается и каскад как запасной путь (`fallback_factory` в тестах): на него
    уходят новые разговоры, когда бюджет исчерпан, а его распознавание и озвучка разбирают ход, отданный шаблону.
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
    memory_cfg = memory_settings or APP_CONFIG.memory
    make_memory_model = memory_model_factory or (
        lambda: build_memory_llm(memory_cfg, APP_CONFIG.llm) if memory_cfg.mode != "off" else None
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        store: DialogStore = app.state.store
        cognee_mode = memory_cfg.backend == "cognee"
        # Диалоги на диске (DIALOG_DB_PATH) и бэкенд памяти независимы: cognee — это про память человека, а не про
        # хранение диалогов. Без диска диалоги живут в памяти процесса и пропадают при перезапуске (локальный стенд).
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
        cognee_client: CogneeClient | None = None
        memory_worker: MemoryWorker | None = None
        if cognee_mode:
            memory_model = None  # извлекает сам Cognee, модель и воркер не нужны
            cognee_client = build_cognee_client(memory_cfg)
            if cognee_client is not None:
                try:
                    await cognee_client.connect()
                except Exception:  # noqa: BLE001 - память недоступна до первого удачного перелогина, агент работает
                    logger.exception("cognee login failed at startup")
            memory_service: MemoryBackend = CogneeMemoryBackend(cognee_client, memory_cfg)
        else:
            memory_model = make_memory_model()
            sqlite_memory = MemoryService(store, memory_cfg, memory_model)
            memory_worker = MemoryWorker(sqlite_memory, store, memory_cfg)
            await memory_worker.start()
            memory_service = sqlite_memory
        store.memory = memory_service
        app.state.memory = memory_service
        if memory_service.status() == "unavailable":
            if cognee_mode:
                logger.error("memory backend=cognee is NOT available: no COGNEE_BASE_URL/COGNEE_SERVICE_EMAIL/COGNEE_SERVICE_PASSWORD")
            else:
                logger.error(
                    "memory mode=%s is NOT available: %s",
                    memory_cfg.mode,
                    "no extraction model" if store.persistent else "no disk",
                )
        live = live_factory() if live_factory is not None else None
        app.state.live = live
        budget = TokenBudget(APP_CONFIG.gemini) if live is not None else None
        app.state.budget = budget
        tracer = build_tracer(APP_CONFIG.langfuse)
        app.state.tracer = tracer
        if tts_factory is not None or live is None:
            app.state.tts = factory()
        else:
            from app.clients.gemini_live import GeminiLiveTts

            voice_tts = GeminiLiveTts(live, budget=budget)
            items = APP_CONFIG.speech.tts_cache_items
            app.state.tts = CachedTts(voice_tts, items) if items else voice_tts
        fallback = None
        if budget is not None and budget.enforcing:
            parts = (fallback_factory or _build_fallback)()
            fallback = CascadeFallback(*parts) if any(part is not None for part in parts) else None
        app.state.fallback = fallback
        if budget is not None and budget.enabled:
            logger.info(
                "gemini budget: limit=%d enforce=%s fallback: llm=%s stt=%s tts=%s",
                APP_CONFIG.gemini.tpm_limit,
                budget.enforcing,
                fallback.chat.name if fallback and fallback.chat else "none",
                fallback.recognizer.name if fallback and fallback.recognizer else "none",
                fallback.tts.name if fallback and fallback.tts else "none",
            )
        if live is not None and models_factory is None:
            app.state.chat, app.state.recognizer = None, None  # речь в речь: чат и распознавание не нужны
        else:
            app.state.chat, app.state.recognizer = models()
        logger.info(
            "agent started: pipeline=%s tts=%s llm=%s stt=%s dialogs=%s memory=%s tracing=%s",
            live.name if live else "cascade",
            app.state.tts.name if app.state.tts else "none",
            app.state.chat.name if app.state.chat else "none",
            app.state.recognizer.name if app.state.recognizer else "none",
            "sqlite" if store.persistent else "memory",
            memory_service.status(),
            tracer.name,
        )
        # Приветствие должно зазвучать за 0,9 с, иначе клиент прочтёт его сам, а облачный синтез медленнее.
        # Фиксированные фразы (приветствия, шаблоны, кризисный ответ) готовим заранее; ответы модели так не подготовить.
        # В режиме gemini_live прогреваются и шаблонные ответы: ими отвечает ход, отданный шаблону (бюджет Gemini исчерпан,
        # Gemini промолчал или отказал), и звучать они должны из памяти тем же голосом, без новой сессии Gemini на фразу.
        warm_up = None
        if isinstance(app.state.tts, CachedTts):
            sentences = [part for phrase in SPOKEN_PHRASES for part in split_sentences(phrase)]
            warm_up = asyncio.create_task(app.state.tts.warm_up(sentences))
        langfuse = start_langfuse_sink(APP_CONFIG.langfuse)
        fallback_warm_up = None
        if fallback is not None and isinstance(fallback.tts, CachedTts):
            sentences = [part for phrase in SPOKEN_PHRASES for part in split_sentences(phrase)]
            fallback_warm_up = asyncio.create_task(fallback.tts.warm_up(sentences))
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
            if memory_worker is not None:
                await memory_worker.stop()  # идущее извлечение дожидается до 10 с, остальное останется в очереди на диске
            if cognee_client is not None:
                await memory_service.drain()  # дождаться идущих записей и prefetch'ей Cognee
                await cognee_client.aclose()
            await store.detach()  # дописать на диск всё несохранённое, пока сокеты ещё закрываются
            store.memory = None
            for client in (app.state.tts, app.state.chat, app.state.recognizer, live, memory_model):
                if client is not None:
                    await client.aclose()
            if fallback_warm_up is not None:
                fallback_warm_up.cancel()
            for part in (fallback.chat, fallback.recognizer, fallback.tts) if fallback is not None else ():
                if part is not None:
                    await part.aclose()
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
    app.state.tts = None
    app.state.chat = None
    app.state.recognizer = None
    app.state.live = None
    app.state.memory = None
    app.state.budget = None  # бюджет токенов Gemini (только в режиме gemini_live)
    app.state.fallback = None  # каскад как запасной путь gemini_live (GEMINI_TPM_ENFORCE)
    app.state.tracer = None  # подменяется в lifespan (build_tracer); None до старта приложения
    app.state.tts_mode = "auto"  # dev-переключатель озвучки, см. app/api/dev.py
    install_error_handlers(app)
    app.include_router(health.router)
    app.include_router(dialogs.router)
    app.include_router(memory.router)
    app.include_router(dialog_ws.router)
    app.include_router(dev.router)
    return app


app = create_app()
