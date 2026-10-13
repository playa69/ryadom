"""Память агента: настройки человека, факты, «забыть всё», экспорт, «что изменилось», извлечение и кэш сводки (MEM-7, 8, 10).

`MemoryService` подключается к хранилищу диалогов (`DialogStore.memory`) и живёт в том же файле SQLite. Все записи идут через
`DialogDatabase.run` — под тем же замком, что запись диалогов; извлечение пишет одной транзакцией на диалог и внутри неё заново
проверяет, что память включена, диалог моложе эпохи и задание ещё существует (I9: гонка с «забыть всё», выключением и стиранием).

Чего здесь нет никогда: текстов фактов и реплик в журнале, метриках и текстах ошибок (I4); решений модели о стирании и
перезаписи слова человека (I7); фактов из реплик агента (I6).
"""

import asyncio
import logging
import time
import uuid
from collections.abc import Callable, Coroutine
from datetime import UTC, datetime, timedelta
from typing import Any, TypeVar

from app.core.config import MemorySettings
from app.core.metrics import (
    MEMORY_BLOCKED_TOTAL,
    MEMORY_BRIEF_CACHE_TOTAL,
    MEMORY_BRIEF_TOKENS,
    MEMORY_EXTRACTION_FAILURES_TOTAL,
    MEMORY_EXTRACTION_SECONDS,
    MEMORY_EXTRACTION_TOTAL,
    MEMORY_FACTS_TOTAL,
    MEMORY_USER_ACTIONS_TOTAL,
)
from app.memory import brief as briefs
from app.memory import extractor, filters
from app.memory import rules_ru as R
from app.memory import store as S
from app.memory.llm import ExtractionModel, MemoryModelError
from app.memory.models import Fact, Job, Op, UserMemorySettings, days, iso
from app.services.dialog_db import DialogDatabase
from app.services.dialog_store import Dialog, DialogStore

logger = logging.getLogger("agent.memory")

T = TypeVar("T")

MAX_ATTEMPTS = 3
RETRY_PAUSES = (30, 120, 600)  # секунд: после 1-й, 2-й и 3-й неудачи (после третьей — навсегда, MEM-7.8)
CATEGORY_ORDER = {category: index for index, category in enumerate(R.CATEGORIES)}
_NOT_EXPIRED = S.LIVE_STATUSES


# ─── Ошибки (коды каталога agent-api, раздел 10) ──────────────────────────────


class MemoryServiceError(Exception):
    status = 500
    code = "AGENT_INTERNAL"
    message = "Внутренняя ошибка памяти"
    reason: str | None = None


class MemoryUnavailable(MemoryServiceError):
    status, code, message = 503, "MEMORY_UNAVAILABLE", "Память сейчас недоступна"


class MemoryNotAllowed(MemoryServiceError):
    status, code, message = 403, "MEMORY_NOT_ALLOWED", "Память пока доступна не всем"


class MemoryDisabled(MemoryServiceError):
    status, code, message = 409, "MEMORY_DISABLED", "Память выключена"


class MemoryFull(MemoryServiceError):
    status, code, message = 409, "MEMORY_FULL", "Память заполнена"


class FactNotFound(MemoryServiceError):
    status, code, message = 404, "FACT_NOT_FOUND", "Факт не найден"


class FactRejected(MemoryServiceError):
    status, code, message = 422, "FACT_REJECTED", "Это нельзя запомнить"

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class MemoryValidation(MemoryServiceError):
    status, code = 422, "AGENT_VALIDATION"

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class DialogMissing(MemoryServiceError):
    status, code, message = 404, "AGENT_DIALOG_NOT_FOUND", "Диалог не найден"


# ─── Сервис ───────────────────────────────────────────────────────────────────


