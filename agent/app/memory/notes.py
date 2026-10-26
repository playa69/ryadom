"""Заметки о человеке: слой 1 памяти (PROTEUS-242, `design.md` D1–D3). Хранятся в PostgreSQL агента (`memory_notes`).

Сервис не знает про Cognee и про модель: он проверяет заметку кодом (`guard.py`), держит лимит `MEMORY_NOTES_MAX`, пишет, правит и
удаляет. Извлекатель (модель) и REST зовут один и тот же `add`, поэтому запретное не пройдёт ни тем, ни другим путём.
Срока давности у заметок нет: заметка живёт, пока человек её не удалит или не удалит аккаунт.
Текст заметки не пишется в журнал (I4): только `user_id`, вид и длительность.
"""

import asyncio
import logging
import uuid
from collections.abc import Callable
from datetime import UTC, date, datetime
from typing import Any

from app.core.metrics import MEMORY_BLOCKED_TOTAL
from app.memory.errors import MemoryFull, MemoryUnavailable, MemoryValidation, NoteNotFound, NoteRejected
from app.memory.guard import check_note, is_sensitive
from app.memory.models import iso
from app.services.dialog_db import DialogDatabase

logger = logging.getLogger("agent.memory")

# Виды заметки → категория прежнего «факта» (закэшированная PWA читает `facts`, `design.md` D11).
_FACT_CATEGORY = {
    "name": "style",
    "style": "style",
    "person": "person",
    "situation": "situation",
    "event": "situation",
    "agreement": "goal",
    "interest": "interest",
    "boundary": "boundary",
    "wellbeing": "situation",
    "beliefs": "situation",
}
# Прежняя категория факта → вид новой заметки (добавление через старый `POST /facts`).
_KIND_OF_CATEGORY = {
    "style": "style",
    "boundary": "boundary",
    "person": "person",
    "situation": "situation",
    "goal": "agreement",
    "works": "interest",
    "interest": "interest",
}


def note_json(row: tuple[Any, ...]) -> dict[str, Any]:
    """Заметка для REST: (id, kind, text, sensitive, event_date, dialog_id, created_at, updated_at)."""
    note_id, kind, text, sensitive, event_date, dialog_id, created_at, updated_at = row
    return {
        "id": note_id,
        "kind": kind,
        "text": text,
        "sensitive": bool(sensitive),
        "eventDate": event_date.isoformat() if isinstance(event_date, date) else event_date,
        "createdAt": created_at,
        "updatedAt": updated_at,
        "dialogId": dialog_id,
    }


def note_as_fact(note: dict[str, Any]) -> dict[str, Any]:
    """Заметка в форме прежнего факта: старая PWA показывает её, «Забыть» удаляет, «Закрепить» получает отказ."""
    sources = [{"dialogId": note["dialogId"], "date": (note["createdAt"] or "")[:10]}] if note.get("dialogId") else []
    return {
        "id": note["id"],
        "category": _FACT_CATEGORY.get(note["kind"], "situation"),
        "text": note["text"],
        "slots": None,
        "importance": 5,
        "confidence": 1.0,
        "status": "active",
        "origin": "user_edit",
        "sensitivity": "sensitive" if note["sensitive"] else "normal",
        "sources": sources,
        "createdAt": note["createdAt"],
        "updatedAt": note["updatedAt"],
        "lastConfirmedAt": None,
        "expiresAt": None,
        "confirmCount": 0,
        "seenByUser": True,
    }


def kind_of_category(category: str) -> str:
    return _KIND_OF_CATEGORY.get(category, "situation")


