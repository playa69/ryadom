"""REST заметок (PROTEUS-242, задачи 2.5 и 2.6): каждый маршрут и код ответа, лимит, чувствительное по согласию, совместимость
прежних маршрутов фактов. Приложение собрано с двойником базы диалогов; Cognee подменён фейком. Все тексты выдуманы."""

import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from tests.conftest import AUTH
from tests.fake_db import FakeDialogDatabase
from tests.test_memory_cognee_backend import FakeCognee, memory_settings

CONSENT = "2026-10-21"


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch) -> Any:
    FakeDialogDatabase.reset()
    fake = FakeCognee()
    monkeypatch.setattr("app.main.build_cognee_client", lambda cfg: fake)
    settings = memory_settings(
        COGNEE_BASE_URL="http://cognee.test",
        COGNEE_SERVICE_EMAIL="agent-service@cognee.dev",
        COGNEE_SERVICE_PASSWORD="test-password",
        MEMORY_NOTES_MAX="3",
    )
    app = create_app(
        lambda: None,
        lambda: (None, None),
        memory_settings=settings,
        database_factory=lambda: FakeDialogDatabase("notes-api"),
    )
    with TestClient(app) as test_client:
        yield test_client


def uid() -> str:
    return str(uuid.uuid4())


def base(user: str) -> str:
    return f"/v1/users/{user}/memory"


def enable(client: TestClient, user: str, **extra: Any) -> None:
    response = client.put(f"{base(user)}/settings", json={"enabled": True, "consentVersion": CONSENT, **extra}, headers=AUTH)
    assert response.status_code == 200, response.text


def add(client: TestClient, user: str, text: str, category: str = "situation") -> dict[str, Any]:
    response = client.post(f"{base(user)}/facts", json={"category": category, "text": text}, headers=AUTH)
    assert response.status_code == 201, response.text
    return response.json()


def test_get_memory_has_notes_limits_and_compatible_fields(client: TestClient) -> None:
    user = uid()
    enable(client, user)
    add(client, user, "Работает в продажах")
    memory = client.get(base(user), headers=AUTH).json()
    assert memory["enabled"] is True and memory["paused"] is False
    assert memory["sensitiveEnabled"] is False and memory["chatSearchEnabled"] is True
    assert memory["limits"]["maxNotes"] == 3 and memory["limits"]["maxFacts"] == 3  # число, не null
    assert [note["text"] for note in memory["notes"]] == ["Работает в продажах"]
    assert [fact["text"] for fact in memory["facts"]] == ["Работает в продажах"]  # прежняя форма для кэшированной PWA
    assert memory["mode"] == "on"


def test_patch_note_ok_rejected_and_not_found(client: TestClient) -> None:
    user = uid()
    enable(client, user)
    note = add(client, user, "Работает в продажах")
    ok = client.patch(f"{base(user)}/notes/{note['id']}", json={"text": "Работает в продажах уже год"}, headers=AUTH)
    assert ok.status_code == 200 and ok.json()["text"] == "Работает в продажах уже год"

    rejected = client.patch(f"{base(user)}/notes/{note['id']}", json={"text": "Принимает антидепрессанты"}, headers=AUTH)
    assert rejected.status_code == 422 and rejected.json()["error"]["code"] == "NOTE_REJECTED"
    assert rejected.json()["error"]["details"] == {"reason": "medication"}
    assert "антидепрессант" not in rejected.text  # текст заметки не возвращается в ошибке

    missing = client.patch(f"{base(user)}/notes/{uid()}", json={"text": "что-то"}, headers=AUTH)
    assert missing.status_code == 404 and missing.json()["error"]["code"] == "NOTE_NOT_FOUND"
    stranger = client.patch(f"{base(uid())}/notes/{note['id']}", json={"text": "чужая правка"}, headers=AUTH)
    assert stranger.status_code == 404  # заметка другого человека недоступна


def test_delete_note_and_delete_all_keep_settings(client: TestClient) -> None:
    user = uid()
    enable(client, user)
    first = add(client, user, "Работает в продажах")
    add(client, user, "Есть сестра Маша", "person")
    assert client.delete(f"{base(user)}/notes/{first['id']}", headers=AUTH).status_code == 204
    assert client.delete(f"{base(user)}/notes/{first['id']}", headers=AUTH).status_code == 404
    assert len(client.get(f"{base(user)}/notes", headers=AUTH).json()["notes"]) == 1

    assert client.delete(f"{base(user)}/notes", headers=AUTH).status_code == 204
    memory = client.get(base(user), headers=AUTH).json()
    assert memory["notes"] == []
    assert memory["enabled"] is True and memory["consentVersion"] == CONSENT  # настройки и согласие прежние


