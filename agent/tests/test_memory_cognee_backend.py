"""Бэкенд памяти на Cognee: согласие = датасет, запись транскрипта, сводка из prefetch-кэша.

Cognee API мокается двумя способами: клиент (`CogneeClient`) — через `httpx.MockTransport` (логин, 401, 404 поиска),
бэкенд (`CogneeMemoryBackend`) — подменой клиента фейком. Сеть не используется.
"""

import asyncio
import json
import time
import uuid
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from app.clients.cognee import CogneeClient
from app.memory.cognee_backend import CogneeMemoryBackend, dataset_name
from app.memory.errors import MemoryServiceError, MemoryValidation
from app.services.dialog_store import Dialog, Message, now_iso
from tests.fake_db import FakeDialogDatabase
from app.core.config import MemorySettings


def memory_settings(**values: object) -> MemorySettings:
    """Настройки памяти для теста (без чтения окружения), без чтения окружения."""
    return MemorySettings(**values)  # type: ignore[arg-type]

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
        self.consent_reads = 0  # сколько раз бэкенд ходил в Cognee за зерном согласия
        self.remembered: list[tuple[str, str]] = []
        self.recalls: list[tuple[str, str]] = []
        self.deleted: list[str] = []
        self.cognified: list[str] = []
        self.recall_text = recall_text
        self.documents: dict[str, dict[str, tuple[str, str]]] = {}  # dataset -> data_id -> (name, text)
        self.down = False  # Cognee недоступен: add/delete бросают ошибку
        self.recall_gate: asyncio.Event | None = None  # если задан, recall ждёт его (управление моментом prefetch)

    async def connect(self) -> None:
        self.connected = True

    async def add(self, text: str, dataset: str) -> None:
        """Документ в датасет без графа; в `remembered` попадает так же, как через remember."""
        self.remembered.append((text, dataset))
        self.datasets.add(dataset)
        if text.startswith("CONSENT memory"):
            self.consents[dataset] = text

    async def cognify(self, dataset: str) -> None:
        self.cognified.append(dataset)

    async def remember(self, text: str, dataset: str) -> None:
        await self.add(text, dataset)
        await self.cognify(dataset)

    async def recall(self, query: str, dataset: str) -> str:
        self.recalls.append((query, dataset))
        if self.recall_gate is not None:
            await self.recall_gate.wait()
        return self.recall_text

    async def recall_chunks(self, query: str, dataset: str) -> str:
        self.recalls.append((query, dataset))
        if self.recall_gate is not None:
            await self.recall_gate.wait()
        return self.recall_text

    async def add_document(self, text: str, dataset: str, name: str) -> str | None:
        if self.down:
            raise RuntimeError("cognee down")
        data_id = str(uuid.uuid4())
        self.documents.setdefault(dataset, {})[data_id] = (name, text)
        self.datasets.add(dataset)
        return data_id

    async def delete_document(self, dataset: str, data_id: str | None = None, name: str | None = None) -> bool:
        if self.down:
            raise RuntimeError("cognee down")
        docs = self.documents.get(dataset, {})
        if data_id is None and name is not None:
            data_id = next((key for key, (doc_name, _) in docs.items() if doc_name == name), None)
        return docs.pop(data_id, None) is not None if data_id else False

    async def read_consent(self, dataset: str) -> str:
        self.consent_reads += 1
        return self.consents.get(dataset, "")

    async def dataset_exists(self, dataset: str) -> bool:
        return dataset in self.datasets

    async def forget_dataset(self, dataset: str) -> bool:
        if self.down:
            raise RuntimeError("cognee down")
        self.deleted.append(dataset)
        self.documents.pop(dataset, None)
        self.datasets.discard(dataset)
        self.consents.pop(dataset, None)
        return True

    async def aclose(self) -> None:
        return None


def backend(fake: FakeCognee | None) -> CogneeMemoryBackend:
    """Бэкенд с двойником базы диалогов: настройки и заметки живут в базе (как в проде)."""
    FakeDialogDatabase.reset()
    db = FakeDialogDatabase("tests-backend")
    db.open()
    return CogneeMemoryBackend(fake, memory_settings(), lambda: db)  # type: ignore[arg-type]


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


