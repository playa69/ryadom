"""Память агента о человеке: заметки в PostgreSQL агента (слой 1) и поиск по прошлым разговорам в Cognee (слой 2).

Включена ли память и согласие — строка `memory_settings` в базе агента. Человек, у которого строки ещё нет (память он включал
при агенте 0.8.x: документ-зерно `CONSENT memory v<версия> <ISO-дата>` в датасете `ryadom_user_<user_id>`), при первой
загрузке получает строку по существованию датасета, дальше решение из датасета не выводится.

Все операции с Cognee, кроме стирания аккаунта, идут через очередь `memory_outbox` с повторами (`indexer.py`): удаление разговора
— документ (`delete_document`), «Удалить всю память» и выключение поиска — датасет (`delete_dataset`). Стирание аккаунта удаляет
датасет синхронно, до `204` (`erase_user_data`). Метки `memory_deletions`, которые копил агент 0.8.8, один раз переносятся в
очередь при открытии базы (`DialogDatabase.open`), при холодной загрузке на них больше не смотрим.

Блок памяти (`brief`) отдаётся синхронно из кэша процесса: заметки читаются из базы в фоне, а до первого ответа модели —
сразу (`prepare`). Чего здесь нет никогда: текстов заметок и реплик в журнале (I4).
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
    FactNotFound,
    FactRejected,
    MemoryUnavailable,
    MemoryValidation,
)
from app.memory.errors import NoteNotFound, NoteRejected
from app.memory.indexer import CogneeOutbox, dataset_name
from app.memory.extractor import NotesExtractor, Outcome
from app.memory.suppress import filter_found
from app.memory.notes import NotesService, build_notes_block, kind_of_category, note_as_fact
from app.services.dialog_db import DialogDatabase
from app.services.dialog_store import Dialog

logger = logging.getLogger("agent.memory")

# Фоновая находка по реплике (CHUNKS) режется: это контекст следующего хода, а не весь транскрипт.
TURN_RECALL_MAX_CHARS = 800
_CONSENT_RE = re.compile(r"CONSENT memory v(\S+) (\S+)")


INDEX_DELAY_SECONDS = 5  # разговор успевает записаться на диск, прежде чем из него соберётся документ
EXTRACT_EVERY_MESSAGES = 2
EXTRACT_EVERY_SECONDS = 20


def _dialog_chunks(text: str) -> str:
    """Убирает служебные документы согласия из находок: они лежат в датасетах, заведённых агентом 0.8.x."""
    return "\n".join(line for line in text.splitlines() if not line.startswith("CONSENT memory "))


class _Pending:
    """Реплики человека одного разговора, ещё не отданные извлекателю.

    `base` — сколько реплик человека разобрано до `texts` (курсор из базы, `dialogs.memory_notes_cursor`). После перезапуска
    агента состояние пусто, и первый проход добирает неразобранные реплики из самого диалога: заметки не теряются при выкате.
    """

    def __init__(self, user_id: str) -> None:
        self.user_id = user_id
        self.texts: list[str] = []
        self.base: int | None = None  # None — курсор ещё не прочитан из базы
        self.last_run = time.monotonic()  # отсчёт «раз в 20 секунд» идёт от первой реплики, а не от начала времён
        self.final = False  # разговор завершён, пока шёл проход: после него нужен ещё один, финальный


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
        self.notes = NotesService(
            self._database, config.notes_max, self._notes_changed, self._sources_suppressed, self._removed_by_person
        )
        self.outbox = CogneeOutbox(self._database, lambda: self._client)  # индекс разговоров в Cognee: очередь с повторами
        self._outbox_task: asyncio.Task[None] | None = None
        self._notes_cache: dict[str, list[dict[str, Any]]] = {}  # user_id → заметки для блока памяти (без обращений к базе на ходу)
        self._chat_search_cache: dict[str, bool] = {}
        # Извлечение заметок по ходу разговора: не чаще одного прохода на EXTRACT_EVERY_MESSAGES реплик или раз в EXTRACT_EVERY_SECONDS.
        self._extractor: NotesExtractor | None = None
        self._pending: dict[str, _Pending] = {}  # dialog_id → реплики человека, ещё не отданные извлекателю
        self._extracting: set[str] = set()
        self._datasets: dict[str, bool] = {}  # user_id → память включена (датасет существует)
        self._turn_recalls: dict[str, str] = {}  # user_id → находка recall по последней реплике человека
        # user_id → сколько раз человек убрал что-то из своей сводки с момента загрузки (счётчик только растёт). Открытая сессия
        # модели держит сводку в контексте и по смене счётчика переоткрывается к следующему ходу (`removals`).
        self._removals: dict[str, int] = {}
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
        self._removals.pop(user_id, None)

    def removals(self, user_id: str) -> int:
        """Сколько раз человек убрал что-то из своей сводки: удалил или поправил заметку, удалил всю память, выключил память,
        «Запоминать чувствительное» или «Опираться на прошлые разговоры», удалил разговор. Добавления (новая заметка, находка
        поиска, догрузка сводки) не считаются: их берёт плановая смена сессии."""
        return self._removals.get(user_id, 0)

    def _removed_by_person(self, user_id: str) -> None:
        self._removals[user_id] = self._removals.get(user_id, 0) + 1

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

    def _effective_enabled(self, user_id: str) -> bool:
        """Включена ли память: явное состояние кэша, иначе дефолт режима (opt-in или opt-out)."""
        return self._datasets.get(user_id, False)

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
                await self._refresh_notes(user_id)
                return
            exists = await self._client.dataset_exists(dataset_name(user_id))
            self._datasets[user_id] = exists  # старая память без строки настроек: есть датасет — человек включал
            if exists:
                await self._adopt_legacy(user_id)
            await self._refresh_notes(user_id)
        except Exception:  # noqa: BLE001 - память не должна мешать разговору (I3)
            logger.exception("cognee memory state load failed user=%s", user_id)
        finally:
            self._loading.discard(user_id)

    async def _adopt_legacy(self, user_id: str) -> None:
        """Память включали до строки настроек (агент 0.8.x): решение записывается в `memory_settings` с согласием из зерна.
        Иначе первый же переключатель (`put_memory_flags` создаёт строку с выключенной памятью) или «Удалить всю память»
        (датасета больше нет) молча выключили бы человеку память. Не записалось — попробуем при следующей загрузке."""
        version, at = await self._consent_of(user_id)
        try:
            await self._write_settings(user_id, True, version, at)
        except MemoryUnavailable:
            pass

    # ─── MemoryLink: то, что зовут хранилище и сессии разговора ───────────────

    async def prepare(self, dialog: Dialog) -> None:
        """Состояние памяти и заметки человека до первого ответа модели: без этого первый ход шёл бы без блока памяти."""
        if self._client is None or dialog.memory_mode != "on":
            return
        user_id = dialog.user_id
        if user_id not in self._datasets:
            await self._load_state(user_id)  # заодно читает заметки
        elif self._effective_enabled(user_id) and user_id not in self._notes_cache:
            await self._refresh_notes(user_id)

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
        return self._extractor is not None and dialog.memory_mode == "on" and self._effective_enabled(dialog.user_id)

    def _sources_suppressed(self, user_id: str, dialog_ids: list[str]) -> None:
        """Заметка убрана: документы её разговоров в Cognee пересобираются без реплик-источников (D15)."""
        self._turn_recalls.pop(user_id, None)
        if self._client is None or not dialog_ids:
            return
        for dialog_id in dialog_ids:
            self._spawn(self.outbox.add(user_id, "reindex_dialog", {"dialog_id": dialog_id}))
        self._spawn(self._tick_later())

    async def _tick_later(self) -> None:
        await asyncio.sleep(0)  # постановки выше успевают записаться
        await self.outbox.tick()

    async def _visible(self, user_id: str, found: str) -> str:
        """Находки Cognee без реплик, из которых человек убрал заметку: пока документ не пересобран, фильтруем на выдаче."""
        db = self._database()
        if db is None or not found:
            return found
        return filter_found(found, await asyncio.to_thread(db.suppressed_hashes, user_id))

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
            if pending is None or self._extractor is None:
                return
            db = self._database()
            if pending.base is None:
                pending.base = await asyncio.to_thread(db.get_notes_cursor, dialog.id) if db is not None else 0
                # Реплики, которые уже были в диалоге, но не разобраны (агент перезапускался): добираем их из диалога.
                said = [m.text for m in dialog.messages if m.role == "user"]
                earlier = said[pending.base :]
                if pending.texts and earlier[-len(pending.texts) :] == pending.texts:
                    earlier = earlier[: -len(pending.texts)]  # текущая реплика уже лежит в диалоге
                pending.texts = earlier + pending.texts
            if not pending.texts:
                return
            texts = list(pending.texts)
            context = [m.text for m in dialog.messages if m.role == "assistant"][-2:]
            started = time.monotonic()
            outcome = await self._extractor.extract(pending.user_id, texts, context, dialog.id)
            pending.last_run = time.monotonic()
            if outcome is not None and (outcome.changed or not outcome.failed):
                del pending.texts[: len(texts)]  # отданные реплики не возвращаем; при сбое модели остаются
                pending.base += len(texts)
                if db is not None:
                    await asyncio.to_thread(db.set_notes_cursor, dialog.id, pending.base)
            logger.info("memory extraction user=%s ms=%d changed=%s", pending.user_id, (time.monotonic() - started) * 1000, outcome.changed)
        except Exception:  # noqa: BLE001 - извлечение не должно мешать разговору (I3)
            logger.exception("memory extraction task failed dialog=%s", dialog.id)
        finally:
            self._extracting.discard(dialog.id)
            pending = self._pending.get(dialog.id)
            if pending is not None and pending.final:
                pending.final = False
                self._extracting.add(dialog.id)
                self._spawn(self._final_extract(dialog))  # финальный проход после того, что шёл при завершении разговора

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
        if (
            self._client is None
            or not text.strip()
            or not self._effective_enabled(dialog.user_id)
            or not self._chat_search_cache.get(dialog.user_id, True)
        ):
            return
        self._spawn(self._recall_turn(dialog.user_id, text))

    async def _recall_turn(self, user_id: str, text: str) -> str:
        assert self._client is not None
        try:
            # CHUNKS, а не GRAPH_COMPLETION: фоновый поиск на каждую реплику, синтез LLM тут не нужен и втрое медленнее
            found = await self._visible(user_id, _dialog_chunks(await self._client.recall_chunks(text, dataset_name(user_id))))
        except Exception:  # noqa: BLE001 - сбой поиска — просто старая сводка, разговор не трогаем
            logger.exception("cognee turn recall failed user=%s", user_id)
            return ""
        if found:
            self._turn_recalls[user_id] = found[:TURN_RECALL_MAX_CHARS]
        return found

    def enabled(self, user_id: str) -> bool:
        """По кэшу процесса; неизвестный человек — фоновая проверка датасета."""
        self._ensure_state(user_id)
        return self._effective_enabled(user_id)

    async def user_loaded(self, user_id: str) -> None:
        self._ensure_state(user_id)

    def user_unloaded(self, user_id: str) -> None:
        self._drop(user_id)  # при загрузке (`user_loaded`) состояние и сводка соберутся заново

    def dialog_ended(self, dialog: Dialog) -> None:
        """Диалог завершён: финальный проход извлечения и транскрипт в датасет человека (в фоне)."""
        if self._notes_active(dialog):
            pending = self._pending.setdefault(dialog.id, _Pending(dialog.user_id))  # после перезапуска состояния нет: добор из диалога
            if dialog.id in self._extracting:
                pending.final = True  # проход уже идёт: второй параллельно взял бы те же реплики и продублировал заметки
            else:
                self._extracting.add(dialog.id)
                self._spawn(self._final_extract(dialog))
        if not self._notes_active(dialog):
            self._pending.pop(dialog.id, None)
        if self._client is None or dialog.memory_mode != "on" or not self._effective_enabled(dialog.user_id):
            return
        if not self._chat_search_cache.get(dialog.user_id, True):
            return  # «Опираться на прошлые разговоры» выключено: в индекс разговор не идёт (включат — пересоберём из журнала)
        self._spawn(self.outbox.add(dialog.user_id, "index_dialog", {"dialog_id": dialog.id}, INDEX_DELAY_SECONDS))

    async def _final_extract(self, dialog: Dialog) -> None:
        await self._extract_pending(dialog)
        self._pending.pop(dialog.id, None)

    def user_erased(self, user_id: str) -> None:
        """Человек стёрт: кэши сбрасываются. Датасет в Cognee удалён раньше, синхронно (`erase_user_data`)."""
        self._drop(user_id)
        self._notes_cache.pop(user_id, None)
        self._chat_search_cache.pop(user_id, None)
        for dialog_id in [key for key, pending in self._pending.items() if pending.user_id == user_id]:
            self._pending.pop(dialog_id, None)  # неразобранные реплики стёртого не уходят в извлечение

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
            "mode": "on",  # оставлено для старых клиентов: прежние сборки читают поле; режимов off/shadow больше нет
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
        if user_id not in self._datasets and self._client is not None:
            await self._load_state(user_id)  # строка прежней памяти записывается до переключателей (`_adopt_legacy`)
        if sensitive_enabled is not None or chat_search_enabled is not None:
            _, before = await self.notes.flags(user_id)
            _, after = await self.notes.set_flags(user_id, sensitive_enabled, chat_search_enabled)
            self._chat_search_cache[user_id] = after
            if before and not after:
                # «Опираться на прошлые разговоры» выключили: индекс удаляется целиком, пока включён — ничего не догоняется
                await self.outbox.drop(user_id, ("index_dialog", "reindex_dialog", "rebuild", "delete_document"))
                await self.outbox.add(user_id, "delete_dataset")
                self._turn_recalls.pop(user_id, None)
                self._removed_by_person(user_id)
                self._spawn(self.outbox.tick())
            elif after and not before:
                await self.outbox.add(user_id, "rebuild")  # включили: индекс пересобирается в фоне из журнала
                self._spawn(self.outbox.tick())
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
        """Включение — запись согласия в настройки памяти (база агента), Cognee для этого не нужен; пауза — только флаг, заметки и
        индекс остаются. На паузе вызовов в Cognee нет (все пути режутся `_effective_enabled`)."""
        if enabled:
            if self._database() is None:
                raise MemoryUnavailable()  # настройки и заметки хранятся в базе агента: без неё включать нечего
            if not consent_version:
                raise MemoryValidation("consentVersion обязателен при включении")
            at = iso(datetime.now(UTC))
            await self._write_settings(user_id, True, consent_version, at)
            self._datasets[user_id] = True
            self._consents[user_id] = (consent_version, at)
            logger.info("cognee memory enabled user=%s", user_id)
            return {"enabled": True, "consentVersion": consent_version, "consentAt": at}
        version, at = await self._consent_of(user_id)  # пауза не отзывает согласие: оно остаётся в строке настроек
        await self._write_settings(user_id, False, version, at)
        self._datasets[user_id] = False
        self._removed_by_person(user_id)
        logger.info("cognee memory disabled (данные сохранены) user=%s", user_id)
        return {"enabled": False, "consentVersion": None, "consentAt": None}

    async def add_fact(self, user_id: str, category: str, text: Any, slots: Any) -> dict[str, Any]:
        """Факт, который человек написал сам: документом в его датасет. Ответ — в форме факта API (201)."""
        if not self._effective_enabled(user_id):
            raise MemoryDisabled()
        rendered = text if isinstance(text, str) and text else ", ".join(f"{key}: {value}" for key, value in (slots or {}).items())
        if not rendered:
            raise MemoryValidation("нужен текст")
        try:
            note = await self.notes.add(user_id, kind_of_category(category), rendered)
        except NoteRejected as error:  # прежний маршрут говорит прежним кодом
            raise FactRejected(error.reason or "rejected") from error
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
        try:
            return note_as_fact(await self.notes.patch(user_id, fact_id, text))
        except NoteRejected as error:
            raise FactRejected(error.reason or "rejected") from error
        except NoteNotFound as error:
            raise FactNotFound() from error

    async def delete_fact(self, user_id: str, fact_id: str) -> None:
        """Прежний маршрут факта: удаляет заметку."""
        try:
            await self.notes.delete(user_id, fact_id)
        except NoteNotFound as error:
            raise FactNotFound() from error

    async def forget_all(self, user_id: str, actor: str = "user") -> None:
        """«Удалить всю память»: заметки удаляются сразу, индекс прошлых разговоров в Cognee — через очередь (повтор, если Cognee
        недоступен). Настройки и согласие не меняются: память остаётся включённой (или на паузе)."""
        if user_id not in self._datasets and self._client is not None:
            await self._load_state(user_id)  # прежней памяти без строки настроек иначе после удаления датасета не стало бы
        await self.notes.delete_all(user_id)
        self._turn_recalls.pop(user_id, None)
        if self._client is not None:
            await self.outbox.drop(user_id, ("index_dialog", "reindex_dialog", "rebuild", "delete_document"))
            await self.outbox.add(user_id, "delete_dataset")
            self._spawn(self.outbox.tick())
        logger.info("memory forgotten user=%s", user_id)

    async def dialog_deleting(self, user_id: str, dialog_id: str) -> None:
        """Разговор удаляется (вручную или по сроку): его документ в Cognee удаляется жёстко через очередь. Вызывается до удаления
        строки из базы, пока известен `cognee_data_id`. Заметки из разговора остаются."""
        self._pending.pop(dialog_id, None)  # неразобранные реплики удаляемого разговора в заметки уже не идут
        self._turn_recalls.pop(user_id, None)  # находка по прошлым разговорам могла цитировать этот: пересоберётся по реплике
        self._removed_by_person(user_id)
        if self._client is None:
            return
        db = self._database()
        data_id = await asyncio.to_thread(db.get_cognee_data_id, dialog_id) if db is not None else None
        await self.outbox.add(user_id, "delete_document", {"dialog_id": dialog_id, "data_id": data_id})
        self._spawn(self.outbox.tick())

    async def erase_user_data(self, user_id: str) -> None:
        """Стирание аккаунта: датасет в Cognee удаляется синхронно, до ответа `204` (`CON-DATA-04`). Cognee недоступен — `MemoryUnavailable`
        (агент ответит 503, аккаунт не трогается). Без настроенного Cognee удалять нечего."""
        if self._client is None:
            return
        try:
            await self._client.forget_dataset(dataset_name(user_id))
        except Exception as error:  # noqa: BLE001
            logger.exception("cognee erase failed user=%s", user_id)
            raise MemoryUnavailable() from error
        await self.outbox.drop(user_id, ("index_dialog", "reindex_dialog", "rebuild", "delete_document", "delete_dataset"))
        self._drop(user_id)

    def start_outbox(self, interval_seconds: float = 10.0) -> None:
        """Фоновый проход очереди Cognee раз в `interval_seconds`."""
        if self._outbox_task is not None or self._client is None:
            return

        async def loop() -> None:
            while True:
                try:
                    await self.outbox.tick()
                except Exception:  # noqa: BLE001
                    logger.exception("cognee outbox tick failed")
                await asyncio.sleep(interval_seconds)

        self._outbox_task = asyncio.get_running_loop().create_task(loop(), name="memory-outbox")

    async def stop_outbox(self) -> None:
        if self._outbox_task is not None:
            self._outbox_task.cancel()
            await asyncio.gather(self._outbox_task, return_exceptions=True)
            self._outbox_task = None
