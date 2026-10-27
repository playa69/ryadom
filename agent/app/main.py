"""Точка входа сервиса agent «Слышу Рядом».

Упрощённый агент: контракт agent-api целиком (REST + WebSocket, текст и голос), ответы чат-модели
и распознавание речи через прокси программы, озвучка Qwen TTS / SaluteSpeech / espeak-ng, диалоги в памяти с копией
в PostgreSQL (DIALOG_DATABASE_URL): они переживают перезапуск и выкат пода.
Нужен, чтобы проверить API, голос и интеграцию с приложением до появления настоящей логики
(openspec/changes/add-agent-service).
"""

import asyncio
import logging
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager

from typing import TYPE_CHECKING, Any

from fastapi import FastAPI

from app.api import dev, dialog_ws, dialogs, digests, health, memory
from app.clients.cognee import CogneeClient, build_cognee_client
from app.clients.llm import ChatModel, Recognizer, build_models
from app.clients.speech import CachedTts, TextToSpeech, build_tts
from app.core.config import APP_CONFIG, MemorySettings
from app.core.errors import install_error_handlers
from app.core.reclaim import MemoryReclaimer
from app.core.metrics import DIALOG_DB_ERRORS_TOTAL
from app.memory.backend import MemoryBackend
from app.clients.llm import ProxyChat
from app.memory.cognee_backend import CogneeMemoryBackend
from app.memory.extractor import NotesExtractor
from app.core.tracing import build_tracer
from app.services.dialog_db import DialogDatabase
from app.services.dialog_store import GREETINGS, DialogStore
from app.services.langfuse_usage import start_langfuse_sink
from app.services.gemini_budget import CascadeFallback, TokenBudget
from app.services.replies import CRISIS_REPLY, REPEAT_REQUEST, split_sentences

if TYPE_CHECKING:
    from app.clients.gemini_live import LiveConnector

logger = logging.getLogger("agent")

# Готовые фразы агента: приветствия, кризисный ответ (он важнее) и просьба повторить. Заглушки режима без моделей не
# прогреваются: в бою они не звучат, а прогрев в gemini_live тратит квоту Gemini на старте.
SPOKEN_PHRASES = (*GREETINGS, CRISIS_REPLY, REPEAT_REQUEST)
# Сколько сессий Gemini прогрев держит открытыми одновременно (фраза — сессия): 16 открытий разом на старте Google встречал
# отказами, и после них половина фраз оставалась не прогретой.
WARM_UP_GEMINI_SESSIONS = 3

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


def _build_notes_model(memory_cfg: MemorySettings) -> ProxyChat | None:
    """Модель извлечения заметок: чат-модель прокси программы (`MEMORY_NOTES_MODEL`, по умолчанию та же, что в разговоре).
    Нет флага `MEMORY_NOTES_ENABLED`, режим шаблонов или нет ключа — извлечения нет, разговор идёт как раньше."""
    llm = APP_CONFIG.llm
    if not memory_cfg.notes_enabled or llm.mode != "proxy" or llm.api_key is None or not llm.base_url:
        return None
    return ProxyChat(
        llm.base_url,
        llm.api_key.get_secret_value(),
        memory_cfg.notes_model or llm.chat_model,
        max_tokens=600,
        temperature=0.0,
        timeout_seconds=max(llm.timeout_seconds, 30),
    )


def create_app(
    tts_factory: Callable[[], TextToSpeech | None] | None = None,
    models_factory: Callable[[], tuple[ChatModel | None, Recognizer | None]] | None = None,
    live_factory: Callable[[], "LiveConnector | None"] | None = None,
    database_factory: Callable[[], DialogDatabase | None] | None = None,
    memory_settings: MemorySettings | None = None,
    fallback_factory: Callable[[], FallbackParts] | None = None,
) -> FastAPI:
    """Собирает FastAPI-приложение. Фабрики подменяют тесты; по умолчанию озвучка и модели берутся из конфига.

    Хранилище диалогов (`DIALOG_DATABASE_URL` → PostgreSQL; в тестах — `database_factory`): не открылось —
    диалоги остаются в памяти, агент не падает, но пишет об этом в журнал (ошибка) и показывает `dialogs: memory`
    в `/health/ready`.

    `VOICE_PIPELINE=gemini_live` (или `live_factory` в тестах) включает речь в речь через Gemini Live: чат и
    распознавание не создаются, фиксированные фразы озвучивает тот же голос Gemini.

    Память агента (`MEMORY_*`, или `memory_settings` в тестах) — датасеты Cognee (`app/memory/cognee_backend.py`):
    транскрипт после разговора, сводка в разговор, согласие человека. Хранилище диалогов память не определяет.

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
        live = live_factory() if live_factory is not None else None
        app.state.live = live
        budget = TokenBudget(APP_CONFIG.gemini) if live is not None else None
        app.state.budget = budget
        tracer = build_tracer(APP_CONFIG.langfuse)
        app.state.tracer = tracer
        warm_up_parallel = 1  # по одной фразе за раз; озвучка через Gemini — см. WARM_UP_GEMINI_SESSIONS
        if tts_factory is not None or live is None:
            app.state.tts = factory()
        else:
            from app.clients.gemini_live import GeminiLiveTts

            voice_tts = GeminiLiveTts(live, budget=budget)
            items = APP_CONFIG.speech.tts_cache_items
            app.state.tts = CachedTts(voice_tts, items) if items else voice_tts
            warm_up_parallel = WARM_UP_GEMINI_SESSIONS
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
        # Итоги разговоров пишет текстовая модель: в речи в речь её нет у сессии, но есть у запасного каскада.
        recap_owned: Any = None  # собственная модель итогов (закрывается при остановке), если у сессии текстовой нет
        store.recap_chat = app.state.chat or (fallback.chat if fallback is not None else None)
        if store.recap_chat is None and live is not None:
            try:
                recap_owned, extra_stt = models()
                store.recap_chat = recap_owned
                if extra_stt is not None:
                    await extra_stt.aclose()
            except RuntimeError:
                logger.warning("recaps: no text model is configured, automatic recaps are off in this mode")
        store.recap_template = APP_CONFIG.llm.mode == "template"
        store.recap_timeout_seconds = APP_CONFIG.dialog.recap_timeout_seconds
        store.retention_days = APP_CONFIG.dialog.retention_days
        store.retention_dry_run = APP_CONFIG.dialog.retention_dry_run
        logger.info(
            "agent started: pipeline=%s tts=%s llm=%s stt=%s dialogs=%s memory=%s tracing=%s",
            live.name if live else "cascade",
            app.state.tts.name if app.state.tts else "none",
            app.state.chat.name if app.state.chat else "none",
            app.state.recognizer.name if app.state.recognizer else "none",
            store.persistence,
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
            warm_up = asyncio.create_task(app.state.tts.warm_up(sentences, parallel=warm_up_parallel))
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
            for client in (app.state.tts, app.state.chat, app.state.recognizer, live, recap_owned):
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
    app.include_router(digests.router)
    app.include_router(dialog_ws.router)
    app.include_router(dev.router)
    return app


app = create_app()
