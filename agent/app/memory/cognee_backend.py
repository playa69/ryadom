"""Бэкенд памяти на Cognee: согласие и данные человека — его датасет в Cognee.

Включённая память ⟺ существует датасет `ryadom_user_<user_id>` (не-алфанум в UUID заменяется на `_`). Включение —
документ-зерно `CONSENT memory v<версия> <ISO-дата>`; выключение, «забыть всё» и стирание — удаление датасета целиком.
Диалоги в этом режиме живут только в памяти процесса (диск не подключается).

recall занимает 15–30 секунд, поэтому сводка (`brief`) отдаётся синхронно из кэша процесса, а читается из Cognee в фоне
(prefetch): после включения, после каждого разговора и при первом обращении к человеку. Изменение памяти сбрасывает
кэш: следующий ход идёт без сводки, пока фоновый recall не соберёт новую.

Чего здесь нет никогда: текстов фактов и реплик в журнале (I4). Правка и удаление отдельного
факта не поддержаны (у Cognee нет такой операции) — REST отвечает 422 с reason `unsupported_in_cognee`.
"""

import asyncio
import logging
import re
import time
from collections.abc import Callable, Coroutine
from datetime import UTC, datetime
from typing import Any

from app.clients.cognee import CogneeClient
from app.core.config import MemorySettings
from app.memory.models import iso
from app.memory.errors import (
    MemoryActionUnsupported,
    MemoryDisabled,
    MemoryNotAllowed,
    MemoryUnavailable,
    MemoryValidation,
)
from app.memory.extractor import NotesExtractor, Outcome
from app.memory.notes import NotesService, build_notes_block, kind_of_category, note_as_fact
from app.services.dialog_db import DialogDatabase
from app.services.dialog_store import Dialog

logger = logging.getLogger("agent.memory")

# Меньше реплик человека — разговор в память не идёт.
MIN_USER_MESSAGES = 4
# Фоновая находка по реплике (CHUNKS) режется: это контекст следующего хода, а не весь транскрипт.
TURN_RECALL_MAX_CHARS = 800
# Находка инструмента recall_memory в tool-сообщении: модели хватает пары чанков, длинное только раздувает контекст.
TOOL_RECALL_MAX_CHARS = 2000
_CONSENT_RE = re.compile(r"CONSENT memory v(\S+) (\S+)")


def dataset_name(user_id: str) -> str:
    """Имя датасета человека в Cognee."""
    return "ryadom_user_" + re.sub(r"[^A-Za-z0-9]", "_", user_id)


EXTRACT_EVERY_MESSAGES = 2
EXTRACT_EVERY_SECONDS = 20


class _Pending:
    """Реплики человека одного разговора, ещё не отданные извлекателю."""

    def __init__(self, user_id: str) -> None:
        self.user_id = user_id
        self.texts: list[str] = []
        self.last_run = time.monotonic()  # отсчёт «раз в 20 секунд» идёт от первой реплики, а не от начала времён


