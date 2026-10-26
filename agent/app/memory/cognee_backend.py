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
import uuid
from collections.abc import Callable, Coroutine
from datetime import UTC, datetime
from typing import Any

from app.clients.cognee import CogneeClient
from app.core.config import MemorySettings
from app.memory.models import iso
from app.memory.errors import MemoryDisabled, MemoryNotAllowed, MemoryUnavailable, MemoryValidation
from app.services.dialog_db import DialogDatabase
from app.services.dialog_store import Dialog

logger = logging.getLogger("agent.memory")

# Запрос сводки для разговора: всё, что Cognee знает о человеке, одним текстом.
BRIEF_QUERY = "Все факты об этом человеке: имя, как обращаться, город, работа, семья, интересы, что помогает"
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


def _unsupported() -> MemoryValidation:
    error = MemoryValidation("Бэкенд Cognee не поддерживает правку отдельных фактов")
    error.reason = "unsupported_in_cognee"
    return error


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
        self._datasets: dict[str, bool] = {}  # user_id → память включена (датасет существует)
        self._opted_out: set[str] = set()  # явно отказались: default_enabled их не включает обратно
        self._briefs: dict[str, str] = {}  # user_id → сводка из последнего recall
        self._turn_recalls: dict[str, str] = {}  # user_id → находка recall по последней реплике человека
        self._turn_tasks: dict[str, asyncio.Task[str]] = {}  # user_id → идущий фоновый recall по последней реплике
        self._consents: dict[str, tuple[str | None, str | None]] = {}  # user_id → (версия согласия, когда)
        self._loading: set[str] = set()
        self._prefetching: set[str] = set()
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
        self._briefs.pop(user_id, None)
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
                if enabled:
                    await self._prefetch(user_id)
                else:
                    self._opted_out.add(user_id)
                return
            exists = await self._client.dataset_exists(dataset_name(user_id))
            # default_enabled: без датасета человек всё равно «включён», если сам не отказывался
            self._datasets[user_id] = exists or self._default_on(user_id)
            if exists:
                await self._prefetch(user_id)
        except Exception:  # noqa: BLE001 - память не должна мешать разговору (I3)
            logger.exception("cognee memory state load failed user=%s", user_id)
        finally:
            self._loading.discard(user_id)

    async def _prefetch(self, user_id: str) -> None:
        """Перечитать сводку человека из Cognee в кэш процесса. recall идёт 15–30 с — только в фоне."""
        if self._client is None or user_id in self._prefetching:
            return
        self._prefetching.add(user_id)
        try:
            self._briefs[user_id] = await self._client.recall(BRIEF_QUERY, dataset_name(user_id))
        except Exception:  # noqa: BLE001 - сбой prefetch — пустая сводка, а не ошибка разговора
            logger.exception("cognee brief prefetch failed user=%s", user_id)
        finally:
            self._prefetching.discard(user_id)

    # ─── MemoryLink: то, что зовут хранилище и сессии разговора ───────────────

    def brief(self, dialog: Dialog, count: bool = True) -> str:
        """Сводка для разговора из кэша процесса: синхронно, без сети (I3). Нет кэша — пусто и фоновый prefetch."""
        if dialog.memory_mode != "on":
            return ""
        user_id = dialog.user_id
        if not self._effective_enabled(user_id):
            return ""
        if user_id not in self._datasets:
            self._ensure_state(user_id)
        if user_id not in self._briefs:
            self._spawn(self._prefetch(user_id))
        base = self._briefs.get(user_id, "")
        found = self._turn_recalls.get(user_id, "")
        if found and found not in base:
            return (base + "\n\nПо недавнему вопросу человека в памяти нашлось: " + found).strip()
        return base

    def user_message(self, dialog: Dialog, text: str) -> None:
        """Реплика человека: фоновый recall по её тексту — к следующему ходу сводка уже с находкой по теме."""
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
        """Диалог завершён: транскрипт в датасет человека (в фоне), затем свежий prefetch сводки."""
        if self._client is None or dialog.memory_mode != "on" or not self._effective_enabled(dialog.user_id):
            return
        if sum(1 for message in dialog.messages if message.role == "user") < MIN_USER_MESSAGES:
            return
        self._spawn(self._ingest(dialog))

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
        self._briefs.pop(dialog.user_id, None)
        self._spawn(self._settled_prefetch(dialog.user_id))

    async def _settled_prefetch(self, user_id: str) -> None:
        """Перечитать сводку после паузы: cognify в Cognee асинхронный, сразу после записи граф ещё пустой."""
        await asyncio.sleep(self._cfg.cognify_settle_seconds)
        await self._prefetch(user_id)

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
        return {
            "available": self.available,
            "mode": "on",
            "enabled": enabled,
            "consentVersion": version,
            "consentAt": at,
            "rulesVersion": "cognee",
            "limits": {"maxFacts": None},
            "facts": [],
            "cogneeBrief": self._briefs.get(user_id, ""),
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
            "facts": [],
            "events": [],
            "cogneeBrief": self._briefs.get(user_id, ""),
        }

    async def changes(self, user_id: str, dialog_id: str) -> dict[str, Any]:
        """Карточка «Я запомнил»: Cognee не различает факты по диалогам — всегда пустая, но готовая."""
        return {"status": "ready", "reason": None, "items": []}

    # ─── изменения по просьбе человека ────────────────────────────────────────

    async def update_settings(self, user_id: str, enabled: bool, consent_version: str | None) -> dict[str, Any]:
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
            self._briefs.pop(user_id, None)
            self._spawn(self._prefetch(user_id))
            logger.info("cognee memory enabled user=%s", user_id)
            return {"enabled": True, "consentVersion": consent_version, "consentAt": at}
        version, at = await self._consent_of(user_id)  # пауза не отзывает согласие: оно остаётся в строке настроек
        await self._write_settings(user_id, False, version, at)
        self._briefs.pop(user_id, None)
        self._datasets[user_id] = False
        self._opted_out.add(user_id)
        logger.info("cognee memory disabled (данные сохранены) user=%s", user_id)
        return {"enabled": False, "consentVersion": None, "consentAt": None}

    async def add_fact(self, user_id: str, category: str, text: Any, slots: Any) -> dict[str, Any]:
        """Факт, который человек написал сам: документом в его датасет. Ответ — в форме факта API (201)."""
        client = self._require_client()
        if not self._effective_enabled(user_id):
            raise MemoryDisabled()
        rendered = text if isinstance(text, str) and text else ", ".join(f"{key}: {value}" for key, value in (slots or {}).items())
        if not rendered:
            raise MemoryValidation("нужен текст")
        await client.remember(f"Факт о человеке ({category}): {rendered}", dataset_name(user_id))
        self._briefs.pop(user_id, None)
        self._spawn(self._prefetch(user_id))
        now = iso(datetime.now(UTC))
        return {
            "id": str(uuid.uuid4()),
            "category": category,
            "text": rendered,
            "slots": slots,
            "importance": 5,
            "confidence": 1.0,
            "status": "pinned",
            "origin": "user_edit",
            "sensitivity": "normal",
            "sources": [],
            "createdAt": now,
            "updatedAt": now,
            "lastConfirmedAt": None,
            "expiresAt": None,
            "confirmCount": 0,
            "seenByUser": True,
        }

    async def patch_fact(
        self,
        user_id: str,
        fact_id: str,
        text: Any = None,
        slots: Any = None,
        status: str | None = None,
        confirm: bool = False,
    ) -> dict[str, Any]:
        raise _unsupported()

    async def delete_fact(self, user_id: str, fact_id: str) -> None:
        raise _unsupported()

    async def forget_all(self, user_id: str, actor: str = "user") -> None:
        """«Забыть всё»: данные человека в Cognee удаляются, а настройки не меняются — память остаётся включённой (или на паузе) и
        согласие остаётся. Если память включена, датасет тут же создаётся заново с зерном согласия: так выглядит «включено, но пусто»."""
        client = self._require_client()
        version, at = await self._consent_of(user_id)
        await client.forget_dataset(dataset_name(user_id))
        self._briefs.pop(user_id, None)
        self._turn_recalls.pop(user_id, None)
        self._turn_tasks.pop(user_id, None)
        if self._effective_enabled(user_id) and version:
            await client.remember(f"CONSENT memory v{version} {at or iso(datetime.now(UTC))}", dataset_name(user_id))
        logger.info("cognee memory forgotten user=%s", user_id)
