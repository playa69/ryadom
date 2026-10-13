"""Приёмник расхода моделей в Langfuse: те же числа, что уходят в Prometheus и в `model_usage`.

Отдельного SDK нет: пачка событий уходит на `POST {host}/api/public/ingestion` (Basic-ключ проекта).
В теле нет текстов реплик, фактов и id человека — только модель, задача и количество. Приёмник
включается, когда заданы адрес и оба ключа (`LangfuseSettings.active`); иначе `record` его не зовёт.
Сбой отправки расход в базе и в Prometheus не трогает: пачка теряется, в журнал пишется только код ответа.
"""

import logging
import queue
import threading
import uuid
from datetime import UTC, datetime
from typing import Any

import httpx

from app.core.config import LangfuseSettings
from app.services.usage import Usage, install_langfuse

logger = logging.getLogger("agent.langfuse")

_BATCH = 50


def _amount(value: float) -> int | float:
    return int(value) if value == int(value) else value


def _now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def events_for(item: Usage) -> list[dict[str, Any]]:
    """Два события одной пачки: трейс `model-usage` и generation с `usageDetails`. Без полей input/output."""
    stamp = _now()
    trace_id = str(uuid.uuid4())
    details: dict[str, int | float] = {}
    amount = _amount(item.amount)
    if item.unit == "tokens" and item.direction in ("input", "output"):
        details[item.direction] = amount
    else:
        details[f"{item.direction}_{item.modality}_{item.unit}"] = amount
    meta = {"task": item.task, "direction": item.direction, "modality": item.modality, "unit": item.unit}
    return [
        {
            "id": str(uuid.uuid4()),
            "type": "trace-create",
            "timestamp": stamp,
            "body": {"id": trace_id, "timestamp": stamp, "name": "model-usage", "metadata": meta},
        },
        {
            "id": str(uuid.uuid4()),
            "type": "generation-create",
            "timestamp": stamp,
            "body": {
                "id": str(uuid.uuid4()),
                "traceId": trace_id,
                "name": item.task,
                "startTime": stamp,
                "endTime": stamp,
                "model": item.model,
                "usageDetails": details,
                "metadata": meta,
            },
        },
    ]


class LangfuseUsageSink:
    """Фоновая отправка. `emit` не блокирует ход диалога: очередь, поток, сброс пачкой."""

    def __init__(
        self,
        host: str,
        public_key: str,
        secret_key: str,
        flush_seconds: float = 5,
        timeout_seconds: int = 5,
        client: httpx.Client | None = None,
        start_thread: bool = True,
    ) -> None:
        self._url = f"{host.rstrip('/')}/api/public/ingestion"
        self._auth = (public_key, secret_key)
        self._flush_seconds = flush_seconds
        self._own_client = client is None
        self._client = client or httpx.Client(timeout=timeout_seconds)
        self._pending: list[Usage] = []
        self._queue: queue.Queue[Usage | None] = queue.Queue(maxsize=2000)
        self._thread: threading.Thread | None = None
        if start_thread:
            self._thread = threading.Thread(target=self._run, name="langfuse-usage", daemon=True)
            self._thread.start()

    def emit(self, item: Usage) -> None:
        if self._thread is None:
            self._pending.append(item)
            return
        try:
            self._queue.put_nowait(item)
        except queue.Full:
            logger.warning("langfuse usage queue full")

    def flush(self) -> None:
        """Сбросить то, что накоплено без потока (тесты). Боевой приёмник сбрасывает сам."""
        pending, self._pending = self._pending, []
        self._send(pending)

    def close(self) -> None:
        if self._thread is not None:
            try:
                self._queue.put(None, timeout=1)
            except queue.Full:
                logger.warning("langfuse usage sink did not stop: queue full")
            self._thread.join(timeout=self._flush_seconds + 2)
            self._thread = None
        else:
            self.flush()
        if self._own_client:
            self._client.close()

    def _run(self) -> None:
        batch: list[Usage] = []
        while True:
            try:
                item = self._queue.get(timeout=self._flush_seconds)
            except queue.Empty:
                self._send(batch)
                batch = []
                continue
            if item is None:
                self._send(batch)
                return
            batch.append(item)
            if len(batch) >= _BATCH:
                self._send(batch)
                batch = []

    def _send(self, batch: list[Usage]) -> None:
        if not batch:
            return
        events = [event for item in batch for event in events_for(item)]
        try:
            response = self._client.post(self._url, json={"batch": events}, auth=self._auth)
        except httpx.HTTPError as error:
            logger.warning("langfuse usage ingest failed error=%s events=%d", type(error).__name__, len(events))
            return
        if response.status_code >= 300:
            logger.warning("langfuse usage ingest failed status=%s events=%d", response.status_code, len(events))


def start_langfuse_sink(settings: LangfuseSettings) -> LangfuseUsageSink | None:
    """Включить приёмник на время жизни процесса. Без ключей — None, `record` его не зовёт."""
    if not settings.active:
        logger.info("langfuse usage sink off")
        install_langfuse(None)
        return None
    secret = settings.secret_key.get_secret_value() if settings.secret_key is not None else ""
    sink = LangfuseUsageSink(
        settings.host.strip(),
        settings.public_key.strip(),
        secret,
        flush_seconds=settings.flush_seconds,
        timeout_seconds=settings.timeout_seconds,
    )
    install_langfuse(sink)
    logger.info("langfuse usage sink on host=%s", settings.host.strip())
    return sink