async def test_update_settings_on_records_consent_without_cognee() -> None:
    """Включение памяти пишет согласие в настройки (база агента). Cognee для этого не нужен: заметки работают и без него."""
    fake = FakeCognee()
    service = backend(fake)
    user = uid()
    result = await service.update_settings(user, True, CONSENT)
    await service.drain()
    assert result["enabled"] is True and result["consentVersion"] == CONSENT
    assert fake.remembered == [] and fake.documents == {} and fake.deleted == []  # ни одного вызова в Cognee
    assert service.enabled(user) is True
    memory = await service.get_memory(user)
    assert memory["enabled"] is True and memory["consentVersion"] == CONSENT
    assert memory["rulesVersion"] == "notes-1" and memory["facts"] == []


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


def stored_dialog(
    db: FakeDialogDatabase, user: str, lines: list[tuple[str, str]], mode: str = "on", ended: bool = True, saved: bool = True
) -> str:
    """Разговор в двойнике базы: (id, user, started, ended, ..., memory_mode), сообщения по порядку."""
    dialog_id = str(uuid.uuid4())
    state = db._state()
    state.dialogs[dialog_id] = (dialog_id, user, "2026-10-20T10:00:00Z", "2026-10-20T10:05:00Z" if ended else None, None, None, "male", 0, mode, 0, saved)
    for position, (role, text) in enumerate(lines):
        state.messages[(dialog_id, str(position))] = (str(position), dialog_id, position, role, text, "2026-10-20T10:00:00Z", None)
    return dialog_id


async def test_dialog_ended_indexes_only_human_lines_without_pii_and_crisis(monkeypatch: pytest.MonkeyPatch) -> None:
    """Один документ на разговор: реплики человека без реплик агента, ПДн замаскированы, кризисные реплики не попадают."""
    monkeypatch.setattr("app.memory.cognee_backend.INDEX_DELAY_SECONDS", 0)
    fake = FakeCognee()
    service = backend(fake)
    db = service._database()
    user = uid()
    await service.update_settings(user, True, CONSENT)
    dialog_id = stored_dialog(
        db,
        user,
        [
            ("assistant", "Расскажи, что случилось"),
            ("user", "Я работаю в продажах, мой телефон +7 999 123 45 67"),
            ("assistant", "Понимаю"),
            ("user", "Иногда мне кажется, что я не хочу жить"),
            ("user", "Сестра Маша меня поддерживает"),
        ],
    )
    current = dialog(user, 0)
    current.id = dialog_id
    service.dialog_ended(current)
    await service.drain()
    assert await service.outbox.tick() == 1
    (name, text), = fake.documents[dataset_name(user)].values()
    assert name == f"dialog-{dialog_id}"
    assert "работаю в продажах" in text and "Сестра Маша" in text
    assert "123" not in text and "[телефон]" in text  # ПДн замаскированы
    assert "не хочу жить" not in text  # кризисная реплика не в индексе
    assert "Расскажи" not in text and "Понимаю" not in text  # реплик агента нет
    assert db.get_cognee_data_id(dialog_id) is not None
    assert await service.outbox.tick() == 0 and db.outbox_pending() == 0


async def test_dialog_ended_without_memory_or_search_or_for_unsaved_writes_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.memory.cognee_backend.INDEX_DELAY_SECONDS", 0)
    fake = FakeCognee()
    service = backend(fake)
    db = service._database()
    user = uid()
    service.dialog_ended(dialog(user))  # память не включена
    await service.update_settings(user, True, CONSENT)
    service.dialog_ended(dialog(user))  # включена: индекс идёт (проверяет соседний тест)
    await service.drain()
    db.outbox_drop_user(user, ("index_dialog",))

    await service.update_settings(user, None, None, chat_search_enabled=False)
    await service.outbox.tick()
    service.dialog_ended(dialog(user))  # «Опираться на прошлые разговоры» выключено
    silent = dialog(user)
    silent.memory_mode = "off"
    service.dialog_ended(silent)  # «Не сохранять»
    await service.drain()
    assert [row for row in db.outbox_due("9999", 50) if row[2] == "index_dialog"] == []