def test_notes_filter_by_kinds_and_since(client: TestClient) -> None:
    user = uid()
    enable(client, user)
    add(client, user, "Работает в продажах", "situation")
    add(client, user, "Есть сестра Маша", "person")
    kinds = client.get(f"{base(user)}/notes", params={"kinds": "person"}, headers=AUTH).json()["notes"]
    assert [n["kind"] for n in kinds] == ["person"]
    future = client.get(f"{base(user)}/notes", params={"since": "2999-01-01T00:00:00Z"}, headers=AUTH).json()["notes"]
    assert future == []


def test_limit_of_notes(client: TestClient) -> None:
    """2.6: на лимите новая заметка — `MEMORY_FULL`; существующие правятся и удаляются."""
    user = uid()
    enable(client, user)
    notes = [add(client, user, text) for text in ("Первая заметка", "Вторая заметка", "Третья заметка")]
    full = client.post(f"{base(user)}/facts", json={"category": "situation", "text": "Четвёртая заметка"}, headers=AUTH)
    assert full.status_code == 409 and full.json()["error"]["code"] == "MEMORY_FULL"
    edited = client.patch(f"{base(user)}/notes/{notes[0]['id']}", json={"text": "Первая заметка, уточнённая"}, headers=AUTH)
    assert edited.status_code == 200
    client.delete(f"{base(user)}/notes/{notes[1]['id']}", headers=AUTH)
    add(client, user, "Четвёртая заметка")  # место освободилось


def test_event_note_has_no_expiry(client: TestClient) -> None:
    """2.6: заметка `event` с давно прошедшей датой остаётся (срока давности нет)."""
    user = uid()
    enable(client, user)
    db = FakeDialogDatabase("notes-api")
    db.open()
    db.add_note((str(uuid.uuid4()), user, "event", "Был дедлайн по проекту", False, None, None, "2024-01-01T00:00:00Z", "2024-01-01T00:00:00Z"))
    notes = client.get(f"{base(user)}/notes", headers=AUTH).json()["notes"]
    assert [n["text"] for n in notes] == ["Был дедлайн по проекту"]


def test_sensitive_needs_consent_and_switching_off_deletes(client: TestClient) -> None:
    user = uid()
    enable(client, user)
    db = FakeDialogDatabase("notes-api")
    db.open()
    # Без согласия чувствительное не пишется (проверка в коде).
    # Прямая запись из модели идёт тем же `add`: здесь проверяем через сервис приложения.
    memory_service = client.app.state.memory
    import asyncio

    with pytest.raises(Exception) as rejected:
        asyncio.run(memory_service.notes.add(user, "wellbeing", "Плохо спит последние недели"))
    assert getattr(rejected.value, "reason", None) == "sensitive_off"

    assert client.put(f"{base(user)}/settings", json={"sensitiveEnabled": True}, headers=AUTH).json()["sensitiveEnabled"] is True
    asyncio.run(memory_service.notes.add(user, "wellbeing", "Плохо спит последние недели"))
    assert len(client.get(f"{base(user)}/notes", headers=AUTH).json()["notes"]) == 1

    client.put(f"{base(user)}/settings", json={"sensitiveEnabled": False}, headers=AUTH)
    assert client.get(f"{base(user)}/notes", headers=AUTH).json()["notes"] == []  # выключение удалило чувствительные


def test_settings_without_enabled_only_change_switches(client: TestClient) -> None:
    user = uid()
    enable(client, user)
    response = client.put(f"{base(user)}/settings", json={"chatSearchEnabled": False}, headers=AUTH)
    assert response.status_code == 200
    body = response.json()
    assert body["chatSearchEnabled"] is False and body["enabled"] is True and body["consentVersion"] == CONSENT


def test_export_has_notes_and_settings(client: TestClient) -> None:
    user = uid()
    enable(client, user)
    add(client, user, "Работает в продажах")
    exported = client.get(f"{base(user)}/export", headers=AUTH).json()
    assert [n["text"] for n in exported["notes"]] == ["Работает в продажах"]
    assert exported["settings"]["enabled"] is True


def test_legacy_routes(client: TestClient) -> None:
    user = uid()
    enable(client, user)
    note = add(client, user, "Работает в продажах")
    assert client.patch(f"{base(user)}/facts/{note['id']}", json={"status": "pinned"}, headers=AUTH).json()["error"]["code"] == "MEMORY_ACTION_UNSUPPORTED"
    assert client.get(f"{base(user)}/changes", params={"dialogId": "d-1"}, headers=AUTH).json()["status"] == "ready"
    assert client.delete(f"{base(user)}/facts/{note['id']}", headers=AUTH).status_code == 204
