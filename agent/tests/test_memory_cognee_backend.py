"""Бэкенд памяти на Cognee (`MEMORY_BACKEND=cognee`): согласие = датасет, запись транскрипта, сводка из prefetch-кэша.

Cognee API мокается двумя способами: клиент (`CogneeClient`) — через `httpx.MockTransport` (логин, 401, 404 поиска),
бэкенд (`CogneeMemoryBackend`) — подменой клиента фейком. Сеть не используется.
"""

import asyncio
import json
import uuid
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from app.clients.cognee import CogneeClient
from app.main import create_app
from app.memory.cognee_backend import BRIEF_QUERY, CogneeMemoryBackend, dataset_name
from app.memory.service import MemoryDisabled, MemoryServiceError, MemoryValidation
from app.services.dialog_store import Dialog, Message, now_iso
from tests.memory_support import memory_settings

CONSENT = "2026-10-21"


def uid() -> str:
    return str(uuid.uuid4())


def dialog(user_id: str, user_messages: int = 4) -> Dialog:
    """Завершённый диалог с парами реплик человек/агент."""
    messages = []
    for index in range(user_messages):
        messages.append(Message(id=str(index * 2), role="user", text=f"реплика {index}", created_at=now_iso()))
        messages.append(Message(id=str(index * 2 + 1), role="assistant", text="Понимаю.", created_at=now_iso()))
    return Dialog(id=str(uuid.uuid4()), user_id=user_id, started_at=now_iso(), ended_at=now_iso(), messages=messages)


class FakeCognee:
    """Поддельный CogneeClient: датасеты и документы в памяти теста, вызовы записываются."""

    def __init__(self, recall_text: str = "Человека зовут Алекс, он из Твери.") -> None:
        self.connected = False
        self.datasets: set[str] = set()
        self.consents: dict[str, str] = {}
        self.remembered: list[tuple[str, str]] = []
        self.recalls: list[tuple[str, str]] = []
        self.deleted: list[str] = []
        self.recall_text = recall_text
        self.recall_gate: asyncio.Event | None = None  # если задан, recall ждёт его (управление моментом prefetch)

    async def connect(self) -> None:
        self.connected = True

    async def remember(self, text: str, dataset: str) -> None:
        self.remembered.append((text, dataset))
        self.datasets.add(dataset)
        if text.startswith("CONSENT memory"):
            self.consents[dataset] = text

    async def recall(self, query: str, dataset: str) -> str:
        self.recalls.append((query, dataset))
        if self.recall_gate is not None:
            await self.recall_gate.wait()
        return self.recall_text if dataset in self.datasets else ""

    async def recall_chunks(self, query: str, dataset: str) -> str:
        self.recalls.append((query, dataset))
        if self.recall_gate is not None:
            await self.recall_gate.wait()
        return self.recall_text if dataset in self.datasets else ""

    async def read_consent(self, dataset: str) -> str:
        return self.consents.get(dataset, "")

    async def dataset_exists(self, dataset: str) -> bool:
        return dataset in self.datasets

    async def forget_dataset(self, dataset: str) -> bool:
        self.deleted.append(dataset)
        self.datasets.discard(dataset)
        self.consents.pop(dataset, None)
        return True

    async def aclose(self) -> None:
        return None


def backend(fake: FakeCognee | None) -> CogneeMemoryBackend:
    return CogneeMemoryBackend(fake, memory_settings(MEMORY_BACKEND="cognee", MEMORY_COGNIFY_SETTLE_SECONDS="0"))  # type: ignore[arg-type]


# ─── клиент (MockTransport) ───────────────────────────────────────────────────