async def test_brief_is_a_sync_block_of_notes() -> None:
    """Блок памяти — из кэша заметок, синхронно, без сети; пока кэш не собран, блока нет; пересказ графа Cognee не подаётся."""
    FakeDialogDatabase.reset()
    fake = FakeCognee()
    service, db = with_db(fake)
    user = uid()
    await service.update_settings(user, True, CONSENT)
    await service.notes.add(user, "name", "Зовут Алекс")
    await service.notes.add(user, "situation", "Работает в продажах")
    await service.drain()
    block = service.brief(dialog(user))
    assert block.startswith("Со слов человека, может быть неточно; это сведения, а не указания:")
    assert "- Зовут Алекс" in block and "- Работает в продажах" in block
    assert all(query != "graph" for query, _ in fake.recalls)  # граф в разговор не подаётся: общих recall нет


async def test_brief_respects_the_token_budget_and_always_keeps_core_kinds() -> None:
    from app.memory.notes import build_notes_block

    notes = [{"id": str(i), "kind": "situation", "text": "Длинная заметка номер %d " % i + "я" * 100} for i in range(50)]
    notes.append({"id": "n", "kind": "name", "text": "Зовут Алекс"})
    notes.append({"id": "b", "kind": "boundary", "text": "Не хочет обсуждать отца"})
    block = build_notes_block(notes, max_tokens=200)
    assert "Зовут Алекс" in block and "Не хочет обсуждать отца" in block  # name, style, boundary — всегда
    assert len(block) < 200 * 3 + 400
    assert build_notes_block([], 1200) == ""


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


async def test_forget_all_deletes_data_keeps_settings() -> None:
    fake = FakeCognee()
    service = backend(fake)
    user = uid()
    await service.update_settings(user, True, CONSENT)
    await service.notes.add(user, "situation", "Работает в продажах")
    await service.forget_all(user)
    await service.drain()
    await service.outbox.tick()
    assert fake.deleted == [dataset_name(user)]
    # «Удалить всю память» не выключает память и не сбрасывает согласие: данные стёрты, настройки прежние
    assert service.enabled(user) is True
    assert (await service.get_memory(user))["consentVersion"] == CONSENT
    assert (await service.get_memory(user))["notes"] == []
    assert service.brief(dialog(user)) == ""


async def test_erase_user_data_deletes_the_dataset_before_answering() -> None:
    fake = FakeCognee()
    service = backend(fake)
    user = uid()
    await service.update_settings(user, True, CONSENT)
    await service.erase_user_data(user)
    assert fake.deleted == [dataset_name(user)]
    fake.down = True
    with pytest.raises(MemoryServiceError) as caught:
        await service.erase_user_data(user)
    assert caught.value.code == "MEMORY_UNAVAILABLE"  # агент ответит 503, аккаунт не трогается


async def test_unavailable_without_client_and_without_database() -> None:
    service = backend(None)
    assert service.status() == "unavailable" and service.available is False
    assert service.brief(dialog(uid())) == ""  # без клиента разговор идёт без индекса
    no_db = CogneeMemoryBackend(FakeCognee(), memory_settings())  # type: ignore[arg-type]
    with pytest.raises(MemoryServiceError) as caught:
        await no_db.update_settings(uid(), True, CONSENT)
    assert caught.value.code == "MEMORY_UNAVAILABLE"  # без базы агента заметки и согласие хранить негде


async def test_changes_and_export_shapes() -> None:
    fake = FakeCognee()
    service = backend(fake)
    user = uid()
    await service.update_settings(user, True, CONSENT)
    await service.drain()
    assert await service.changes(dialog(user, 0)) == {"status": "ready", "reason": None, "items": []}  # заметок из разговора нет
    exported = await service.export(user)
    assert exported["settings"]["enabled"] is True
    assert exported["settings"]["consentVersion"] == CONSENT


def test_dataset_name_sanitized() -> None:
    user = "550e8400-e29b-41d4-a716-446655440000"
    assert dataset_name(user) == "ryadom_user_550e8400_e29b_41d4_a716_446655440000"


# ─── приложение целиком в режиме cognee ───────────────────────────────────────


