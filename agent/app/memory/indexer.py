"""Слой 2 памяти: индекс прошлых разговоров в Cognee (PROTEUS-242, задачи 3.1–3.5, `design.md` D4).

Один документ на разговор, только реплики человека: без реплик агента, без ПДн (маскирование) и без кризисных кусков. Операции
идут через очередь `memory_outbox` с повторами: Cognee недоступен — заметки и разговор работают, индекс догоняет позже.
Очередь: `index_dialog {dialog_id}`, `delete_document {dialog_id, data_id}`, `delete_dataset`, `rebuild`. Тексты разговоров в очередь не
кладутся, документ собирается из базы в момент выполнения.
"""

import asyncio
import logging
import re
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any

from app.clients.cognee import CogneeClient
from app.core.metrics import MEMORY_OUTBOX_PENDING
from app.memory.extractor import is_explicit_request
from app.memory.guard import forbidden_in_index
from app.memory.masking import mask
from app.memory.suppress import fingerprint
from app.services.dialog_db import DialogDatabase
from app.services.replies import is_crisis

logger = logging.getLogger("agent.memory")

MIN_DOCUMENT_LINES = 2
RETRY_MAX_SECONDS = 3600
BATCH = 10


def dataset_name(user_id: str) -> str:
    """Имя датасета человека в Cognee."""
    return "ryadom_user_" + re.sub(r"[^A-Za-z0-9]", "_", user_id)


def document_name(dialog_id: str) -> str:
    return "dialog-" + dialog_id


def build_document(started_at: str, messages: list[tuple[str, str]], suppressed: set[str] | None = None) -> str | None:
    """Документ разговора для индекса: реплики человека с маскированием, без кризисных реплик, без диагнозов, лекарств, самоповреждения,
    документов и платёжного (то же «никогда», что у заметок), без просьб «забудь», «поправь», «убери» (в них названа тема, которую
    человек просит убрать) и без подавленных (человек убрал
    заметку, выросшую из реплики, D15). Мало осталось — документа нет."""
    lines = []
    for role, text in messages:
        if role != "user" or not text.strip() or is_crisis(text) or forbidden_in_index(text) or is_explicit_request([text]):
            continue
        masked = mask(text.strip())
        if "[карта]" in masked or "[документ]" in masked:
            continue  # платёжное и документы не кладём в индекс даже замаскированными
        if suppressed and fingerprint(masked) in suppressed:
            continue
        lines.append(masked)
    if len(lines) < MIN_DOCUMENT_LINES:
        return None
    return f"Реплики человека в разговоре от {started_at[:10]}:\n" + "\n".join(f"- {line}" for line in lines)