def mock_client(handler: Any) -> tuple[CogneeClient, list[httpx.Request]]:
    requests: list[httpx.Request] = []

    def record(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return handler(request)

    client = CogneeClient(
        "http://cognee.test",
        "agent-service@cognee.dev",
        "test-password",
        client=httpx.AsyncClient(transport=httpx.MockTransport(record), base_url="http://cognee.test/api/v1"),
    )
    return client, requests


def test_client_login_and_bearer() -> None:
    """Логин при старте: POST /auth/login формой, дальше вызовы идут с Bearer."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/auth/login":
            return httpx.Response(200, json={"access_token": "token-1"})
        return httpx.Response(200, json=[])

    async def run() -> None:
        client, requests = mock_client(handler)
        assert not any(r.url.path == "/api/v1/auth/login" for r in requests)
        await client.connect()
        await client.recall("вопрос", "ryadom_user_x")
        login = next(r for r in requests if r.url.path == "/api/v1/auth/login")
        assert b"username=agent-service%40cognee.dev" in login.read()
        search = requests[-1]
        assert search.url.path == "/api/v1/search"
        assert search.headers["Authorization"] == "Bearer token-1"

    asyncio.run(run())


def test_client_relogin_on_401() -> None:
    """Протухший токен: перелогин и один повтор запроса."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/auth/login":
            return httpx.Response(200, json={"access_token": "token-2"})
        if request.headers.get("Authorization") != "Bearer token-2":
            return httpx.Response(401)
        return httpx.Response(200, json=["факт"])

    async def run() -> None:
        client, requests = mock_client(handler)
        await client.connect()
        client._client.headers["Authorization"] = "Bearer stale"
        assert await client.recall("вопрос", "ryadom_user_x") == "факт"
        assert sum(1 for r in requests if r.url.path == "/api/v1/auth/login") == 2

    asyncio.run(run())


def test_client_recall_404_is_empty() -> None:
    """Датасета нет (404) — recall читает это как «памяти нет», без исключения."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/auth/login":
            return httpx.Response(200, json={"access_token": "t"})
        return httpx.Response(404, json={"detail": "not found"})

    async def run() -> None:
        client, _ = mock_client(handler)
        await client.connect()
        assert await client.recall("вопрос", "ryadom_user_missing") == ""

    asyncio.run(run())


def test_client_recall_unpacks_search_result() -> None:
    """Элементы ответа со списком search_result распаковываются в текст."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/auth/login":
            return httpx.Response(200, json={"access_token": "t"})
        return httpx.Response(200, json=[{"search_result": ["раз", "два"]}, "три"])

    async def run() -> None:
        client, _ = mock_client(handler)
        await client.connect()
        assert await client.recall("вопрос", "ryadom_user_x") == "раз\nдва\nтри"

    asyncio.run(run())


def test_client_forget_dataset() -> None:
    """Удаление: id датасета ищется по имени в GET /datasets, затем DELETE /datasets/{id}."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/auth/login":
            return httpx.Response(200, json={"access_token": "t"})
        if request.url.path == "/api/v1/datasets":
            return httpx.Response(200, json=[{"id": "d-1", "name": "ryadom_user_x"}])
        if request.method == "DELETE" and request.url.path == "/api/v1/datasets/d-1":
            return httpx.Response(200)
        return httpx.Response(404)

    async def run() -> None:
        client, requests = mock_client(handler)
        await client.connect()
        assert await client.dataset_exists("ryadom_user_x") is True
        assert await client.forget_dataset("ryadom_user_x") is True
        assert await client.forget_dataset("ryadom_user_y") is False  # нет такого — без DELETE
        deletes = [r for r in requests if r.method == "DELETE"]
        assert len(deletes) == 1

    asyncio.run(run())


# ─── бэкенд (фейк вместо клиента) ─────────────────────────────────────────────


async def test_update_settings_on_creates_seed() -> None:
    """Включение памяти — документ-зерно CONSENT, оно же создаёт датасет человека."""
    fake = FakeCognee()
    service = backend(fake)
    user = uid()
    result = await service.update_settings(user, True, CONSENT)
    await service.drain()
    assert result["enabled"] is True and result["consentVersion"] == CONSENT
    seed, dataset = fake.remembered[0]
    assert dataset == dataset_name(user)
    assert seed.startswith(f"CONSENT memory v{CONSENT} ")
    assert service.enabled(user) is True
    await service.drain()  # prefetch после включения
    memory = await service.get_memory(user)
    assert memory["enabled"] is True and memory["consentVersion"] == CONSENT
    assert memory["rulesVersion"] == "cognee" and memory["facts"] == []


async def test_update_settings_requires_consent() -> None:
    fake = FakeCognee()
    with pytest.raises(MemoryValidation):
        await backend(fake).update_settings(uid(), True, None)
    assert fake.remembered == []


async def test_update_settings_off_keeps_dataset() -> None:
    """Выключение памяти — только флаг: ни DELETE датасета, ни вообще вызовов в Cognee. Удаление — отдельной джобой."""
    fake = FakeCognee()
    service = backend(fake)
    user = uid()
    await service.update_settings(user, True, CONSENT)
    await service.drain()
    remembered_before = list(fake.remembered)
    recalls_before = list(fake.recalls)
    await service.update_settings(user, False, None)
    assert fake.deleted == []  # датасет не трогаем
    assert fake.remembered == remembered_before and fake.recalls == recalls_before  # и никаких других вызовов
    assert service.enabled(user) is False


async def test_dialog_ended_remembers_transcript() -> None:
    """Конец разговора у включившего память: транскрипт «Человек/Агент» уходит в его датасет, сводка перечитывается."""
    fake = FakeCognee()
    service = backend(fake)
    user = uid()
    await service.update_settings(user, True, CONSENT)
    await service.drain()
    fake.remembered.clear()
    service.dialog_ended(dialog(user))
    await service.drain()
    transcript, dataset = fake.remembered[0]
    assert dataset == dataset_name(user)
    assert transcript.startswith("Транскрипт разговора человека с агентом поддержки:")
    assert transcript.count("Человек: реплика") == 4 and "Агент: Понимаю." in transcript
    assert fake.recalls[-1] == (BRIEF_QUERY, dataset)  # prefetch после записи


async def test_dialog_ended_without_consent_writes_nothing() -> None:
    fake = FakeCognee()
    service = backend(fake)
    user = uid()
    service.dialog_ended(dialog(user))
    service.dialog_ended(dialog(user, user_messages=2))  # и короткий разговор у включившего — тоже мимо
    await service.update_settings(user, True, CONSENT)
    await service.drain()
    fake.remembered.clear()
    service.dialog_ended(dialog(user, user_messages=3))
    await service.drain()
    assert fake.remembered == []


async def test_brief_is_sync_cache_with_prefetch() -> None:
    """brief до prefetch — пустая строка мгновенно; после завершения фонового recall — текст сводки."""
    fake = FakeCognee()
    fake.recall_gate = asyncio.Event()
    service = backend(fake)
    user = uid()
    await service.update_settings(user, True, CONSENT)
    current = dialog(user)
    assert service.brief(current) == ""  # recall ещё идёт
    fake.recall_gate.set()
    await service.drain()
    assert service.brief(current) == fake.recall_text


async def test_brief_memory_off_dialog() -> None:
    fake = FakeCognee()
    service = backend(fake)
    user = uid()
    await service.update_settings(user, True, CONSENT)
    await service.drain()
    silent = dialog(user)
    silent.memory_mode = "off"  # разговор «Без памяти»: ни сводки, ни записи
    assert service.brief(silent) == ""
    fake.remembered.clear()
    service.dialog_ended(silent)
    await service.drain()
    assert fake.remembered == []


async def test_add_fact_remembers_and_disables_check() -> None:
    fake = FakeCognee()
    service = backend(fake)
    user = uid()
    with pytest.raises(MemoryDisabled):
        await service.add_fact(user, "works", "Помогают прогулки", None)
    await service.update_settings(user, True, CONSENT)
    await service.drain()
    created = await service.add_fact(user, "works", "Помогают прогулки", None)
    assert created["category"] == "works" and created["text"] == "Помогают прогулки"
    assert fake.remembered[-1][0] == "Факт о человеке (works): Помогают прогулки"


async def test_patch_delete_unsupported() -> None:
    """Правка и удаление отдельного факта у Cognee нет: 422 с reason unsupported_in_cognee."""
    service = backend(FakeCognee())
    user = uid()
    for call in (
        lambda: service.patch_fact(user, "fact-1", text="новое"),
        lambda: service.delete_fact(user, "fact-1"),
    ):
        with pytest.raises(MemoryServiceError) as caught:
            await call()
        assert caught.value.status == 422 and caught.value.reason == "unsupported_in_cognee"


async def test_forget_all_deletes_dataset_and_resets() -> None:
    fake = FakeCognee()
    service = backend(fake)
    user = uid()
    await service.update_settings(user, True, CONSENT)
    await service.drain()
    assert service.brief(dialog(user))  # сводка была в кэше
    await service.forget_all(user)
    assert fake.deleted == [dataset_name(user)]
    assert service.enabled(user) is False
    assert service.brief(dialog(user)) == ""


async def test_user_erased_forgets_dataset() -> None:
    fake = FakeCognee()
    service = backend(fake)
    user = uid()
    await service.update_settings(user, True, CONSENT)
    await service.drain()
    service.user_erased(user)
    await service.drain()
    assert fake.deleted == [dataset_name(user)]


async def test_unavailable_without_client() -> None:
    service = backend(None)
    assert service.status() == "unavailable" and service.available is False
    with pytest.raises(MemoryServiceError) as caught:
        await service.update_settings(uid(), True, CONSENT)
    assert caught.value.code == "MEMORY_UNAVAILABLE"
    assert service.brief(dialog(uid())) == ""  # без клиента разговор идёт без памяти


async def test_changes_and_export_shapes() -> None:
    fake = FakeCognee()
    service = backend(fake)
    user = uid()
    await service.update_settings(user, True, CONSENT)
    await service.drain()
    assert await service.changes(user, "dialog-1") == {"status": "ready", "reason": None, "items": []}
    exported = await service.export(user)
    assert exported["settings"]["enabled"] is True
    assert exported["settings"]["consentVersion"] == CONSENT
    assert exported["cogneeBrief"] == fake.recall_text


def test_dataset_name_sanitized() -> None:
    user = "550e8400-e29b-41d4-a716-446655440000"
    assert dataset_name(user) == "ryadom_user_550e8400_e29b_41d4_a716_446655440000"


# ─── приложение целиком в режиме cognee ───────────────────────────────────────


def test_app_cognee_mode(monkeypatch: Any) -> None:
    """Приложение с MEMORY_BACKEND=cognee: клиент подменён фейком, диалоги в памяти, воркер и SQLite не поднимаются."""
    from tests.conftest import AUTH

    fake = FakeCognee()
    monkeypatch.setattr("app.main.build_cognee_client", lambda cfg: fake)
    settings = memory_settings(
        MEMORY_BACKEND="cognee",
        COGNEE_BASE_URL="http://cognee.test",
        COGNEE_SERVICE_EMAIL="agent-service@cognee.dev",
        COGNEE_SERVICE_PASSWORD="test-password",
    )
    with TestClient(create_app(lambda: None, lambda: (None, None), memory_settings=settings)) as client:
        assert fake.connected is True  # логин при старте
        ready = client.get("/health/ready").json()
        assert ready["memory"] == "on"
        assert ready["dialogs"] == "memory"  # диск не подключается
        user = uid()
        response = client.put(
            f"/v1/users/{user}/memory/settings", json={"enabled": True, "consentVersion": CONSENT}, headers=AUTH
        )
        assert response.status_code == 200, response.text
        assert response.json()["enabled"] is True
        memory = client.get(f"/v1/users/{user}/memory", headers=AUTH).json()
        assert memory["enabled"] is True and memory["rulesVersion"] == "cognee"
        client.delete(f"/v1/users/{user}/memory", headers=AUTH)
        assert fake.deleted == [dataset_name(user)]
        unsupported = client.patch(f"/v1/users/{user}/memory/facts/f-1", json={"text": "новое"}, headers=AUTH)
        assert unsupported.status_code == 422
        assert unsupported.json()["error"]["details"] == {"reason": "unsupported_in_cognee"}


# ─── MEMORY_DEFAULT_ENABLED: стендовый opt-out (память всем по умолчанию) ─────


def backend_default_on(fake: FakeCognee | None) -> CogneeMemoryBackend:
    return CogneeMemoryBackend(fake, memory_settings(MEMORY_BACKEND="cognee", MEMORY_DEFAULT_ENABLED="true", MEMORY_COGNIFY_SETTLE_SECONDS="0"))  # type: ignore[arg-type]


async def test_default_enabled_new_user_writes_without_dataset() -> None:
    """Без датасета и без тумблера память включена: конец диалога пишет транскрипт (датасет создаётся записью)."""
    fake = FakeCognee()
    service = backend_default_on(fake)
    user = uid()
    assert service.enabled(user) is True
    service.dialog_ended(dialog(user))
    await service.drain()
    assert fake.remembered and fake.remembered[0][1] == dataset_name(user)


async def test_default_enabled_optout_stays_off() -> None:
    """«Забыть всё» или выключение — явный отказ: default_enabled память обратно не включает."""
    fake = FakeCognee()
    service = backend_default_on(fake)
    user = uid()
    service.dialog_ended(dialog(user))
    await service.drain()
    assert fake.remembered  # до отказа писалось
    await service.forget_all(user)
    assert service.enabled(user) is False
    fake.remembered.clear()
    service.dialog_ended(dialog(user))
    await service.drain()
    assert fake.remembered == []  # после отказа — молчим, пока человек сам не включит обратно
    await service.update_settings(user, True, CONSENT)
    assert service.enabled(user) is True


async def test_default_enabled_get_memory_reports_on() -> None:
    """Экран памяти у нового человека: enabled=true, хотя датасета ещё нет."""
    fake = FakeCognee()
    service = backend_default_on(fake)
    user = uid()
    memory = await service.get_memory(user)
    await service.drain()
    assert memory["enabled"] is True and memory["rulesVersion"] == "cognee"


# ─── recall по ходу разговора: фон после реплики и инструмент модели ───────────


async def test_user_message_spawns_turn_recall_into_brief() -> None:
    """Реплика человека — фоновый recall по её тексту; находка попадает в сводку следующих ходов."""
    fake = FakeCognee()
    service = backend(fake)
    user = uid()
    await service.update_settings(user, True, CONSENT)
    await service.drain()
    fake.recalls.clear()
    fake.recall_text = "Сына зовут Матвей."  # находка по вопросу — не то же, что общая сводка
    service.user_message(dialog(user), "а помнишь, как зовут моего сына?")
    await service.drain()
    assert fake.recalls == [("а помнишь, как зовут моего сына?", dataset_name(user))]
    text = service.brief(dialog(user))
    assert "Сына зовут Матвей." in text and "По недавнему вопросу" in text


async def test_user_message_without_memory_does_not_search() -> None:
    """Память выключена — по репликам в Cognee не ходим."""
    fake = FakeCognee()
    service = backend(fake)
    user = uid()
    service.user_message(dialog(user), "привет")
    await service.drain()
    assert fake.recalls == []


async def test_recall_now_tool_flow() -> None:
    """Инструмент recall_memory: прямой recall по запросу модели, находка возвращается и оседает в сводке."""
    fake = FakeCognee()
    service = backend(fake)
    user = uid()
    await service.update_settings(user, True, CONSENT)
    await service.drain()
    fake.recalls.clear()
    assert service.recall_supported(dialog(user)) is True
    found = await service.recall_now(dialog(user), "имя сына")
    assert found == fake.recall_text
    assert fake.recalls == [("имя сына", dataset_name(user))]
    assert fake.recall_text in service.brief(dialog(user))  # и следующие ходы её видят


async def test_recall_now_unsupported_when_disabled() -> None:
    fake = FakeCognee()
    service = backend(fake)
    user = uid()
    assert service.recall_supported(dialog(user)) is False
    assert await service.recall_now(dialog(user), "что-нибудь") == ""
    assert fake.recalls == []


async def test_recall_now_reuses_the_inflight_turn_recall() -> None:
    """Модель позвала recall_memory по реплике, фоновый поиск по которой ещё идёт: второй запрос в Cognee не делается."""
    fake = FakeCognee()
    service = backend(fake)
    user = uid()
    await service.update_settings(user, True, CONSENT)
    await service.drain()
    fake.recalls.clear()
    fake.recall_gate = asyncio.Event()  # дальше любой recall ждёт гейт (после включения, иначе встанет prefetch)
    service.user_message(dialog(user), "помнишь, где я работаю?")
    await asyncio.sleep(0)  # фоновый recall ушёл в работу и ждёт гейт
    call = asyncio.create_task(service.recall_now(dialog(user), "место работы"))
    await asyncio.sleep(0.1)  # инструмент встал на ожидание фонового поиска
    fake.recall_gate.set()
    found = await call
    await service.drain()
    assert found == fake.recall_text
    assert len(fake.recalls) == 1  # один поиск на двоих: фоновый и инструмент
