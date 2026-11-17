"""TOOL-трейсинг вызовов памяти Cognee (`openspec/changes/update-sber500-dashboard-metrics`, «Метрики по дням для Sber500»).

На каждый публичный логический вызов клиента — одна запись TOOL в Langfuse: имя операции, user_id аккаунта, исход
(успех/ERROR); без текстов и содержимого памяти. Логин, чтение списка датасетов и повтор после 401 — служебные шаги
одного вызова и записей не создают. Сеть не используется: Cognee подменяется `httpx.MockTransport`.
"""

import asyncio
from typing import Any

import httpx
import pytest

from app.clients.cognee import CogneeClient
from app.core.tracing import LangfuseTracer
from app.memory.cognee_backend import CogneeMemoryBackend
from tests.test_memory_cognee_backend import CONSENT, backend, dataset_name, dialog, stored_dialog, uid

DATASET = "ryadom_user_x"


class RecordingTool:
    """Наблюдение-пустышка: запоминает обновления, чтобы тест видел исход вызова."""

    def __init__(self, record: dict[str, Any]) -> None:
        self._record = record

    def update(self, **kwargs: Any) -> None:
        self._record["updates"].append(kwargs)

    def end(self) -> None:
        self._record["ended"] = True


class RecordingToolTracer:
    """Трассировщик без Langfuse: каждая TOOL-запись — словарь в `records`."""

    name = "recording-tools"

    def __init__(self) -> None:
        self.records: list[dict[str, Any]] = []

    def start_tool(
        self,
        name: str,
        *,
        user_id: str | None = None,
        session_id: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> RecordingTool:
        record = {
            "name": name,
            "user_id": user_id,
            "session_id": session_id,
            "metadata": metadata,
            "updates": [],
            "ended": False,
        }
        self.records.append(record)
        return RecordingTool(record)


def traced_client(handler: Any, tracer: RecordingToolTracer) -> tuple[CogneeClient, list[httpx.Request]]:
    """Настоящий CogneeClient поверх MockTransport с записывающим трассировщиком."""
    requests: list[httpx.Request] = []

    def record(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return handler(request)

    client = CogneeClient(
        "http://cognee.test",
        "agent-service@cognee.dev",
        "test-password",
        client=httpx.AsyncClient(transport=httpx.MockTransport(record), base_url="http://cognee.test/api/v1"),
        tracer=tracer,  # type: ignore[arg-type]
    )
    return client, requests


def login_ok(request: httpx.Request) -> httpx.Response | None:
    """Ответ на логин или None, если запрос не про логин."""
    if request.url.path == "/api/v1/auth/login":
        return httpx.Response(200, json={"access_token": "token-1"})
    return None


def levels(record: dict[str, Any]) -> list[str | None]:
    return [update.get("level") for update in record["updates"]]


# ─── клиент: одна запись на логический вызов ──────────────────────────────────


async def test_search_success_writes_one_tool_record_without_content() -> None:
    """`openspec/changes/update-sber500-dashboard-metrics`, «Метрики по дням для Sber500»: успешный поиск — одна запись
    memory_search с userId; тексты запроса и находок в записи нет («Хранятся только агрегаты»)."""

    def handler(request: httpx.Request) -> httpx.Response:
        return login_ok(request) or httpx.Response(200, json=[{"search_result": [{"text": "синтетическая находка"}]}])

    tracer = RecordingToolTracer()
    client, _ = traced_client(handler, tracer)
    await client.connect()
    found = await client.recall_chunks("синтетический вопрос", DATASET, user_id="user-x", session_id="dialog-1")

    assert found == "синтетическая находка"
    (record,) = tracer.records
    assert record["name"] == "memory_search"
    assert record["user_id"] == "user-x" and record["session_id"] == "dialog-1"
    assert record["metadata"] == {"search_type": "chunks"}
    assert levels(record) == [] and record["ended"]
    assert "синтетический вопрос" not in str(record) and "синтетическая находка" not in str(record)
    assert all("input" not in update and "output" not in update for update in record["updates"])


async def test_search_non_200_is_an_error_record() -> None:
    """`openspec/changes/update-sber500-dashboard-metrics`, «Ошибки вызовов памяти не считаются»: не-200 — запись с ERROR."""
    tracer = RecordingToolTracer()
    client, _ = traced_client(lambda request: login_ok(request) or httpx.Response(500), tracer)
    await client.connect()
    assert await client.recall_chunks("вопрос", DATASET, user_id="user-x") == ""  # «памяти нет», а не сбой разговора
    (record,) = tracer.records
    assert record["name"] == "memory_search" and levels(record) == ["ERROR"]


async def test_write_exception_is_an_error_record_without_details() -> None:
    """`openspec/changes/update-sber500-dashboard-metrics`, «Ошибки вызовов памяти не считаются»: исключение — запись с ERROR,
    в статусе только тип ошибки (url несёт имя датасета с user_id и не попадает в трейс)."""
    tracer = RecordingToolTracer()
    client, _ = traced_client(lambda request: login_ok(request) or httpx.Response(500), tracer)
    await client.connect()
    with pytest.raises(httpx.HTTPStatusError):
        await client.add_document("текст", DATASET, "dialog-1", user_id="user-x", session_id="dialog-1")
    (record,) = tracer.records
    assert record["name"] == "memory_write" and levels(record) == ["ERROR"]
    status = record["updates"][0]["status"]
    assert status == "HTTPStatusError" and DATASET not in str(status) and "user-x" not in str(status)


async def test_401_retry_stays_one_record() -> None:
    """`openspec/changes/update-sber500-dashboard-metrics`, «Ретраи — один вызов»: перелогин и повтор внутри `_send`
    не создают второй записи."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/auth/login":
            return httpx.Response(200, json={"access_token": "token-2"})
        if request.headers.get("Authorization") != "Bearer token-2":
            return httpx.Response(401)
        return httpx.Response(200, json=["факт"])

    tracer = RecordingToolTracer()
    client, _ = traced_client(handler, tracer)
    await client.connect()
    client._client.headers["Authorization"] = "Bearer stale"
    assert await client.recall("вопрос", DATASET, user_id="user-x") == "факт"
    (record,) = tracer.records
    assert record["name"] == "memory_search" and levels(record) == []


async def test_login_and_dataset_lookup_write_nothing() -> None:
    """`openspec/changes/update-sber500-dashboard-metrics`, «Метрики по дням для Sber500»: логин и вспомогательное чтение
    списка датасетов — служебные обращения, записей нет."""
    tracer = RecordingToolTracer()
    client, _ = traced_client(lambda request: login_ok(request) or httpx.Response(200, json=[]), tracer)
    await client.connect()
    assert await client.dataset_exists(DATASET) is False
    assert tracer.records == []


async def test_remember_is_a_single_write_record() -> None:
    """`openspec/changes/update-sber500-dashboard-metrics`, «Метрики по дням для Sber500»: add+cognify — один логический
    вызов записи."""
    tracer = RecordingToolTracer()
    client, requests = traced_client(lambda request: login_ok(request) or httpx.Response(200, json={}), tracer)
    await client.connect()
    await client.remember("текст", DATASET, user_id="user-x")
    paths = [request.url.path for request in requests]
    assert "/api/v1/add" in paths and "/api/v1/cognify" in paths
    (record,) = tracer.records
    assert record["name"] == "memory_write" and record["user_id"] == "user-x" and levels(record) == []


async def test_delete_document_and_forget_dataset_have_their_own_names() -> None:
    """`openspec/changes/update-sber500-dashboard-metrics`, «Метрики по дням для Sber500»: удаления — отдельные операции
    memory_delete_document и memory_forget_dataset."""

    def handler(request: httpx.Request) -> httpx.Response:
        if login := login_ok(request):
            return login
        if request.url.path == "/api/v1/datasets":
            return httpx.Response(200, json=[{"id": "d-1", "name": DATASET}])
        return httpx.Response(200, json=[])

    tracer = RecordingToolTracer()
    client, _ = traced_client(handler, tracer)
    await client.connect()
    assert await client.delete_document(DATASET, "doc-1", user_id="user-x", session_id="dialog-1") is True
    assert await client.forget_dataset(DATASET, user_id="user-x") is True
    assert [record["name"] for record in tracer.records] == ["memory_delete_document", "memory_forget_dataset"]
    assert tracer.records[0]["session_id"] == "dialog-1"
    assert all(levels(record) == [] for record in tracer.records)


async def test_cancelled_call_is_an_error_record() -> None:
    """`openspec/changes/update-sber500-dashboard-metrics`, «Ошибки вызовов памяти не считаются»: отмена (CancelledError) —
    запись с ERROR `cancelled`, а не успех; исключение летит дальше."""

    def cancelled(request: httpx.Request) -> httpx.Response:
        raise asyncio.CancelledError

    tracer = RecordingToolTracer()
    client, _ = traced_client(cancelled, tracer)
    with pytest.raises(asyncio.CancelledError):
        await client.recall_chunks("вопрос", DATASET, user_id="user-x")
    (record,) = tracer.records
    assert levels(record) == ["ERROR"] and record["updates"][0]["status"] == "cancelled"
    assert record["ended"]


async def test_delete_document_without_dataset_or_document_is_not_found_error() -> None:
    """`openspec/changes/update-sber500-dashboard-metrics`, «Ошибки вызовов памяти не считаются»: удалять нечего
    (нет датасета или документа) — вызов не выполнен, запись с ERROR `not_found`, ответ False прежний."""

    def handler(request: httpx.Request) -> httpx.Response:
        if login := login_ok(request):
            return login
        if request.url.path == "/api/v1/datasets":
            return httpx.Response(200, json=[{"id": "d-1", "name": "ryadom_user_other"}])
        if request.url.path == "/api/v1/datasets/d-1/data":
            return httpx.Response(200, json=[])
        return httpx.Response(404)

    tracer = RecordingToolTracer()
    client, _ = traced_client(handler, tracer)
    await client.connect()
    assert await client.delete_document(DATASET, "doc-1", user_id="user-x") is False  # нет датасета
    (record,) = tracer.records
    assert record["name"] == "memory_delete_document"
    assert levels(record) == ["ERROR"] and record["updates"][0]["status"] == "not_found"
    assert DATASET not in str(record["updates"]) and "user-x" not in str(record["updates"])


async def test_delete_document_404_is_not_found_error() -> None:
    """`openspec/changes/update-sber500-dashboard-metrics`, «Ошибки вызовов памяти не считаются»: документа уже нет (404) —
    вызов не выполнен, запись с ERROR `not_found`, ответ False прежний."""

    def handler(request: httpx.Request) -> httpx.Response:
        if login := login_ok(request):
            return login
        if request.url.path == "/api/v1/datasets":
            return httpx.Response(200, json=[{"id": "d-1", "name": DATASET}])
        return httpx.Response(404)

    tracer = RecordingToolTracer()
    client, _ = traced_client(handler, tracer)
    await client.connect()
    assert await client.delete_document(DATASET, "doc-1", user_id="user-x") is False
    (record,) = tracer.records
    assert levels(record) == ["ERROR"] and record["updates"][0]["status"] == "not_found"


async def test_forget_dataset_without_dataset_is_not_found_error() -> None:
    """`openspec/changes/update-sber500-dashboard-metrics`, «Ошибки вызовов памяти не считаются»: датасета нет —
    удаление не выполнено, запись с ERROR `not_found`, ответ False прежний."""
    tracer = RecordingToolTracer()
    client, _ = traced_client(lambda request: login_ok(request) or httpx.Response(200, json=[]), tracer)
    await client.connect()
    assert await client.forget_dataset(DATASET, user_id="user-x") is False
    (record,) = tracer.records
    assert record["name"] == "memory_forget_dataset"
    assert levels(record) == ["ERROR"] and record["updates"][0]["status"] == "not_found"


async def test_langfuse_failure_does_not_break_the_memory_call() -> None:
    """`openspec/changes/update-sber500-dashboard-metrics`, «Метрики по дням для Sber500»: сбой записи в Langfuse не ломает
    вызов памяти."""
    tracer = LangfuseTracer.__new__(LangfuseTracer)

    def broken_start(name: str, **kwargs: Any) -> Any:
        raise RuntimeError("sdk down")

    tracer._client = type("BrokenSdk", (), {"start_observation": staticmethod(broken_start)})()
    tracer._capture_content = False
    client, _ = traced_client(lambda request: login_ok(request) or httpx.Response(200, json=["факт"]), tracer)  # type: ignore[arg-type]
    await client.connect()
    assert await client.recall("вопрос", DATASET, user_id="user-x") == "факт"


# ─── точки вызова: бэкенд и очередь передают user_id и диалог ─────────────────


def real_backend(tracer: RecordingToolTracer, handler: Any) -> CogneeMemoryBackend:
    """Бэкенд памяти поверх настоящего клиента с MockTransport: цепочка точка вызова → клиент → трассировщик."""
    client, _ = traced_client(handler, tracer)
    return backend(client)  # type: ignore[arg-type]


async def test_turn_recall_passes_user_and_dialog() -> None:
    """`openspec/changes/update-sber500-dashboard-metrics`, «Метрики по дням для Sber500»: фоновый поиск по реплике несёт
    user_id человека и id диалога как session_id."""

    def handler(request: httpx.Request) -> httpx.Response:
        if login := login_ok(request):
            return login
        if request.url.path == "/api/v1/datasets":
            return httpx.Response(200, json=[])
        return httpx.Response(200, json=[{"search_result": [{"text": "синтетическая находка"}]}])

    tracer = RecordingToolTracer()
    service = real_backend(tracer, handler)
    user = uid()
    await service.update_settings(user, True, CONSENT)
    await service.drain()
    current = dialog(user)
    service.user_message(current, "синтетическая реплика")
    await service.drain()

    (record,) = [r for r in tracer.records if r["name"] == "memory_search"]
    assert record["user_id"] == user and record["session_id"] == current.id


async def test_index_dialog_passes_user_and_dialog(monkeypatch: pytest.MonkeyPatch) -> None:
    """`openspec/changes/update-sber500-dashboard-metrics`, «Метрики по дням для Sber500»: запись транскрипта разговора —
    memory_write с user_id и session_id диалога."""
    monkeypatch.setattr("app.memory.cognee_backend.INDEX_DELAY_SECONDS", 0)

    def handler(request: httpx.Request) -> httpx.Response:
        if login := login_ok(request):
            return login
        if request.url.path == "/api/v1/datasets":
            return httpx.Response(200, json=[])
        if request.url.path == "/api/v1/add":
            return httpx.Response(200, json={"data_ingestion_info": [{"data_id": "doc-1"}]})
        return httpx.Response(200, json={})

    tracer = RecordingToolTracer()
    service = real_backend(tracer, handler)
    db = service._database()
    assert db is not None
    user = uid()
    await service.update_settings(user, True, CONSENT)
    dialog_id = stored_dialog(db, user, [("user", "первая синтетическая реплика"), ("user", "вторая синтетическая реплика")])
    current = dialog(user, 0)
    current.id = dialog_id
    service.dialog_ended(current)
    await service.drain()
    assert await service.outbox.tick() == 1

    (record,) = [r for r in tracer.records if r["name"] == "memory_write"]
    assert record["user_id"] == user and record["session_id"] == dialog_id and levels(record) == []
    assert "синтетическая реплика" not in str(record)


async def test_dialog_deleting_passes_user_and_dialog() -> None:
    """`openspec/changes/update-sber500-dashboard-metrics`, «Метрики по дням для Sber500»: удаление разговора —
    memory_delete_document с user_id и session_id диалога."""
    state: dict[str, str | None] = {"dataset": None, "document": None}

    def handler(request: httpx.Request) -> httpx.Response:
        if login := login_ok(request):
            return login
        if request.url.path == "/api/v1/datasets":
            known = [] if state["dataset"] is None else [{"id": "d-1", "name": state["dataset"]}]
            return httpx.Response(200, json=known)
        if request.url.path == "/api/v1/datasets/d-1/data":
            return httpx.Response(200, json=[{"id": "doc-1", "name": state["document"]}])
        return httpx.Response(200, json={})

    tracer = RecordingToolTracer()
    service = real_backend(tracer, handler)
    db = service._database()
    assert db is not None
    user = uid()
    await service.update_settings(user, True, CONSENT)
    dialog_id = stored_dialog(db, user, [("user", "реплика раз"), ("user", "реплика два")])
    state["dataset"] = dataset_name(user)
    state["document"] = f"dialog-{dialog_id}"
    await service.dialog_deleting(user, dialog_id)
    await service.drain()
    await service.outbox.tick()

    (record,) = [r for r in tracer.records if r["name"] == "memory_delete_document"]
    assert record["user_id"] == user and record["session_id"] == dialog_id and levels(record) == []


async def test_forget_all_and_erase_pass_user() -> None:
    """`openspec/changes/update-sber500-dashboard-metrics`, «Метрики по дням для Sber500»: удаление всей памяти через очередь
    и стирание аккаунта — memory_forget_dataset с user_id."""
    state: dict[str, str | None] = {"dataset": None}

    def handler(request: httpx.Request) -> httpx.Response:
        if login := login_ok(request):
            return login
        if request.url.path == "/api/v1/datasets":
            known = [] if state["dataset"] is None else [{"id": "d-1", "name": state["dataset"]}]
            return httpx.Response(200, json=known)
        return httpx.Response(200, json={})

    tracer = RecordingToolTracer()
    service = real_backend(tracer, handler)
    forgotten, erased = uid(), uid()
    for user in (forgotten, erased):
        await service.update_settings(user, True, CONSENT)
    await service.drain()
    state["dataset"] = dataset_name(forgotten)
    await service.forget_all(forgotten)
    await service.drain()
    await service.outbox.tick()
    state["dataset"] = dataset_name(erased)
    await service.erase_user_data(erased)

    records = [r for r in tracer.records if r["name"] == "memory_forget_dataset"]
    assert [(r["user_id"], r["session_id"]) for r in records] == [(forgotten, None), (erased, None)]
    assert all(levels(record) == [] for record in records)
