"""REST заметок (PROTEUS-242, задачи 2.5 и 2.6): каждый маршрут и код ответа, лимит, чувствительное по согласию, согласие на паузе.
Приложение собрано с двойником базы диалогов; Cognee подменён фейком. Все тексты выдуманы."""

import asyncio
import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.memory.errors import MemoryFull
from tests.conftest import AUTH, make_app
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
    app = make_app(memory_settings=settings, database_factory=lambda: FakeDialogDatabase("notes-api"))
    with TestClient(app) as test_client:
        yield test_client


def uid() -> str:
    return str(uuid.uuid4())


def base(user: str) -> str:
    return f"/v1/users/{user}/memory"


def enable(client: TestClient, user: str, **extra: Any) -> None:
    response = client.put(f"{base(user)}/settings", json={"enabled": True, "consentVersion": CONSENT, **extra}, headers=AUTH)
    assert response.status_code == 200, response.text


def add(client: TestClient, user: str, text: str, kind: str = "situation") -> dict[str, Any]:
    """Заметка через сервис, как её пишет извлекатель: маршрута для ручного добавления нет."""
    return asyncio.run(client.app.state.memory.notes.add(user, kind, text))  # type: ignore[no-any-return]


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


def test_limit_of_notes(client: TestClient) -> None:
    """2.6: на лимите новая заметка — `MemoryFull`; существующие правятся и удаляются."""
    user = uid()
    enable(client, user)
    notes = [add(client, user, text) for text in ("Первая заметка", "Вторая заметка", "Третья заметка")]
    with pytest.raises(MemoryFull):  # извлекатель на лимите пропускает новое; маршрута добавления у REST нет
        add(client, user, "Четвёртая заметка")
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


def test_pause_keeps_the_consent_in_every_answer(client: TestClient) -> None:
    """Пауза не отзывает согласие: его отдают ответ на выключение, GET /memory и выгрузка; «Удалить всю память» его тоже не стирает."""
    user = uid()
    enable(client, user)
    paused = client.put(f"{base(user)}/settings", json={"enabled": False}, headers=AUTH).json()
    assert paused["enabled"] is False and paused["consentVersion"] == CONSENT and paused["consentAt"]

    memory = client.get(base(user), headers=AUTH).json()
    assert memory["enabled"] is False and memory["paused"] is True
    assert memory["consentVersion"] == CONSENT and memory["consentAt"] == paused["consentAt"]
    settings = client.get(f"{base(user)}/export", headers=AUTH).json()["settings"]
    assert settings["enabled"] is False and settings["consentVersion"] == CONSENT

    assert client.delete(f"{base(user)}/notes", headers=AUTH).status_code == 204
    assert client.get(base(user), headers=AUTH).json()["consentVersion"] == CONSENT

    resumed = client.put(f"{base(user)}/settings", json={"enabled": True, "consentVersion": CONSENT}, headers=AUTH).json()
    assert resumed["enabled"] is True and resumed["consentAt"] == paused["consentAt"]  # тот же текст — прежнее принятие


def test_a_person_who_never_consented_has_no_consent(client: TestClient) -> None:
    user = uid()
    memory = client.get(base(user), headers=AUTH).json()
    assert memory["enabled"] is False and memory["consentVersion"] is None and memory["consentAt"] is None
    switched = client.put(f"{base(user)}/settings", json={"chatSearchEnabled": False}, headers=AUTH).json()
    assert switched["enabled"] is False and switched["consentVersion"] is None


def test_export_has_notes_and_settings(client: TestClient) -> None:
    user = uid()
    enable(client, user)
    add(client, user, "Работает в продажах")
    exported = client.get(f"{base(user)}/export", headers=AUTH).json()
    assert [n["text"] for n in exported["notes"]] == ["Работает в продажах"]
    assert exported["settings"]["enabled"] is True


def new_dialog(client: TestClient, user: str, **body: Any) -> str:
    response = client.post(f"/v1/users/{user}/dialogs", json=body, headers=AUTH)
    assert response.status_code in (200, 201), response.text
    return str(response.json()["dialogId"])


def changes_of(client: TestClient, user: str, dialog_id: str) -> Any:
    return client.get(f"{base(user)}/changes", params={"dialogId": dialog_id}, headers=AUTH)


def test_changes_of_a_missing_or_foreign_dialog_are_refused(client: TestClient) -> None:
    """Блок «Я запомнил»: чужой и несуществующий разговор неразличимы, оба — `404 AGENT_DIALOG_NOT_FOUND`."""
    user, stranger = uid(), uid()
    enable(client, user)
    mine = new_dialog(client, user)
    for dialog_id in (str(uuid.uuid4()), "d-1"):
        refused = changes_of(client, user, dialog_id)
        assert refused.status_code == 404 and refused.json()["error"]["code"] == "AGENT_DIALOG_NOT_FOUND"
    assert changes_of(client, stranger, mine).status_code == 404  # разговор есть, но не этого человека
    assert changes_of(client, user, mine).status_code == 200