class NotesService:
    """Заметки и переключатели «Запоминать чувствительное» / «Опираться на прошлые разговоры» в базе агента."""

    def __init__(self, database: Callable[[], DialogDatabase | None], max_notes: int = 200) -> None:
        self._database = database
        self._max = max_notes

    @property
    def max_notes(self) -> int:
        return self._max

    def _db(self) -> DialogDatabase:
        db = self._database()
        if db is None:
            raise MemoryUnavailable()  # без базы диалогов заметок негде хранить
        return db

    async def _call(self, fn: Callable[..., Any], *args: Any) -> Any:
        try:
            return await asyncio.to_thread(fn, *args)
        except Exception as error:  # noqa: BLE001
            logger.exception("memory notes db call failed")
            raise MemoryUnavailable() from error

    # ─── переключатели ────────────────────────────────────────────────────────

    async def flags(self, user_id: str) -> tuple[bool, bool]:
        """(запоминать чувствительное, опираться на прошлые разговоры)."""
        db = self._database()
        if db is None:
            return (False, True)
        return await self._call(db.get_memory_flags, user_id)

    async def set_flags(self, user_id: str, sensitive: bool | None, chat_search: bool | None) -> tuple[bool, bool]:
        """Записать переключатели. Выключение «чувствительного» сразу удаляет уже сохранённые чувствительные заметки."""
        db = self._db()
        old_sensitive, old_chat = await self._call(db.get_memory_flags, user_id)
        new_sensitive = old_sensitive if sensitive is None else sensitive
        new_chat = old_chat if chat_search is None else chat_search
        await self._call(db.put_memory_flags, user_id, new_sensitive, new_chat, iso(datetime.now(UTC)))
        if old_sensitive and not new_sensitive:
            removed = await self._call(db.delete_notes, user_id, True)
            logger.info("sensitive notes removed user=%s count=%d", user_id, removed)
        return new_sensitive, new_chat

    # ─── чтение ───────────────────────────────────────────────────────────────

    async def list(self, user_id: str, since: str | None = None, kinds: tuple[str, ...] | None = None) -> list[dict[str, Any]]:
        db = self._database()
        if db is None:
            return []
        rows = await self._call(db.list_notes, user_id, since, kinds)
        return [note_json(row) for row in rows]

    # ─── запись ───────────────────────────────────────────────────────────────

    async def add(
        self,
        user_id: str,
        kind: str,
        text: str,
        dialog_id: str | None = None,
        event_date: str | None = None,
        sensitive_enabled: bool | None = None,
    ) -> dict[str, Any]:
        """Новая заметка после проверок. Запретное — `NOTE_REJECTED` с кодом, лимит — `MEMORY_FULL`."""
        db = self._db()
        if sensitive_enabled is None:
            sensitive_enabled, _ = await self._call(db.get_memory_flags, user_id)
        cleaned = text.strip()
        verdict = check_note(cleaned, kind, sensitive_enabled)
        if not verdict.ok:
            MEMORY_BLOCKED_TOTAL.labels(verdict.reason or "unknown").inc()
            raise NoteRejected(verdict.reason or "unknown")
        if event_date is not None:
            try:
                date.fromisoformat(event_date)
            except ValueError as error:
                raise MemoryValidation("eventDate должна быть датой YYYY-MM-DD") from error
        if await self._call(db.count_notes, user_id) >= self._max:
            raise MemoryFull()
        now = iso(datetime.now(UTC))
        note_id = str(uuid.uuid4())
        parsed = date.fromisoformat(event_date) if event_date else None
        await self._call(db.add_note, (note_id, user_id, kind, cleaned, is_sensitive(kind), parsed, dialog_id, now, now))
        logger.info("memory note added user=%s kind=%s", user_id, kind)
        return note_json((note_id, kind, cleaned, is_sensitive(kind), parsed, dialog_id, now, now))

    async def patch(self, user_id: str, note_id: str, text: str) -> dict[str, Any]:
        """Правка текста: те же проверки, что у новой заметки. Чужая или несуществующая — `NOTE_NOT_FOUND`."""
        db = self._db()
        rows = await self._call(db.list_notes, user_id, None, None)
        current = next((row for row in rows if row[0] == note_id), None)
        if current is None:
            raise NoteNotFound()
        sensitive_enabled, _ = await self._call(db.get_memory_flags, user_id)
        cleaned = text.strip()
        verdict = check_note(cleaned, current[1], sensitive_enabled)
        if not verdict.ok:
            MEMORY_BLOCKED_TOTAL.labels(verdict.reason or "unknown").inc()
            raise NoteRejected(verdict.reason or "unknown")
        now = iso(datetime.now(UTC))
        if not await self._call(db.update_note, user_id, note_id, cleaned, now):
            raise NoteNotFound()
        return note_json((current[0], current[1], cleaned, current[3], current[4], current[5], current[6], now))

    async def delete(self, user_id: str, note_id: str) -> None:
        if not await self._call(self._db().delete_note, user_id, note_id):
            raise NoteNotFound()

    async def delete_all(self, user_id: str) -> int:
        """«Удалить всю память» (заметки). Настройки и согласие не трогаются."""
        db = self._database()
        return 0 if db is None else await self._call(db.delete_notes, user_id, False)