def test_app_cognee_mode(monkeypatch: Any) -> None:
    """Приложение с памятью Cognee: клиент подменён фейком, диалоги в памяти процесса."""
    from tests.conftest import AUTH, make_app

    fake = FakeCognee()
    monkeypatch.setattr("app.main.build_cognee_client", lambda cfg: fake)
    settings = memory_settings(
        COGNEE_BASE_URL="http://cognee.test",
        COGNEE_SERVICE_EMAIL="agent-service@cognee.dev",
        COGNEE_SERVICE_PASSWORD="test-password",
    )
    FakeDialogDatabase.reset()
    app = make_app(memory_settings=settings, database_factory=lambda: FakeDialogDatabase("app-cognee"))
    with TestClient(app) as client:
        assert fake.connected is True  # логин при старте
        ready = client.get("/health/ready").json()
        assert ready["memory"] == "on"
        assert ready["dialogs"] == "fake"  # база диалогов подключена (двойник)
        user = uid()
        response = client.put(
            f"/v1/users/{user}/memory/settings", json={"enabled": True, "consentVersion": CONSENT}, headers=AUTH
        )
        assert response.status_code == 200, response.text
        assert response.json()["enabled"] is True
        memory = client.get(f"/v1/users/{user}/memory", headers=AUTH).json()
        assert memory["enabled"] is True and memory["rulesVersion"] == "notes-1"
        client.delete(f"/v1/users/{user}/memory", headers=AUTH)
        for _ in range(100):  # индекс в Cognee удаляется через очередь, в фоне
            if fake.deleted:
                break
            time.sleep(0.05)
        assert fake.deleted == [dataset_name(user)]


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
    assert "Сына зовут Матвей." in text and "Из прошлых разговоров" in text


async def test_user_message_without_memory_does_not_search() -> None:
    """Память выключена — по репликам в Cognee не ходим."""
    fake = FakeCognee()
    service = backend(fake)
    user = uid()
    service.user_message(dialog(user), "привет")
    await service.drain()
    assert fake.recalls == []


# ─── настройки памяти в базе: пауза и согласие переживают перезапуск (PROTEUS-242, 0.4) ─────


def with_db(fake: FakeCognee, path: str = "mem-settings") -> tuple[CogneeMemoryBackend, FakeDialogDatabase]:
    db = FakeDialogDatabase(path)
    db.open()
    return CogneeMemoryBackend(fake, memory_settings(), lambda: db), db  # type: ignore[arg-type]


async def test_pause_survives_restart() -> None:
    """Выключили память, агент перезапустился (новый бэкенд, тот же датасет в Cognee): память остаётся выключенной."""
    FakeDialogDatabase.reset()
    fake = FakeCognee()
    user = uid()
    service, db = with_db(fake)
    await service.update_settings(user, True, CONSENT)
    await service.update_settings(user, False, None)
    assert fake.deleted == []  # данные на месте, пауза ничего не стирает

    restarted = CogneeMemoryBackend(fake, memory_settings(), lambda: db)  # type: ignore[arg-type]
    assert (await restarted.get_memory(user))["enabled"] is False
    assert restarted.enabled(user) is False


async def test_enabled_with_consent_survives_restart() -> None:
    FakeDialogDatabase.reset()
    fake = FakeCognee()
    user = uid()
    service, db = with_db(fake)
    await service.update_settings(user, True, CONSENT)
    await service.drain()

    restarted = CogneeMemoryBackend(fake, memory_settings(), lambda: db)  # type: ignore[arg-type]
    memory = await restarted.get_memory(user)
    assert memory["enabled"] is True and memory["consentVersion"] == CONSENT


async def test_pause_keeps_the_consent_visible_everywhere() -> None:
    """Пауза не отзывает согласие: ответ на выключение, GET /memory и выгрузка отдают версию и дату, в том числе после перезапуска."""
    FakeDialogDatabase.reset()
    fake = FakeCognee()
    user = uid()
    service, db = with_db(fake)
    enabled = await service.update_settings(user, True, CONSENT)
    paused = await service.update_settings(user, False, None)
    assert paused["enabled"] is False
    assert paused["consentVersion"] == CONSENT and paused["consentAt"] == enabled["consentAt"]

    memory = await service.get_memory(user)
    assert memory["enabled"] is False and memory["paused"] is True
    assert memory["consentVersion"] == CONSENT and memory["consentAt"] == enabled["consentAt"]
    settings = (await service.export(user))["settings"]
    assert settings["enabled"] is False and settings["consentVersion"] == CONSENT and settings["consentAt"] == enabled["consentAt"]

    restarted = CogneeMemoryBackend(fake, memory_settings(), lambda: db)  # type: ignore[arg-type]
    again = await restarted.get_memory(user)
    assert again["enabled"] is False and again["consentVersion"] == CONSENT and again["consentAt"] == enabled["consentAt"]
    assert (await restarted.export(user))["settings"]["consentVersion"] == CONSENT
    assert fake.consent_reads == 0  # решение человека берётся из строки настроек, зерно в Cognee не читается