def test_changes_are_pending_during_the_final_pass_and_then_list_the_notes_of_this_dialog(client: TestClient) -> None:
    import threading
    import time

    from app.memory.extractor import NotesExtractor
    from tests.test_memory_extractor import FakeModel

    gate = threading.Event()

    class GateModel(FakeModel):
        async def complete(self, messages: list[dict[str, str]]) -> str:
            while not gate.is_set():
                await asyncio.sleep(0.01)
            return await super().complete(messages)

    user = uid()
    enable(client, user)
    memory = client.app.state.memory
    memory.set_extractor(
        NotesExtractor(
            GateModel({"ops": [{"op": "add", "kind": "situation", "text": "Работает в продажах", "quote": "работаю в продажах"}]}),
            memory.notes,
        )
    )
    add(client, user, "Любит море")  # заметка без этого разговора в блок не попадает
    dialog_id = new_dialog(client, user)
    store = client.app.state.store
    store.add_message(store.get(user, dialog_id), "user", "Я работаю в продажах")

    assert changes_of(client, user, dialog_id).json()["status"] == "pending"  # разговор ещё идёт
    assert client.post(f"/v1/users/{user}/dialogs/{dialog_id}/end", json={}, headers=AUTH).status_code == 200
    assert changes_of(client, user, dialog_id).json() == {"status": "pending", "reason": None, "items": []}  # проход ждёт модель

    gate.set()
    deadline = time.monotonic() + 5
    answer = changes_of(client, user, dialog_id).json()
    while answer["status"] == "pending" and time.monotonic() < deadline:
        time.sleep(0.02)
        answer = changes_of(client, user, dialog_id).json()
    assert answer["status"] == "ready" and answer["reason"] is None
    assert [(item["op"], item["fact"]["text"]) for item in answer["items"]] == [("add", "Работает в продажах")]
    # «Убрать» зовёт тот же маршрут удаления заметки, что и «×»: идентификатор из блока — идентификатор заметки.
    assert client.delete(f"{base(user)}/notes/{answer['items'][0]['fact']['id']}", headers=AUTH).status_code == 204
    assert changes_of(client, user, dialog_id).json() == {"status": "ready", "reason": None, "items": []}


def test_changes_are_empty_without_memory_for_the_conversation_unsaved_and_with_memory_off(client: TestClient) -> None:
    user = uid()
    # память человека выключена: ответ `ready` и пусто
    plain = new_dialog(client, user)
    assert changes_of(client, user, plain).json() == {"status": "ready", "reason": None, "items": []}

    enable(client, user)
    store = client.app.state.store
    for body in ({"memory": "off", "new": True}, {"saved": False, "new": True}):
        dialog_id = new_dialog(client, user, **body)
        store.add_message(store.get(user, dialog_id), "user", "Я работаю в продажах")  # стартовый пустой разговор подменяется следующим
        assert client.post(f"/v1/users/{user}/dialogs/{dialog_id}/end", json={}, headers=AUTH).status_code == 200
        assert changes_of(client, user, dialog_id).json() == {"status": "ready", "reason": None, "items": []}


def test_changes_stay_and_the_old_fact_routes_are_gone(client: TestClient) -> None:
    user = uid()
    enable(client, user)
    note = add(client, user, "Работает в продажах")
    # Правят и удаляют заметку только по `/notes/{id}`; маршрутов факта (создать, править, забыть) у агента больше нет.
    assert client.post(f"{base(user)}/facts", json={"category": "situation", "text": "Новая"}, headers=AUTH).status_code == 404
    assert client.patch(f"{base(user)}/facts/{note['id']}", json={"text": "Другое"}, headers=AUTH).status_code == 404
    assert client.delete(f"{base(user)}/facts/{note['id']}", headers=AUTH).status_code == 404
    assert [n["text"] for n in client.get(f"{base(user)}/notes", headers=AUTH).json()["notes"]] == ["Работает в продажах"]


def test_export_carries_all_three_switches(client: TestClient) -> None:
    """«Настройки в файле» (задача 2.5): в выгрузке значения всех трёх переключателей, как в профиле."""
    user = uid()
    enable(client, user)
    client.put(f"{base(user)}/settings", json={"sensitiveEnabled": True, "chatSearchEnabled": False}, headers=AUTH)
    settings = client.get(f"{base(user)}/export", headers=AUTH).json()["settings"]
    assert settings["enabled"] is True and settings["sensitiveEnabled"] is True and settings["chatSearchEnabled"] is False
    assert client.get(base(user), headers=AUTH).json()["reindexing"] is False