class MemoryService:
    """Память людей. Реализует `MemoryLink` хранилища диалогов: сводка, загрузка человека, конец диалога, стирание."""

    def __init__(
        self,
        store: DialogStore,
        config: MemorySettings,
        model: ExtractionModel | None,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self._store = store
        self._cfg = config
        self.model = model
        self.cache = briefs.BriefCache()
        self._clock = clock or (lambda: datetime.now(UTC))
        self._tasks: set[asyncio.Task[Any]] = set()
        self.wake = asyncio.Event()  # будит воркер: в очереди новое задание

    # ─── состояние ────────────────────────────────────────────────────────────

    def now(self) -> datetime:
        return self._clock()

    @property
    def db(self) -> DialogDatabase | None:
        return self._store.database

    @property
    def mode(self) -> str:
        """Режим функции: без диска памяти нет, `off` принудительно (MEM-10)."""
        return self._cfg.mode if self._store.disk_configured else "off"

    def status(self) -> str:
        """Для /health/ready: off | shadow | on | unavailable (диск или модель не готовы)."""
        if self.mode == "off":
            return "off"
        if self.db is None or self.model is None:
            return "unavailable"
        return self.mode

    @property
    def available(self) -> bool:
        """Функция работает: режим shadow или on, диск открыт, модель извлечения настроена."""
        return self.status() in ("shadow", "on")

    def _require_db(self) -> DialogDatabase | None:
        """База для изменения памяти. Диск задан, но не открыт — 503 (стирание не может честно ответить «готово»); диск не задан
        вовсе — None: памяти нет, удалять нечего."""
        db = self.db
        if db is None and self._store.disk_configured:
            raise MemoryUnavailable()
        return db

    def _require_writable(self) -> DialogDatabase:
        """Запись памяти по просьбе человека (включить, добавить, исправить): нужна включённая функция и диск."""
        if self.mode == "off":
            raise MemoryUnavailable()
        db = self.db
        if db is None:
            raise MemoryUnavailable()
        return db

    async def _run(self, db: DialogDatabase, operation: Callable[[Any], T]) -> T:
        return await asyncio.to_thread(db.run, operation)

    def _spawn(self, coro: Coroutine[Any, Any, Any]) -> None:
        try:
            task = asyncio.get_running_loop().create_task(coro)
        except RuntimeError:  # нет цикла событий (синхронный вызов в тестах): нечего планировать
            coro.close()
            return
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def drain(self) -> None:
        """Дождаться фоновых пересборок и постановок (тесты, остановка)."""
        while self._tasks:
            await asyncio.gather(*list(self._tasks), return_exceptions=True)

    # ─── MemoryLink: то, что зовут хранилище и сессии разговора ───────────────

    def brief(self, dialog: Dialog, count: bool = True) -> str:
        """Сводка для разговора из кэша процесса (I3). Только в режиме `on`, только при включённой памяти; иначе пусто."""
        if self.mode != "on" or dialog.memory_mode != "on":
            return ""
        current = self.cache.get(dialog.user_id)
        if count:  # метки метрик и сверка Live-сессии читают сводку, но в промпт её не кладут: их не считаем
            MEMORY_BRIEF_CACHE_TOTAL.labels("miss" if current is None else "hit" if current.text else "empty").inc()
        if current is None:
            return ""
        return current.text

    def enabled(self, user_id: str) -> bool:
        settings = self.cache.settings(user_id)
        return bool(settings and settings.enabled) and self.mode != "off"

    async def user_loaded(self, user_id: str) -> None:
        if self.db is not None:
            await self.rebuild(user_id)

    def dialog_ended(self, dialog: Dialog) -> None:
        if self.db is not None and self.mode != "off":
            self._spawn(self.enqueue(dialog))

    def user_erased(self, user_id: str) -> None:
        self.cache.drop(user_id)

    # ─── кэш сводки ───────────────────────────────────────────────────────────

    async def rebuild(self, user_id: str) -> None:
        """Пересобрать сводку человека из базы (в фоне). Сбой — пустая сводка, а не старая."""
        db = self.db
        if db is None:
            return
        try:

            def read(conn: Any) -> tuple[UserMemorySettings, list[Fact]]:
                return S.get_settings(conn, user_id), S.list_facts(conn, user_id, ("active", "pinned"))

            settings, facts = await self._run(db, read)
            now = self.now()
            text = briefs.build(facts, settings, self._cfg.brief_level, now)
            self.cache.put(user_id, text, settings, now)
            if text:
                MEMORY_BRIEF_TOKENS.observe(len(text) / 2.9)
        except Exception:  # noqa: BLE001 - память не должна мешать разговору (I3)
            logger.exception("memory brief rebuild failed user=%s", user_id)
            self.cache.invalidate(user_id)

    def invalidate(self, user_id: str) -> None:
        """Память человека изменилась: сводка сразу пустая, новая собирается в фоне. Идущий Live-разговор подхватит её при
        следующей смене сессии (сравнение текста сводки, `LiveDialogSession`)."""
        self.cache.invalidate(user_id)
        self._spawn(self.rebuild(user_id))

    async def refresh_stale(self, older_than: timedelta) -> None:
        """Сводки с относительными датами и сроками («3 дня назад», мягкий тон) стареют: пересобрать давние."""
        now = self.now()
        for user_id in self.cache.users():
            built = self.cache.built_at(user_id)
            if built is not None and now - built > older_than:
                await self.rebuild(user_id)

    # ─── чтение (работает всегда, I1) ─────────────────────────────────────────

    def _source_json(self, user_id: str, items: list[tuple[str, list[str]]]) -> list[dict[str, str]]:
        found = []
        for dialog_id, _ in items:
            dialog = self._store.get(user_id, dialog_id)
            if dialog is not None:
                found.append({"dialogId": dialog_id, "date": dialog.started_at[:10]})
        return found

    def _fact_json(self, fact: Fact, sources: dict[str, list[tuple[str, list[str]]]]) -> dict[str, Any]:
        return fact.to_json(self._source_json(fact.user_id, sources.get(fact.id, [])))

    async def get_memory(self, user_id: str) -> dict[str, Any]:
        db = self.db
        settings, facts, sources = UserMemorySettings(user_id), [], {}
        if db is not None:

            def read(conn: Any) -> tuple[UserMemorySettings, list[Fact], dict[str, list[tuple[str, list[str]]]]]:
                return S.get_settings(conn, user_id), S.list_facts(conn, user_id, _NOT_EXPIRED), S.sources(conn, user_id)

            settings, facts, sources = await self._run(db, read)
        now = self.now()
        facts.sort(key=lambda fact: (CATEGORY_ORDER[fact.category], -briefs.score(fact, now), fact.created_at, fact.id))
        return {
            "available": self.available,
            "mode": self.mode,
            "enabled": settings.enabled,
            "consentVersion": settings.consent_version,
            "consentAt": settings.consent_at,
            "rulesVersion": R.RULES_VERSION,
            "limits": {"maxFacts": R.MAX_FACTS},
            "facts": [self._fact_json(fact, sources) for fact in facts],
        }

    async def export(self, user_id: str) -> dict[str, Any]:
        """Всё о памяти человека: настройки, факты во всех статусах, источники, события без текстов (MEM-10)."""
        db = self.db
        settings, facts, sources, events = UserMemorySettings(user_id), [], {}, []
        if db is not None:

            def read(conn: Any) -> tuple[Any, ...]:
                return (
                    S.get_settings(conn, user_id),
                    S.list_facts(conn, user_id),
                    S.sources(conn, user_id),
                    S.events(conn, user_id),
                )

            settings, facts, sources, events = await self._run(db, read)
        MEMORY_USER_ACTIONS_TOTAL.labels("export").inc()
        return {
            "exportedAt": iso(self.now()),
            "rulesVersion": R.RULES_VERSION,
            "settings": {
                "enabled": settings.enabled,
                "consentVersion": settings.consent_version,
                "consentAt": settings.consent_at,
                "epochAt": settings.epoch_at,
                "updatedAt": settings.updated_at,
            },
            "facts": [self._fact_json(fact, sources) for fact in facts],
            "events": events,
        }

    async def changes(self, user_id: str, dialog_id: str) -> dict[str, Any]:
        """Что этот разговор добавил в память: карточка «Я запомнил» (MEM-10). Отданные факты помечаются увиденными."""
        dialog = self._store.get(user_id, dialog_id)
        if dialog is None:
            raise DialogMissing()
        db = self.db
        if db is None or self.mode == "off":
            return {"status": "skipped", "reason": "unavailable", "items": []}
        if dialog.memory_mode != "on":
            return {"status": "skipped", "reason": "memory_off", "items": []}

        def read(conn: Any) -> tuple[Job | None, UserMemorySettings, list[tuple[str, Fact]]]:
            job = S.get_job(conn, dialog_id)
            if job is not None and job.user_id != user_id:
                job = None
            items: list[tuple[str, Fact]] = []
            seen: set[str] = set()
            for fact_id, op in S.dialog_events(conn, user_id, dialog_id):
                if op not in ("add", "update", "confirm", "supersede") or not fact_id or fact_id in seen:
                    continue
                fact = S.get_fact(conn, user_id, fact_id)
                if fact is None or fact.status == "expired":
                    continue  # удалённые и заменённые не показываются
                seen.add(fact_id)
                items.append((op, fact))
            S.mark_seen(conn, user_id, seen)
            return job, S.get_settings(conn, user_id), items

        job, settings, items = await self._run(db, read)
        if job is None:
            if not settings.enabled:
                return {"status": "skipped", "reason": "disabled", "items": []}
            return {"status": "pending", "reason": None, "items": []}
        if job.status in ("queued", "running") or (job.status == "failed" and job.attempts < MAX_ATTEMPTS):
            return {"status": "pending", "reason": None, "items": []}
        if job.status in ("skipped", "failed"):
            return {"status": "skipped", "reason": job.skip_reason or "failed", "items": []}
        all_sources = await self._run(db, lambda conn: S.sources(conn, user_id))
        result = []
        for op, fact in items:
            fact.seen_by_user = True
            result.append({"op": op, "fact": self._fact_json(fact, all_sources)})
        return {"status": "ready", "reason": None, "items": result}

    # ─── изменения по просьбе человека ────────────────────────────────────────

    async def update_settings(self, user_id: str, enabled: bool, consent_version: str | None) -> dict[str, Any]:
        """Включить или выключить память. Включение — только с версией согласия; при каждом включении и выключении эпоха
        сдвигается: прежние разговоры не перерабатываются (I9). Выключение ничего не удаляет. Идемпотентно."""
        if enabled:
            if not consent_version:
                raise MemoryValidation("consentVersion обязателен при включении")
            db = self._require_writable()
            allowed = self._cfg.allowed_users
            if allowed and user_id.lower() not in allowed:
                raise MemoryNotAllowed()
        else:
            db = self._require_db()
            if db is None:
                return {"enabled": False, "consentVersion": None, "consentAt": None}
        now = iso(self.now())

        def write(conn: Any) -> UserMemorySettings:
            settings = S.get_settings(conn, user_id)
            if not enabled and settings.updated_at is None:
                return settings  # памяти никогда не было: выключать нечего, строку не заводим (I1)
            if enabled and not settings.enabled:
                settings.epoch_at = now
                settings.consent_version, settings.consent_at = consent_version, now
            elif enabled and consent_version != settings.consent_version:
                settings.consent_version, settings.consent_at = consent_version, now  # новая версия текста согласия
            elif not enabled and settings.enabled:
                settings.epoch_at = now
            else:
                return settings
            settings.enabled = enabled
            settings.updated_at = now
            S.save_settings(conn, settings)
            return settings

        settings = await self._run(db, write)
        MEMORY_USER_ACTIONS_TOTAL.labels("enable" if enabled else "disable").inc()
        logger.info("memory settings user=%s enabled=%s", user_id, enabled)
        self.cache.invalidate(user_id)
        await self.rebuild(user_id)  # переключатель меняет и `memoryEnabled`, и сводку: сразу, а не в фоне
        return {"enabled": settings.enabled, "consentVersion": settings.consent_version, "consentAt": settings.consent_at}

    def _person_text(self, category: str, text: Any, slots: Any) -> tuple[str, dict[str, str] | None]:
        """Текст и слоты ручного ввода после проверок MEM-7.5 п.1–3 и чёрного списка (п.6). Отказ — `FactRejected`."""
        if category not in R.CATEGORIES:
            raise MemoryValidation("неизвестная категория")
        if category in ("style", "person"):
            if text not in (None, ""):
                raise MemoryValidation("у этой категории правятся слоты, а не текст")
            clean, reason = filters.validate_slots(category, slots)
            if reason or clean is None:
                raise FactRejected(reason or "bad_slots")
        else:
            if not isinstance(text, str):
                raise MemoryValidation("нужен текст")
            clean = None
        rendered = filters.render_text(category, text if isinstance(text, str) else "", clean)
        if reason := filters.length_reason(category, rendered):
            raise FactRejected(reason)
        if reason := filters.blacklist_reason([rendered, *(clean or {}).values()], category):
            MEMORY_BLOCKED_TOTAL.labels(reason).inc()
            raise FactRejected(reason)
        return rendered, clean

    async def add_fact(self, user_id: str, category: str, text: Any, slots: Any) -> dict[str, Any]:
        """Факт, который человек написал сам: его слово, закреплён, важность 5 (MEM-10)."""
        db = self._require_writable()
        rendered, clean = self._person_text(category, text, slots)
        now = self.now()
        stamp = iso(now)

        def write(conn: Any) -> Fact:
            settings = S.get_settings(conn, user_id)
            if not settings.enabled:
                raise MemoryDisabled()
            digest = filters.norm_hash(rendered)
            conn.execute("DELETE FROM memory_tombstones WHERE user_id = ? AND norm_hash = ?", (user_id, digest))
            live = S.list_facts(conn, user_id, _NOT_EXPIRED)
            if category == "style":  # стиль у человека один: ручная правка заменяет его
                current = next((fact for fact in live if fact.category == "style"), None)
                if current is not None:
                    current.text, current.slots, current.norm_hash = rendered, clean, digest
                    current.origin, current.status, current.importance, current.confidence = "user_edit", "pinned", 5, 1.0
                    current.sensitivity, current.updated_at, current.seen_by_user = "normal", stamp, True
                    S.update_fact(conn, current)
                    S.add_event(conn, user_id, current.id, "user_edit", "user", None, stamp)
                    return current
            if len(live) >= R.MAX_FACTS and not self._evict(conn, user_id, live, now):
                raise MemoryFull()
            fact = Fact(
                id=str(uuid.uuid4()),
                user_id=user_id,
                category=category,
                text=rendered,
                slots=clean,
                importance=5,
                confidence=1.0,
                status="pinned",
                origin="user_edit",
                sensitivity="normal",  # человек написал сам: это и есть его согласие
                supersedes_id=None,
                norm_hash=digest,
                confirm_count=0,
                seen_by_user=True,
                created_at=stamp,
                updated_at=stamp,
                last_confirmed_at=None,
                expires_at=self._expires(category, rendered, now),
                purge_after=None,
            )
            S.insert_fact(conn, fact)
            S.add_event(conn, user_id, fact.id, "user_add", "user", None, stamp)
            return fact

        fact = await self._run(db, write)
        MEMORY_USER_ACTIONS_TOTAL.labels("add").inc()
        self.invalidate(user_id)
        return fact.to_json([])

    async def patch_fact(
        self,
        user_id: str,
        fact_id: str,
        text: Any = None,
        slots: Any = None,
        status: str | None = None,
        confirm: bool = False,
    ) -> dict[str, Any]:
        """Исправить («слово человека», закреплён), «Запомнить» предложенное, закрепить и открепить, «Верно» (MEM-10)."""
        if text is None and slots is None and status is None and not confirm:
            raise MemoryValidation("нечего менять")
        if status is not None and status not in ("active", "pinned"):
            raise MemoryValidation("status: active или pinned")
        db = self._require_writable()
        now = self.now()
        stamp = iso(now)
        edit: tuple[str, dict[str, str] | None] | None = None

        def write(conn: Any) -> tuple[Fact, dict[str, list[tuple[str, list[str]]]]]:
            nonlocal edit
            if not S.get_settings(conn, user_id).enabled:
                raise MemoryDisabled()
            fact = S.get_fact(conn, user_id, fact_id)
            if fact is None or fact.status == "expired":
                raise FactNotFound()
            if text is not None or slots is not None:
                edit = self._person_text(fact.category, text, slots)
                fact.text, fact.slots = edit
                fact.norm_hash = filters.norm_hash(fact.text)
                fact.origin, fact.status, fact.sensitivity = "user_edit", "pinned", "normal"
                fact.importance, fact.confidence = 5, 1.0
                conn.execute("DELETE FROM memory_tombstones WHERE user_id = ? AND norm_hash = ?", (user_id, fact.norm_hash))
                S.add_event(conn, user_id, fact.id, "user_edit", "user", None, stamp)
            if status is not None and status != fact.status:
                accepting = fact.status in ("proposed", "candidate")
                fact.status = status
                if accepting and fact.category != "recap":
                    fact.sensitivity = "normal"  # «Запомнить»: человек сам разрешил агенту знать это
                S.add_event(conn, user_id, fact.id, "user_confirm" if accepting else "user_edit", "user", None, stamp)
            if confirm:
                fact.confirm_count += 1
                fact.last_confirmed_at = stamp
                fact.expires_at = self._expires(fact.category, fact.text, now) or fact.expires_at
                if fact.status == "candidate":
                    fact.status = "active"
                S.add_event(conn, user_id, fact.id, "user_confirm", "user", None, stamp)
            fact.seen_by_user = True
            fact.updated_at = stamp
            S.update_fact(conn, fact)
            return fact, S.sources(conn, user_id)

        fact, sources = await self._run(db, write)
        action = "edit" if edit else ("confirm" if confirm else (status or "edit"))
        MEMORY_USER_ACTIONS_TOTAL.labels(action).inc()
        self.invalidate(user_id)
        return self._fact_json(fact, sources)

    async def delete_fact(self, user_id: str, fact_id: str) -> None:
        """«Забыть» (и «Не запоминать» у предложенного): строка и источники удаляются, остаётся надгробие — хэш, не текст, —
        чтобы извлечение не вернуло факт (I9). Работает и при выключенной памяти (I1). Повтор — без ошибки."""
        db = self._require_db()
        if db is None:
            return
        stamp = iso(self.now())

        def write(conn: Any) -> bool:
            fact = S.get_fact(conn, user_id, fact_id)
            if fact is None:
                return False
            S.add_tombstone(conn, user_id, fact.norm_hash, stamp)
            S.delete_fact(conn, user_id, fact_id)
            S.add_event(conn, user_id, fact_id, "user_delete", "user", None, stamp)
            return True

        if await self._run(db, write):
            MEMORY_FACTS_TOTAL.labels("user_delete").inc()
            MEMORY_USER_ACTIONS_TOTAL.labels("delete").inc()
        self.invalidate(user_id)

    async def forget_all(self, user_id: str, actor: str = "user") -> None:
        """«Забыть всё»: факты, источники, события, задания и надгробия человека одной транзакцией; эпоха = сейчас, чтобы
        прежние разговоры не вернули забытое; согласие и выключатель не меняются, диалоги не трогаются (MEM-10, MEM-13)."""
        db = self._require_db()
        if db is None:
            return
        stamp = iso(self.now())

        def write(conn: Any) -> int:
            count = S.forget_all(conn, user_id)
            settings = S.get_settings(conn, user_id)
            if settings.updated_at is not None:
                settings.epoch_at = stamp
                settings.tone_hint_until = None
                settings.updated_at = stamp
                S.save_settings(conn, settings)
                S.add_event(conn, user_id, None, "forget_all", actor, None, stamp)
            return count

        count = await self._run(db, write)
        await asyncio.to_thread(db.checkpoint)  # прежние образы страниц с текстами фактов не остаются в журнале WAL
        MEMORY_FACTS_TOTAL.labels("forget_all").inc()
        if actor == "user":
            MEMORY_USER_ACTIONS_TOTAL.labels("forget_all").inc()
        logger.info("memory forgotten user=%s facts=%d", user_id, count)
        self.cache.invalidate(user_id)
        await self.rebuild(user_id)

    # ─── извлечение: постановка в очередь (MEM-7.1) ───────────────────────────

    def _skip_reason(self, dialog: Dialog, settings: UserMemorySettings) -> str | None:
        if not settings.enabled:
            return "disabled"
        if dialog.memory_mode != "on":
            return "memory_off"
        if settings.epoch_at and dialog.started_at <= settings.epoch_at:
            return "epoch"
        explicit = extractor.has_explicit_request(dialog)
        if extractor.count_new_user_messages(dialog) < R.RENEW_AFTER_NEW_USER_MESSAGES and not explicit:
            return "too_short"
        if dialog.crisis_seen and not explicit:
            return "crisis"
        return None

    async def enqueue(self, dialog: Dialog) -> str | None:
        """Поставить извлечение по диалогу. Идемпотентно (I12): одно задание на диалог; выполненное оживает, только если после
        прошлого извлечения набралось ≥ 4 новых реплик человека. Без согласия человека и в разговоре «Без памяти» ничего не
        пишется вовсе (I1, I2). Возвращает статус задания (или None, если его нет)."""
        db = self.db
        if db is None or self.mode == "off":
            return None
        now = self.now()
        stamp = iso(now)
        user_id = dialog.user_id

        def write(conn: Any) -> str | None:
            settings = S.get_settings(conn, user_id)
            if not settings.enabled or dialog.memory_mode != "on":
                return None
            if dialog.crisis_seen and dialog.ended_at is not None:
                # Подсказка тона «прошлый раз было тяжело» без содержания (MEM-7.8 п.7).
                until = iso(now + days(R.TONE_HINT_DAYS))
                if (settings.tone_hint_until or "") < until:
                    settings.tone_hint_until = until
                    settings.updated_at = stamp
                    S.save_settings(conn, settings)
            reason = self._skip_reason(dialog, settings)
            job = S.get_job(conn, dialog.id)
            if job is None:
                job = Job(dialog.id, user_id, "queued", None, 0, stamp, None, stamp, None)
                if reason is not None:
                    job.status, job.skip_reason, job.done_at = "skipped", reason, stamp
                S.save_job(conn, job)
                return job.status
            if job.status in ("queued", "running", "failed"):
                return job.status
            if reason is None:
                job.status, job.skip_reason, job.attempts, job.run_after = "queued", None, 0, stamp
                job.last_error_code, job.done_at = None, None
                S.save_job(conn, job)
            elif job.status == "skipped" and job.skip_reason != reason:
                job.skip_reason, job.done_at = reason, stamp
                S.save_job(conn, job)
            return job.status

        try:
            status = await self._run(db, write)
        except Exception:  # noqa: BLE001 - постановка не должна ронять завершение разговора
            logger.exception("memory enqueue failed dialog=%s", dialog.id)
            return None
        if status == "queued":
            self.wake.set()
        if dialog.crisis_seen:
            self.invalidate(user_id)
        return status

    # ─── извлечение: выполнение задания (MEM-7.4–7.6) ─────────────────────────

    async def process(self, job: Job) -> str:
        """Выполнить одно задание. Возвращает итог: done | skipped | failed | retry | gone."""
        db = self.db
        if db is None or self.model is None:
            return "retry"
        started = time.monotonic()

        def claim(conn: Any) -> Job | None:
            current = S.get_job(conn, job.dialog_id)
            if current is None or current.status != "queued":
                return None
            current.status, current.attempts = "running", current.attempts + 1
            S.save_job(conn, current)
            return current

        current = await self._run(db, claim)
        if current is None:
            return "gone"
        user_id = current.user_id
        try:
            await self._store.ensure_user(user_id)
        except Exception:  # noqa: BLE001
            return await self._fail(current, "db")
        dialog = self._store.get(user_id, current.dialog_id)
        if dialog is None:
            return await self._finish_skip(current, "gone")
        settings = await self._run(db, lambda conn: S.get_settings(conn, user_id))
        if reason := self._skip_reason(dialog, settings):
            return await self._finish_skip(current, reason)
        facts = await self._run(db, lambda conn: S.list_facts(conn, user_id, _NOT_EXPIRED))
        inp = extractor.build_input(dialog, facts, self._cfg.extract_max_chars)
        try:
            async with asyncio.timeout(self._cfg.llm_timeout_seconds * 2 + 5):
                raw_ops, _ = await extractor.run_model(self.model, inp)
        except MemoryModelError as error:
            # В тексте ошибки только код и статус (ответа модели там нет): видно, что именно сломалось у прокси.
            logger.warning("memory model error dialog=%s: %s", current.dialog_id, error)
            return await self._fail(current, error.code)
        except extractor.ParseError:
            return await self._fail(current, "parse")
        except TimeoutError:
            return await self._fail(current, "timeout")
        except Exception:  # noqa: BLE001 - неожиданный сбой модели не оставляет задание «running» навсегда
            logger.exception("memory model call crashed dialog=%s", current.dialog_id)
            return await self._fail(current, "model")
        only_explicit = dialog.crisis_seen or inp.new_user_messages < R.RENEW_AFTER_NEW_USER_MESSAGES
        checked = extractor.check(raw_ops, inp, dialog, only_explicit)
        if self._cfg.classifier == "on":
            kept = []
            for op in checked.ops:
                if op.sensitive and await extractor.classify(self.model, op) == "forbidden":
                    checked.blocked.append("classifier")
                else:
                    kept.append(op)
            checked.ops = kept
        now = self.now()
        try:
            applied = await self._run(db, lambda conn: self._apply(conn, current, dialog, checked, inp.cutoff, now))
        except Exception:  # noqa: BLE001
            logger.exception("memory apply failed dialog=%s", dialog.id)
            return await self._fail(current, "db")
        for reason in checked.blocked:
            MEMORY_BLOCKED_TOTAL.labels(reason).inc()
        MEMORY_EXTRACTION_SECONDS.observe(time.monotonic() - started)
        if applied is None:  # память забыли, выключили или человека стёрли, пока шёл вызов модели: ничего не записано (I9)
            MEMORY_EXTRACTION_TOTAL.labels("skipped", "raced").inc()
            logger.info("memory extraction discarded dialog=%s: memory changed meanwhile", dialog.id)
            return "skipped"
        if inp.cutoff:
            dialog.memory_extracted_at = inp.cutoff
        for op_name in applied:
            MEMORY_FACTS_TOTAL.labels(op_name).inc()
        MEMORY_EXTRACTION_TOTAL.labels("done", "ok" if applied else "no_facts").inc()
        logger.info(
            "memory extracted dialog=%s ops=%d kept=%d blocked=%d ms=%d",
            dialog.id,
            len(checked.ops) + len(checked.blocked),
            len(applied),
            len(checked.blocked),
            (time.monotonic() - started) * 1000,
        )
        self.invalidate(user_id)
        return "done"

    async def _finish_skip(self, job: Job, reason: str) -> str:
        db = self.db
        stamp = iso(self.now())

        def write(conn: Any) -> None:
            current = S.get_job(conn, job.dialog_id)
            if current is None:
                return
            current.status, current.skip_reason, current.done_at = "skipped", reason, stamp
            S.save_job(conn, current)

        if db is not None:
            await self._run(db, write)
        MEMORY_EXTRACTION_TOTAL.labels("skipped", reason).inc()
        return "skipped"

    async def _fail(self, job: Job, code: str) -> str:
        """Неудача: повтор через 30 с, 2 мин; после третьей попытки — навсегда (MEM-7.8 п.2)."""
        db = self.db
        now = self.now()
        final = job.attempts >= MAX_ATTEMPTS

        def write(conn: Any) -> None:
            current = S.get_job(conn, job.dialog_id)
            if current is None:
                return
            current.status, current.last_error_code = "failed", code
            pause = RETRY_PAUSES[min(current.attempts, len(RETRY_PAUSES)) - 1]
            current.run_after = iso(now + timedelta(seconds=pause))
            if final:
                current.skip_reason, current.done_at = "failed", iso(now)
            S.save_job(conn, current)

        if db is not None:
            try:
                await self._run(db, write)
            except Exception:  # noqa: BLE001
                logger.exception("memory job state not saved dialog=%s", job.dialog_id)
        logger.warning("memory extraction failed dialog=%s code=%s attempt=%d", job.dialog_id, code, job.attempts)
        if final:
            MEMORY_EXTRACTION_FAILURES_TOTAL.labels(code).inc()
            MEMORY_EXTRACTION_TOTAL.labels("failed", code).inc()
            return "failed"
        return "retry"

    # ─── применение операций одной транзакцией (MEM-7.6) ──────────────────────

    def _expires(self, category: str, text: str, now: datetime) -> str | None:
        if category == "goal" and (date := filters.goal_date(text, now)) is not None:
            return iso(date + days(R.GOAL_DATE_GRACE_DAYS))
        ttl = R.TTL_DAYS[category]
        return iso(now + days(ttl)) if ttl is not None else None

    def _evict(self, conn: Any, user_id: str, live: list[Fact], now: datetime) -> bool:
        """Место для нового факта: вытесняется активный незакреплённый с наименьшим весом. Закреплённые не вытесняются."""
        victims = [fact for fact in live if fact.status == "active" and fact.origin != "user_edit"]
        if not victims:
            return False
        victim = min(victims, key=lambda fact: (briefs.score(fact, now), fact.created_at, fact.id))
        stamp = iso(now)
        victim.status, victim.purge_after, victim.updated_at = "expired", iso(now + days(R.EXPIRED_KEEP_DAYS)), stamp
        S.update_fact(conn, victim)
        S.add_event(conn, user_id, victim.id, "expire", "system", None, stamp)
        live.remove(victim)
        return True

    @staticmethod
    def _same_subject(fact: Fact, op: Op) -> bool:
        """Тот же предмет: стиль у человека один; близкий — та же роль и то же (или неизвестное) имя."""
        if fact.category != op.category:
            return False
        if op.category == "style":
            return True
        if op.category == "person" and fact.slots and op.slots:
            names = (fact.slots.get("name"), op.slots.get("name"))
            return fact.slots.get("role") == op.slots.get("role") and (None in names or names[0] == names[1])
        return False

    def _apply(
        self, conn: Any, job: Job, dialog: Dialog, checked: extractor.Checked, cutoff: str | None, now: datetime
    ) -> list[str] | None:
        """Записать операции одной транзакцией. None — писать нельзя (задание исчезло, память выключена или забыта):
        тогда в базу не попадает ничего (I9)."""
        user_id = dialog.user_id
        current = S.get_job(conn, job.dialog_id)
        if current is None or current.status != "running" or current.user_id != user_id:
            return None
        settings = S.get_settings(conn, user_id)
        if not settings.enabled or (settings.epoch_at and dialog.started_at <= settings.epoch_at):
            return None
        stamp = iso(now)
        live = S.list_facts(conn, user_id, _NOT_EXPIRED)
        applied: list[str] = []
        touched: set[str] = set()
        for op in checked.ops:
            result = self._apply_op(conn, op, dialog, live, touched, now)
            if result.startswith("blocked:"):
                checked.blocked.append(result.removeprefix("blocked:"))
            elif result:
                applied.append(result)
        current.status, current.skip_reason, current.done_at = "done", None if applied else "no_facts", stamp
        current.last_error_code = None
        S.save_job(conn, current)
        if cutoff:
            S.set_extracted(conn, dialog.id, cutoff)
        return applied

    def _status_for(self, op: Op) -> str:
        if op.sensitive:
            return "proposed"
        if op.explicit or op.confidence >= R.ACTIVE_CONFIDENCE:
            return "active"
        return "candidate"

    def _new_fact(self, op: Op, user_id: str, status: str, now: datetime, supersedes: str | None = None) -> Fact:
        stamp = iso(now)
        return Fact(
            id=str(uuid.uuid4()),
            user_id=user_id,
            category=op.category,
            text=op.text,
            slots=op.slots,
            importance=op.importance,
            confidence=op.confidence,
            status=status,
            origin="user_said" if op.explicit else "auto",
            sensitivity="sensitive" if op.sensitive else "normal",
            supersedes_id=supersedes,
            norm_hash=filters.norm_hash(op.text),
            confirm_count=0,
            seen_by_user=False,
            created_at=stamp,
            updated_at=stamp,
            last_confirmed_at=None,
            expires_at=self._expires(op.category, op.text, now),
            purge_after=None,
        )

    def _apply_op(self, conn: Any, op: Op, dialog: Dialog, live: list[Fact], touched: set[str], now: datetime) -> str:
        """Одна операция. Возвращает имя записанной операции (метка метрики), «blocked:<код>» или пустую строку."""
        user_id = dialog.user_id
        stamp = iso(now)
        if op.op in ("add", "update", "supersede") and S.has_tombstone(conn, user_id, filters.norm_hash(op.text)):
            return "blocked:tombstone"
        if op.op == "add":
            same = next((fact for fact in live if self._same_subject(fact, op)), None)
            if same is not None:
                merged = {**(same.slots or {}), **(op.slots or {})}
                if merged == (same.slots or {}):
                    return self._confirm(conn, same, op, dialog, touched, now)
                op.slots = merged
                op.text = filters.render_text(op.category, op.text, merged)
                op.op, op.ref = "update", same.id
            else:
                digest = filters.norm_hash(op.text)
                twin = next(
                    (
                        fact
                        for fact in live
                        if fact.category == op.category
                        and (fact.norm_hash == digest or filters.similarity(fact.text, op.text) >= R.DEDUP_SIMILARITY)
                    ),
                    None,
                )
                if twin is not None:
                    return self._confirm(conn, twin, op, dialog, touched, now)
        if op.op == "confirm":
            target = next((fact for fact in live if fact.id == op.ref), None)
            return self._confirm(conn, target, op, dialog, touched, now) if target else "blocked:bad_ref"
        if op.op in ("update", "supersede"):
            target = next((fact for fact in live if fact.id == op.ref), None)
            if target is None:
                return "blocked:bad_ref"
            if target.id in touched:
                return ""
            protected = target.status == "pinned" or target.origin == "user_edit"
            if not protected and not op.explicit and op.confidence < R.ACTIVE_CONFIDENCE and not op.sensitive:
                return "blocked:low_confidence"  # косвенный вывод не заменяет то, что уже известно
            status = "proposed" if protected else self._status_for(op)
            fact = self._new_fact(op, user_id, status, now, supersedes=target.id)
            fact.confirm_count = target.confirm_count
            S.insert_fact(conn, fact)
            S.copy_sources(conn, user_id, target.id, fact.id)
            S.add_source(conn, fact.id, user_id, dialog.id, op.message_ids)
            if not protected:  # слово человека модель не перетирает: старая версия остаётся, новая ждёт «Запомнить»
                target.status, target.purge_after = "expired", iso(now + days(R.EXPIRED_KEEP_DAYS))
                target.updated_at = stamp
                S.update_fact(conn, target)
                live.remove(target)
            live.append(fact)
            touched.update((target.id, fact.id))
            S.add_event(conn, user_id, fact.id, op.op, "extractor", dialog.id, stamp)
            return op.op
        # add нового факта
        if len(live) >= R.MAX_FACTS and not self._evict(conn, user_id, live, now):
            return "blocked:full"
        if op.category == "recap":  # пересказ у человека один: новый заменяет прежний
            for old in [fact for fact in live if fact.category == "recap"]:
                old.status, old.purge_after, old.updated_at = "expired", stamp, stamp
                S.update_fact(conn, old)
                S.add_event(conn, user_id, old.id, "expire", "system", dialog.id, stamp)
                live.remove(old)
        fact = self._new_fact(op, user_id, self._status_for(op), now)
        S.insert_fact(conn, fact)
        S.add_source(conn, fact.id, user_id, dialog.id, op.message_ids)
        S.add_event(conn, user_id, fact.id, "add", "extractor", dialog.id, stamp)
        live.append(fact)
        touched.add(fact.id)
        return "add"

    def _confirm(self, conn: Any, fact: Fact, op: Op, dialog: Dialog, touched: set[str], now: datetime) -> str:
        """Подтверждение: счётчик, срок продлевается, важность +1 не чаще раза за диалог; догадка (`candidate`) становится
        активной, только если подтверждена в другом разговоре, чем появилась (правило двух ударов)."""
        user_id = dialog.user_id
        stamp = iso(now)
        S.add_source(conn, fact.id, user_id, dialog.id, op.message_ids)
        if fact.id in touched or S.has_event(conn, user_id, fact.id, "confirm", dialog.id):
            return ""  # повтор в том же разговоре: только источник (I12)
        fact.confirm_count += 1
        fact.last_confirmed_at = stamp
        fact.importance = min(5, max(fact.importance + 1, op.importance if op.explicit else 0))
        if (renewed := self._expires(fact.category, fact.text, now)) is not None:
            fact.expires_at = renewed
        if fact.status == "candidate" and (op.explicit or S.first_dialog(conn, user_id, fact.id) not in (None, dialog.id)):
            fact.status = "active"
        fact.updated_at = stamp
        S.update_fact(conn, fact)
        S.add_event(conn, user_id, fact.id, "confirm", "extractor", dialog.id, stamp)
        touched.add(fact.id)
        return "confirm"