async def test_settings_change_on_pause_answers_with_the_consent() -> None:
    """Переключатели на паузе: ответ тоже несёт сохранённое согласие, а не пустое."""
    FakeDialogDatabase.reset()
    user = uid()
    service, _ = with_db(FakeCognee())
    await service.update_settings(user, True, CONSENT)
    await service.update_settings(user, False, None)
    answer = await service.update_settings(user, None, None, chat_search_enabled=False)
    assert answer["enabled"] is False and answer["consentVersion"] == CONSENT and answer["consentAt"] is not None


async def test_resume_with_the_same_text_keeps_the_first_acceptance() -> None:
    """Включение с паузы под тем же текстом не новое согласие: дата первого принятия прежняя; новый текст — новая дата."""
    FakeDialogDatabase.reset()
    user = uid()
    service, db = with_db(FakeCognee())
    first = await service.update_settings(user, True, CONSENT)
    await service.update_settings(user, False, None)
    await asyncio.sleep(0.01)  # дата в миллисекундах: без паузы «новая» могла бы совпасть
    resumed = await service.update_settings(user, True, CONSENT)
    assert resumed["consentVersion"] == CONSENT and resumed["consentAt"] == first["consentAt"]
    assert db.get_memory_settings(user) == (True, CONSENT, first["consentAt"])

    await service.update_settings(user, False, None)
    await asyncio.sleep(0.01)
    renewed = await service.update_settings(user, True, "2026-11-01")
    assert renewed["consentVersion"] == "2026-11-01" and renewed["consentAt"] != first["consentAt"]
    assert (await service.get_memory(user))["consentVersion"] == "2026-11-01"


async def test_consent_stays_empty_when_it_was_never_given() -> None:
    """Согласия не было ни разу (человек только тронул переключатель или не трогал ничего): null и на паузе, в Cognee не ходим."""
    FakeDialogDatabase.reset()
    fake = FakeCognee()
    service, db = with_db(fake)
    fresh, toggled = uid(), uid()
    memory = await service.get_memory(fresh)
    assert memory["enabled"] is False and memory["consentVersion"] is None and memory["consentAt"] is None

    await service.update_settings(toggled, None, None, chat_search_enabled=False)
    assert db.get_memory_settings(toggled) == (False, None, None)
    memory = await service.get_memory(toggled)
    assert memory["enabled"] is False and memory["consentVersion"] is None and memory["consentAt"] is None
    assert (await service.export(toggled))["settings"]["consentVersion"] is None
    assert fake.consent_reads == 0


async def test_forget_all_keeps_pause_and_consent_in_db() -> None:
    """«Забыть всё» на паузе: данные стёрты, пауза и согласие в базе прежние, после перезапуска тоже."""
    FakeDialogDatabase.reset()
    fake = FakeCognee()
    user = uid()
    service, db = with_db(fake)
    await service.update_settings(user, True, CONSENT)
    await service.update_settings(user, False, None)
    await service.forget_all(user)
    await service.outbox.tick()
    assert fake.deleted == [dataset_name(user)]

    restarted = CogneeMemoryBackend(fake, memory_settings(), lambda: db)  # type: ignore[arg-type]
    after = await restarted.get_memory(user)
    assert after["enabled"] is False and after["consentVersion"] == CONSENT
    assert db.get_memory_settings(user) == (False, CONSENT, db.get_memory_settings(user)[2])  # type: ignore[index]


async def test_settings_write_failure_is_not_silent() -> None:
    """Не записалось в базу — человеку не говорим «выключено»: после перезапуска память включилась бы обратно."""
    FakeDialogDatabase.reset()
    fake = FakeCognee()
    user = uid()
    service, db = with_db(fake)
    await service.update_settings(user, True, CONSENT)

    def broken(*args: Any) -> None:
        raise RuntimeError("db down")

    db.put_memory_settings = broken  # type: ignore[method-assign]
    with pytest.raises(MemoryServiceError):
        await service.update_settings(user, False, None)
    assert service.enabled(user) is True  # состояние не изменилось


async def test_erase_user_removes_settings() -> None:
    FakeDialogDatabase.reset()
    fake = FakeCognee()
    user = uid()
    service, db = with_db(fake)
    await service.update_settings(user, True, CONSENT)
    db.erase_user(user)
    assert db.get_memory_settings(user) is None