def _iso(moment: datetime) -> str:
    return moment.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class CogneeOutbox:
    """Очередь операций Cognee: постановка и выполнение с повторами (1, 2, 4… минут, не дольше часа)."""

    def __init__(self, database: Callable[[], DialogDatabase | None], client: Callable[[], CogneeClient | None]) -> None:
        self._database = database
        self._client = client
        self._lock = asyncio.Lock()  # проходы не пересекаются: одна операция не выполнится дважды

    async def add(self, user_id: str, op: str, payload: dict[str, Any] | None = None, delay_seconds: float = 0) -> None:
        """Поставить операцию. `delay_seconds` — не раньше чем через столько секунд (разговор успевает записаться на диск)."""
        db = self._database()
        if db is None:
            return  # без базы диалогов индекса нет: нечего хранить и нечем догонять
        now = datetime.now(UTC)
        await asyncio.to_thread(db.outbox_add, user_id, op, payload or {}, _iso(now + timedelta(seconds=delay_seconds)), _iso(now))

    async def drop(self, user_id: str, ops: tuple[str, ...]) -> None:
        db = self._database()
        if db is not None:
            await asyncio.to_thread(db.outbox_drop_user, user_id, ops)

    async def rebuilding(self, user_id: str) -> bool:
        """Идёт ли пересборка индекса человека после включения «Опираться на прошлые разговоры»."""
        db = self._database()
        return False if db is None else await asyncio.to_thread(db.outbox_rebuilding, user_id)

    async def pending(self) -> int:
        db = self._database()
        return 0 if db is None else await asyncio.to_thread(db.outbox_pending)

    async def tick(self) -> int:
        """Один проход очереди: выполнить то, чему пора. Возвращает, сколько операций выполнено. Сбой операции — повтор позже."""
        async with self._lock:
            return await self._tick()

    async def _tick(self) -> int:
        db, client = self._database(), self._client()
        if db is None or client is None:
            return 0
        done = 0
        now = _iso(datetime.now(UTC))
        for outbox_id, user_id, op, payload, attempts in await asyncio.to_thread(db.outbox_due, now, BATCH):
            try:
                await self._run(db, client, user_id, op, payload)
            except Exception:  # noqa: BLE001 - Cognee недоступен или ответил ошибкой: повторим, разговор не страдает
                delay = min(60 * (2**attempts), RETRY_MAX_SECONDS)
                logger.warning("cognee outbox op failed op=%s attempts=%d", op, attempts + 1)
                retry_at = _iso(datetime.now(UTC) + timedelta(seconds=delay))
                await asyncio.to_thread(db.outbox_retry, outbox_id, attempts + 1, retry_at)
                continue
            await asyncio.to_thread(db.outbox_done, outbox_id)
            done += 1
        MEMORY_OUTBOX_PENDING.set(await asyncio.to_thread(db.outbox_pending))
        return done

    async def _run(self, db: DialogDatabase, client: CogneeClient, user_id: str, op: str, payload: dict[str, Any]) -> None:
        dataset = dataset_name(user_id)
        if op == "reindex_dialog":
            # Документ разговора пересобирается без подавленных реплик: старый удаляется жёстко, новый строится заново.
            dialog_id = payload["dialog_id"]
            data_id = await asyncio.to_thread(db.get_cognee_data_id, dialog_id)
            if not data_id:
                return  # в индексе его нет: при индексации подавленные реплики и так не попадут
            await client.delete_document(dataset, data_id, document_name(dialog_id))
            await asyncio.to_thread(db.set_cognee_data_id, dialog_id, None)
            await self._index(db, client, user_id, dataset, dialog_id)
        elif op == "index_dialog":
            dialog_id = payload["dialog_id"]
            if await asyncio.to_thread(db.get_cognee_data_id, dialog_id):
                return  # уже в индексе
            await self._index(db, client, user_id, dataset, dialog_id)
        elif op == "delete_document":
            await client.delete_document(dataset, payload.get("data_id"), document_name(payload["dialog_id"]))
        elif op == "delete_dataset":
            await client.forget_dataset(dataset)
            await asyncio.to_thread(db.clear_cognee_data_ids, user_id)
        elif op == "rebuild":
            for dialog_id in await asyncio.to_thread(db.indexable_dialog_ids, user_id):
                await asyncio.to_thread(db.outbox_add, user_id, "index_dialog", {"dialog_id": dialog_id, "rebuild": True}, _iso(datetime.now(UTC)), _iso(datetime.now(UTC)))
        else:
            logger.warning("cognee outbox: unknown op=%s", op)

    async def _index(self, db: DialogDatabase, client: CogneeClient, user_id: str, dataset: str, dialog_id: str) -> None:
        found = await asyncio.to_thread(db.dialog_for_index, dialog_id)
        if found is None:
            return  # разговор удалён, пока операция ждала: воскрешать нельзя
        owner, started_at, mode, messages = found
        if owner != user_id or mode != "on":
            return
        suppressed = await asyncio.to_thread(db.suppressed_hashes, user_id, dialog_id)
        document = build_document(started_at, messages, suppressed)
        if document is None:
            return
        data_id = await client.add_document(document, dataset, document_name(dialog_id))
        # Разговор могли удалить за время вызова: тогда документ сразу убираем, чтобы не воскресить удалённое.
        if await asyncio.to_thread(db.dialog_for_index, dialog_id) is None:
            await client.delete_document(dataset, data_id, document_name(dialog_id))
            return
        if data_id:
            await asyncio.to_thread(db.set_cognee_data_id, dialog_id, data_id)