class CogneeMemoryBackend:
    """Память людей на Cognee. Реализует `MemoryBackend`: сводка из кэша, запись и согласие — через `CogneeClient`."""

    def __init__(
        self,
        client: CogneeClient | None,
        config: MemorySettings,
        database: Callable[[], DialogDatabase | None] | None = None,
    ) -> None:
        self._client = client
        self._cfg = config
        # База диалогов (PostgreSQL), если подключена: в ней живут настройки памяти («включена или пауза», согласие).
        # Без неё (разработка) настройки хранятся только в памяти процесса.
        self._database = database or (lambda: None)
        self.notes = NotesService(self._database, config.notes_max, self._notes_changed)
        self._notes_cache: dict[str, list[dict[str, Any]]] = {}  # user_id → заметки для блока памяти (без обращений к базе на ходу)
        self._chat_search_cache: dict[str, bool] = {}
        # Извлечение заметок по ходу разговора: не чаще одного прохода на EXTRACT_EVERY_MESSAGES реплик или раз в EXTRACT_EVERY_SECONDS.
        self._extractor: NotesExtractor | None = None
        self._pending: dict[str, _Pending] = {}  # dialog_id → реплики человека, ещё не отданные извлекателю
        self._extracting: set[str] = set()
        self._datasets: dict[str, bool] = {}  # user_id → память включена (датасет существует)
        self._opted_out: set[str] = set()  # явно отказались: default_enabled их не включает обратно
        self._turn_recalls: dict[str, str] = {}  # user_id → находка recall по последней реплике человека
        self._turn_tasks: dict[str, asyncio.Task[str]] = {}  # user_id → идущий фоновый recall по последней реплике
        self._consents: dict[str, tuple[str | None, str | None]] = {}  # user_id → (версия согласия, когда)
        self._loading: set[str] = set()
        self._tasks: set[asyncio.Task[Any]] = set()

    # ─── состояние ────────────────────────────────────────────────────────────

    def status(self) -> str:
        """Для /health/ready: on, если клиент настроен, иначе unavailable."""
        return "on" if self._client is not None else "unavailable"

    @property
    def available(self) -> bool:
        return self._client is not None

    def _spawn(self, coro: Coroutine[Any, Any, Any]) -> asyncio.Task[Any] | None:
        try:
            task = asyncio.get_running_loop().create_task(coro)
        except RuntimeError:  # нет цикла событий (синхронный вызов в тестах): нечего планировать
            coro.close()
            return None
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task

    async def drain(self) -> None:
        """Дождаться фоновых загрузок, записей и prefetch'ей (тесты, остановка)."""
        while True:
            # done-задачи вычищаем сами: discard-коллбэк может ещё стоять в очереди цикла,
            # а gather над завершённой задачей резолвится синхронно — без чистки цикл не выйдет
            self._tasks = {task for task in self._tasks if not task.done()}
            if not self._tasks:
                return
            await asyncio.gather(*self._tasks, return_exceptions=True)

    def _require_client(self) -> CogneeClient:
        if self._client is None:
            raise MemoryUnavailable()
        return self._client

    def _drop(self, user_id: str) -> None:
        self._datasets.pop(user_id, None)
        self._consents.pop(user_id, None)
        self._turn_recalls.pop(user_id, None)
        self._turn_tasks.pop(user_id, None)

    async def _read_settings(self, user_id: str) -> tuple[bool, str | None, str | None] | None:
        """Сохранённые настройки памяти человека; None — база не подключена, не ответила или строки нет."""
        db = self._database()
        if db is None:
            return None
        try:
            return await asyncio.to_thread(db.get_memory_settings, user_id)
        except Exception:  # noqa: BLE001 - не прочиталось: живём по датасету, как до появления таблицы
            logger.exception("memory settings read failed user=%s", user_id)
            return None

    async def _write_settings(self, user_id: str, enabled: bool, version: str | None, at: str | None) -> None:
        """Записать настройки памяти. Не записалось — `MemoryUnavailable`: человеку нельзя сказать «выключено», когда после
        перезапуска память включится обратно."""
        db = self._database()
        if db is None:
            return
        try:
            await asyncio.to_thread(db.put_memory_settings, user_id, enabled, version, at, iso(datetime.now(UTC)))
        except Exception as error:  # noqa: BLE001
            logger.exception("memory settings write failed user=%s", user_id)
            raise MemoryUnavailable() from error

    def _default_on(self, user_id: str) -> bool:
        """MEMORY_DEFAULT_ENABLED (стенды): память всем по умолчанию, пока человек явно не отказался."""
        return self._cfg.default_enabled and user_id not in self._opted_out

    def _effective_enabled(self, user_id: str) -> bool:
        """Включена ли память: явное состояние кэша, иначе дефолт режима (opt-in или opt-out)."""
        return self._datasets.get(user_id, self._default_on(user_id))

    # ─── фон: состояние человека и сводка ─────────────────────────────────────

    def _ensure_state(self, user_id: str) -> None:
        """Первое обращение к человеку: узнать в фоне, включена ли его память, и подтянуть сводку."""
        if self._client is None or user_id in self._datasets or user_id in self._loading:
            return
        self._loading.add(user_id)
        self._spawn(self._load_state(user_id))

    def _notes_changed(self, user_id: str) -> None:
        """Заметки человека изменились: кэш блока памяти перечитывается в фоне, следующая ротация сессии возьмёт новый блок."""
        self._notes_cache.pop(user_id, None)
        self._spawn(self._refresh_notes(user_id))

    async def _refresh_notes(self, user_id: str) -> None:
        try:
            self._notes_cache[user_id] = await self.notes.list(user_id)
            self._chat_search_cache[user_id] = (await self.notes.flags(user_id))[1]
        except Exception:  # noqa: BLE001 - без базы блок памяти пуст, разговор идёт
            logger.exception("memory notes cache refresh failed user=%s", user_id)

    async def _load_state(self, user_id: str) -> None:
        assert self._client is not None
        try:
            saved = await self._read_settings(user_id)
            if saved is not None:
                # Решение человека хранится в базе и сильнее датасета: пауза остаётся паузой после перезапуска.
                enabled, version, at = saved
                self._datasets[user_id] = enabled
                if version:
                    self._consents[user_id] = (version, at)
                if not enabled:
                    self._opted_out.add(user_id)
                await self._refresh_notes(user_id)
                return
            exists = await self._client.dataset_exists(dataset_name(user_id))
            # default_enabled: без датасета человек всё равно «включён», если сам не отказывался
            self._datasets[user_id] = exists or self._default_on(user_id)
            await self._refresh_notes(user_id)
        except Exception:  # noqa: BLE001 - память не должна мешать разговору (I3)
            logger.exception("cognee memory state load failed user=%s", user_id)
        finally:
            self._loading.discard(user_id)

    # ─── MemoryLink: то, что зовут хранилище и сессии разговора ───────────────

    def brief(self, dialog: Dialog, count: bool = True) -> str:
        """Блок памяти для разговора из кэша процесса: синхронно, без сети (I3). Заметки человека и, если включён поиск, находка
        из прошлых разговоров. Пересказ графа Cognee в разговор больше не подаётся (`design.md` D5)."""
        if dialog.memory_mode != "on":
            return ""
        user_id = dialog.user_id
        if not self._effective_enabled(user_id):
            return ""
        if user_id not in self._datasets:
            self._ensure_state(user_id)
        if user_id not in self._notes_cache:
            self._spawn(self._refresh_notes(user_id))
        parts: list[str] = []
        block = build_notes_block(self._notes_cache.get(user_id, []), self._cfg.brief_max_tokens)
        if block:
            parts.append(block)
        found = self._turn_recalls.get(user_id, "")
        if found and self._chat_search_cache.get(user_id, True):
            parts.append("Из прошлых разговоров (слова человека, дословно):\n" + found)
        return "\n\n".join(parts)

    def set_extractor(self, extractor: NotesExtractor | None) -> None:
        self._extractor = extractor

    def _notes_active(self, dialog: Dialog) -> bool:
        return (
            self._cfg.notes_enabled
            and self._extractor is not None
            and dialog.memory_mode == "on"
            and self._effective_enabled(dialog.user_id)
        )

    def _queue_for_notes(self, dialog: Dialog, text: str) -> None:
        pending = self._pending.setdefault(dialog.id, _Pending(dialog.user_id))
        pending.texts.append(text)
        due = len(pending.texts) >= EXTRACT_EVERY_MESSAGES or time.monotonic() - pending.last_run >= EXTRACT_EVERY_SECONDS
        if due and dialog.id not in self._extracting:
            self._extracting.add(dialog.id)
            self._spawn(self._extract_pending(dialog))

    async def _extract_pending(self, dialog: Dialog) -> None:
        """Один проход: новые реплики → заметки. Сбой модели оставляет реплики в очереди до следующего прохода."""
        try:
            pending = self._pending.get(dialog.id)
            if pending is None or not pending.texts or self._extractor is None:
                return
            texts = list(pending.texts)
            context = [m.text for m in dialog.messages if m.role == "assistant"][-2:]
            started = time.monotonic()
            outcome = await self._extractor.extract(pending.user_id, texts, context, dialog.id)
            pending.last_run = time.monotonic()
            if outcome is not None and (outcome.changed or not outcome.failed):
                del pending.texts[: len(texts)]  # отданные реплики не возвращаем; при сбое модели остаются
            logger.info("memory extraction user=%s ms=%d changed=%s", pending.user_id, (time.monotonic() - started) * 1000, outcome.changed)
        except Exception:  # noqa: BLE001 - извлечение не должно мешать разговору (I3)
            logger.exception("memory extraction task failed dialog=%s", dialog.id)
        finally:
            self._extracting.discard(dialog.id)

    async def instruct(self, user_id: str, request: str) -> Outcome:
        """«Скажи, что поправить или убрать»: просьба человека выполняется тем же извлекателем."""
        if self._extractor is None:
            raise MemoryUnavailable()
        if not self._effective_enabled(user_id):
            raise MemoryDisabled()
        return await self._extractor.instruct(user_id, request)

    def user_message(self, dialog: Dialog, text: str) -> None:
        """Реплика человека: фоновый recall по её тексту — к следующему ходу сводка уже с находкой по теме."""
        if self._notes_active(dialog) and text.strip():
            self._queue_for_notes(dialog, text)
        if self._client is None or not text.strip() or not self._effective_enabled(dialog.user_id):
            return
        task = self._spawn(self._recall_turn(dialog.user_id, text))
        if task is not None:
            self._turn_tasks[dialog.user_id] = task  # инструмент модели дождётся этого же поиска, а не пойдёт вторым

    async def _recall_turn(self, user_id: str, text: str) -> str:
        assert self._client is not None
        try:
            # CHUNKS, а не GRAPH_COMPLETION: фоновый поиск на каждую реплику, синтез LLM тут не нужен и втрое медленнее
            found = await self._client.recall_chunks(text, dataset_name(user_id))
        except Exception:  # noqa: BLE001 - сбой поиска — просто старая сводка, разговор не трогаем
            logger.exception("cognee turn recall failed user=%s", user_id)
            return ""
        if found:
            self._turn_recalls[user_id] = found[:TURN_RECALL_MAX_CHARS]
        return found

    def recall_supported(self, dialog: Dialog) -> bool:
        """Инструмент recall_memory доступен, когда память человека включена и клиент настроен."""
        return self._client is not None and self._effective_enabled(dialog.user_id)

    async def recall_now(self, dialog: Dialog, query: str) -> str:
        """Прямой recall по запросу модели (инструмент recall_memory); находка также попадает в сводку следующих ходов.

        CHUNKS, а не GRAPH_COMPLETION: синтез из найденного сделает сама чат-модель вторым проходом,
        а Cognee без LLM-синтеза отвечает втрое быстрее — иначе в голосовой ход не влезаем.
        """
        if not self.recall_supported(dialog):
            return ""
        # Фоновый поиск по этой же реплике уже идёт (см. user_message) — дожидаемся его, а не делаем второй запрос.
        pending = self._turn_tasks.get(dialog.user_id)
        if pending is not None and not pending.done():
            found = await pending
        else:
            try:
                found = await self._require_client().recall_chunks(query, dataset_name(dialog.user_id))
            except Exception:  # noqa: BLE001 - сбой поиска — модель отвечает без находки, разговор не рвём
                logger.exception("cognee tool recall failed user=%s", dialog.user_id)
                return ""
        if found:
            self._turn_recalls[dialog.user_id] = found[:TURN_RECALL_MAX_CHARS]
        return found[:TOOL_RECALL_MAX_CHARS]

    def enabled(self, user_id: str) -> bool:
        """По кэшу процесса; неизвестный человек — фоновая проверка датасета. При MEMORY_DEFAULT_ENABLED — по умолчанию да."""
        self._ensure_state(user_id)
        return self._effective_enabled(user_id)

    async def user_loaded(self, user_id: str) -> None:
        self._ensure_state(user_id)

    def user_unloaded(self, user_id: str) -> None:
        self._drop(user_id)  # при загрузке (`user_loaded`) состояние и сводка соберутся заново

    def dialog_ended(self, dialog: Dialog) -> None:
        """Диалог завершён: финальный проход извлечения и транскрипт в датасет человека (в фоне)."""
        if self._notes_active(dialog) and self._pending.get(dialog.id) is not None:
            self._extracting.add(dialog.id)
            self._spawn(self._final_extract(dialog))
        self._pending.pop(dialog.id, None) if not self._notes_active(dialog) else None
        if self._client is None or dialog.memory_mode != "on" or not self._effective_enabled(dialog.user_id):
            return
        if sum(1 for message in dialog.messages if message.role == "user") < MIN_USER_MESSAGES:
            return
        self._spawn(self._ingest(dialog))

    async def _final_extract(self, dialog: Dialog) -> None:
        await self._extract_pending(dialog)
        self._pending.pop(dialog.id, None)

    async def _ingest(self, dialog: Dialog) -> None:
        assert self._client is not None
        lines = ["Транскрипт разговора человека с агентом поддержки:"]
        for message in dialog.messages:
            speaker = "Человек" if message.role == "user" else "Агент"
            lines.append(f"{speaker}: {message.text}")
        try:
            await self._client.remember("\n".join(lines), dataset_name(dialog.user_id))
        except Exception:  # noqa: BLE001 - запись памяти не должна ронять завершение разговора
            logger.exception("cognee memory ingest failed dialog=%s", dialog.id)
            return

    def user_erased(self, user_id: str) -> None:
        """Человек стёрт: датасет удаляется в фоне, кэши сбрасываются сразу."""
        self._drop(user_id)
        self._opted_out.add(user_id)  # стёртый человек не «воскресает» через default_enabled
        if self._client is not None:
            self._spawn(self._forget(user_id))

    async def _forget(self, user_id: str) -> None:
        assert self._client is not None
        try:
            await self._client.forget_dataset(dataset_name(user_id))
        except Exception:  # noqa: BLE001
            logger.exception("cognee memory forget failed user=%s", user_id)

    # ─── чтение ───────────────────────────────────────────────────────────────

    async def _consent_of(self, user_id: str) -> tuple[str | None, str | None]:
        """(версия согласия, когда) из кэша, иначе из документа-зерна в датасете."""
        cached = self._consents.get(user_id)
        if cached is not None or self._client is None:
            return cached or (None, None)
        try:
            seed = await self._client.read_consent(dataset_name(user_id))
        except Exception:  # noqa: BLE001
            logger.exception("cognee consent read failed user=%s", user_id)
            return (None, None)
        match = _CONSENT_RE.search(seed)
        consent = (match.group(1), match.group(2)) if match else (None, None)
        self._consents[user_id] = consent
        return consent

    async def get_memory(self, user_id: str) -> dict[str, Any]:
        if user_id not in self._datasets and self._client is not None:
            await self._load_state(user_id)
        enabled = self._effective_enabled(user_id)
        version, at = await self._consent_of(user_id) if enabled else (None, None)
        notes = await self.notes.list(user_id)
        sensitive, chat_search = await self.notes.flags(user_id)
        return {
            "available": self.available,
            "mode": "on",
            "enabled": enabled,
            "paused": not enabled,
            "sensitiveEnabled": sensitive,
            "chatSearchEnabled": chat_search,
            "consentVersion": version,
            "consentAt": at,
            "rulesVersion": "notes-1",
            "limits": {"maxFacts": self.notes.max_notes, "maxNotes": self.notes.max_notes},
            "notes": notes,
            "facts": [note_as_fact(note) for note in notes],
        }

    async def export(self, user_id: str) -> dict[str, Any]:
        """Всё о памяти человека: настройки из зерна согласия и текущая сводка (фактов-строк у Cognee нет)."""
        if user_id not in self._datasets and self._client is not None:
            await self._load_state(user_id)
        enabled = self._effective_enabled(user_id)
        version, at = await self._consent_of(user_id) if enabled else (None, None)
        return {
            "exportedAt": iso(datetime.now(UTC)),
            "rulesVersion": "cognee",
            "settings": {
                "enabled": enabled,
                "consentVersion": version,
                "consentAt": at,
                "epochAt": None,
                "updatedAt": None,
            },
            "notes": await self.notes.list(user_id),
            "facts": [],
            "events": [],
        }

    async def changes(self, user_id: str, dialog_id: str) -> dict[str, Any]:
        """Карточка «Я запомнил»: Cognee не различает факты по диалогам — всегда пустая, но готовая."""
        return {"status": "ready", "reason": None, "items": []}

    # ─── изменения по просьбе человека ────────────────────────────────────────

    async def update_settings(
        self,
        user_id: str,
        enabled: bool | None,
        consent_version: str | None,
        sensitive_enabled: bool | None = None,
        chat_search_enabled: bool | None = None,
    ) -> dict[str, Any]:
        """Настройки памяти: «Память» (с согласием) и переключатели «Запоминать чувствительное», «Опираться на прошлые
        разговоры». Любое поле можно не передавать. Выключение «чувствительного» удаляет такие заметки."""
        if sensitive_enabled is not None or chat_search_enabled is not None:
            await self.notes.set_flags(user_id, sensitive_enabled, chat_search_enabled)
        if enabled is None:
            current = await self.get_memory(user_id)
            return {
                "enabled": current["enabled"],
                "consentVersion": current["consentVersion"],
                "consentAt": current["consentAt"],
                "sensitiveEnabled": current["sensitiveEnabled"],
                "chatSearchEnabled": current["chatSearchEnabled"],
            }
        result = await self._update_enabled(user_id, enabled, consent_version)
        sensitive, chat_search = await self.notes.flags(user_id)
        return {**result, "sensitiveEnabled": sensitive, "chatSearchEnabled": chat_search}

    async def _update_enabled(self, user_id: str, enabled: bool, consent_version: str | None) -> dict[str, Any]:
        """Включение — документ-зерно согласия (создаёт датасет); выключение — только флаг, данные не трогаем.

        Выключенная память не делает вызовов в Cognee (все пути режутся `_effective_enabled`),
        но датасет человека остаётся нетронутым — физическое удаление делает отдельная джоба.
        """
        client = self._require_client()
        if enabled:
            if not consent_version:
                raise MemoryValidation("consentVersion обязателен при включении")
            allowed = self._cfg.allowed_users
            if allowed and user_id.lower() not in allowed:
                raise MemoryNotAllowed()
            at = iso(datetime.now(UTC))
            await client.remember(f"CONSENT memory v{consent_version} {at}", dataset_name(user_id))
            await self._write_settings(user_id, True, consent_version, at)
            self._datasets[user_id] = True
            self._opted_out.discard(user_id)
            self._consents[user_id] = (consent_version, at)
            logger.info("cognee memory enabled user=%s", user_id)
            return {"enabled": True, "consentVersion": consent_version, "consentAt": at}
        version, at = await self._consent_of(user_id)  # пауза не отзывает согласие: оно остаётся в строке настроек
        await self._write_settings(user_id, False, version, at)
        self._datasets[user_id] = False
        self._opted_out.add(user_id)
        logger.info("cognee memory disabled (данные сохранены) user=%s", user_id)
        return {"enabled": False, "consentVersion": None, "consentAt": None}

    async def add_fact(self, user_id: str, category: str, text: Any, slots: Any) -> dict[str, Any]:
        """Факт, который человек написал сам: документом в его датасет. Ответ — в форме факта API (201)."""
        if not self._effective_enabled(user_id):
            raise MemoryDisabled()
        rendered = text if isinstance(text, str) and text else ", ".join(f"{key}: {value}" for key, value in (slots or {}).items())
        if not rendered:
            raise MemoryValidation("нужен текст")
        note = await self.notes.add(user_id, kind_of_category(category), rendered)
        return note_as_fact(note)

    async def patch_fact(
        self,
        user_id: str,
        fact_id: str,
        text: Any = None,
        slots: Any = None,
        status: str | None = None,
        confirm: bool = False,
    ) -> dict[str, Any]:
        """Прежний маршрут факта: правка текста заметки; закрепление и «Верно» больше не поддержаны (`design.md` D11)."""
        if status == "pinned" or confirm or (text is None and slots is None):
            raise MemoryActionUnsupported()
        if not isinstance(text, str) or not text:
            raise MemoryValidation("нужен текст")
        return note_as_fact(await self.notes.patch(user_id, fact_id, text))

    async def delete_fact(self, user_id: str, fact_id: str) -> None:
        """Прежний маршрут факта: удаляет заметку."""
        await self.notes.delete(user_id, fact_id)

    async def forget_all(self, user_id: str, actor: str = "user") -> None:
        """«Забыть всё»: данные человека в Cognee удаляются, а настройки не меняются — память остаётся включённой (или на паузе) и
        согласие остаётся. Если память включена, датасет тут же создаётся заново с зерном согласия: так выглядит «включено, но пусто»."""
        client = self._require_client()
        version, at = await self._consent_of(user_id)
        await self.notes.delete_all(user_id)
        await client.forget_dataset(dataset_name(user_id))
        self._turn_recalls.pop(user_id, None)
        self._turn_tasks.pop(user_id, None)
        if self._effective_enabled(user_id) and version:
            await client.remember(f"CONSENT memory v{version} {at or iso(datetime.now(UTC))}", dataset_name(user_id))
        logger.info("cognee memory forgotten user=%s", user_id)
