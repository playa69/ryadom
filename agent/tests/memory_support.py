"""Общее для тестов памяти: поддельная модель извлечения, часы, хранилище с базой на временном файле, приложение."""

import asyncio
import json
import uuid
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from app.core.config import MemorySettings
from app.main import create_app
from app.memory.llm import MemoryModelError
from app.memory.models import Job
from app.memory.service import MemoryService
from app.services.dialog_db import DialogDatabase
from app.services.dialog_store import Dialog, DialogStore

CONSENT = "2026-10-12"


def memory_settings(**values: Any) -> MemorySettings:
    """Настройки памяти для теста (по умолчанию включена, уровень standard), без чтения окружения разработчика."""
    defaults: dict[str, Any] = {
        "MEMORY_MODE": "on",
        "MEMORY_BRIEF_LEVEL": "standard",
        "MEMORY_MAINTENANCE_SECONDS": 3600,
        "MEMORY_ALLOWLIST": "",
        "MEMORY_CLASSIFIER": "off",
    }
    defaults.update(values)
    return MemorySettings(**defaults)


class Clock:
    """Часы памяти: идут на секунду позади настоящих (эпоха включения раньше старта диалога) и двигаются вперёд вручную."""

    def __init__(self) -> None:
        self.offset = timedelta(seconds=-1)

    def __call__(self) -> datetime:
        return datetime.now(UTC) + self.offset

    def advance(self, **delta: float) -> None:
        self.offset += timedelta(**delta)


class FakeModel:
    """Модель извлечения: отвечает заранее заданными ответами по очереди (или функцией от сообщений) и запоминает запросы."""

    name = "fake-memory"

    def __init__(self, *answers: Any, hook: Callable[[list[dict[str, str]]], Any] | None = None) -> None:
        self.answers = list(answers)
        self.calls: list[list[dict[str, str]]] = []
        self.hook = hook  # вызывается на каждом запросе (async или нет): гонки с «забыть всё» и т. п.

    async def complete(self, messages: list[dict[str, str]]) -> str:
        self.calls.append(messages)
        if self.hook is not None:
            result = self.hook(messages)
            if asyncio.iscoroutine(result):
                await result
        answer = self.answers.pop(0) if self.answers else '{"ops":[],"skip_reason":"nothing_to_remember"}'
        if callable(answer) and not isinstance(answer, str):
            answer = answer(messages)
        if isinstance(answer, Exception):
            raise answer
        return answer

    async def aclose(self) -> None:
        return None


def model_error() -> MemoryModelError:
    return MemoryModelError("model", "test")


def op(
    kind: str = "add",
    category: str = "works",
    text: str | None = "Помогают вечерние прогулки",
    evidence: list[int] | None = None,
    importance: int = 3,
    confidence: float = 0.9,
    ref: str | None = None,
    slots: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "op": kind,
        "id": ref,
        "category": category,
        "text": text,
        "slots": slots,
        "importance": importance,
        "confidence": confidence,
        "evidence": [0] if evidence is None else evidence,
    }


def answer(*ops: dict[str, Any], skip: str | None = None) -> str:
    return json.dumps({"ops": list(ops), "skip_reason": skip}, ensure_ascii=False)


def user() -> str:
    return str(uuid.uuid4())


async def make_env(
    path: Path, model: Any = None, clock: Clock | None = None, **settings: Any
) -> tuple[DialogStore, DialogDatabase, MemoryService]:
    store, db = DialogStore(), DialogDatabase(str(path))
    store.require_disk()
    await store.attach(db, flush_interval=0.01)
    service = MemoryService(store, memory_settings(**settings), model, clock or Clock())
    store.memory = service
    return store, db, service


async def close_env(store: DialogStore, service: MemoryService) -> None:
    await service.drain()
    await store.detach()


async def enable(service: MemoryService, user_id: str) -> None:
    await service.update_settings(user_id, True, CONSENT)


def talk(store: DialogStore, dialog: Dialog, *texts: str, reply: str = "Понимаю. Расскажи ещё.") -> None:
    """Реплики человека, на каждую — ответ агента: номера реплик человека во входе модели — 0, 2, 4…"""
    for text in texts:
        store.add_message(dialog, "user", text)
        store.add_message(dialog, "assistant", reply)


FOUR = (
    "Привет, у меня был тяжёлый день на работе",
    "Меня вечером спасают прогулки с собакой",
    "Собаку зовут Бим, он очень смешной",
    "Ладно, пойду спать, спасибо",
)


async def run_job(service: MemoryService, dialog: Dialog) -> str:
    """Поставить и выполнить задание по диалогу; итог выполнения или статус постановки, если задание не поставлено."""
    status = await service.enqueue(dialog)
    if status != "queued":
        return status or "none"
    job = await job_of(service, dialog.id)
    assert job is not None
    return await service.process(job)


async def job_of(service: MemoryService, dialog_id: str) -> Job | None:
    from app.memory import store as S

    assert service.db is not None
    return await asyncio.to_thread(service.db.run, lambda conn: S.get_job(conn, dialog_id))


def make_client(
    path: Path | None,
    model: Any = None,
    live: Any = None,
    chat: Any = None,
    tts: Any = None,
    **settings: Any,
) -> TestClient:
    """Приложение целиком: база на временном файле (или без диска, если `path` None) и память с поддельной моделью."""
    return TestClient(
        create_app(
            lambda: tts,
            lambda: (chat, None),
            live_factory=(lambda: live) if live is not None else None,
            database_factory=(lambda: DialogDatabase(str(path))) if path is not None else (lambda: None),
            memory_settings=memory_settings(**settings),
            memory_model_factory=lambda: model,
        )
    )
