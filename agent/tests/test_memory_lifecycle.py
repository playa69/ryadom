"""Удаление и память одной моделью (агент 0.8.8 + заметки PROTEUS-242): разговор удаляется мягко, его документ в Cognee — через
очередь; метки `memory_deletions` агента 0.8.8 один раз уходят в очередь; прежняя память без строки настроек не выключается
переключателями и «Удалить всю память»; блок памяти готов до первого ответа модели. Cognee — фейк, база — двойник."""

import uuid

import pytest
from fastapi.testclient import TestClient

from app.memory.cognee_backend import CogneeMemoryBackend
from tests.conftest import AUTH
from tests.fake_db import FakeDialogDatabase, _File
from tests.test_memory_cognee_backend import CONSENT, FakeCognee, backend, dataset_name, dialog, memory_settings, stored_dialog, uid
from tests.test_memory_index import HUMAN, indexed, make_app

LEGACY_CONSENT = "CONSENT memory v2026-10-01 2026-10-02T10:00:00.000Z"


@pytest.fixture(autouse=True)
def no_index_delay(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.memory.cognee_backend.INDEX_DELAY_SECONDS", 0)


def documents(fake: FakeCognee, user: str) -> list[str]:
    return sorted(name for name, _ in fake.documents.get(dataset_name(user), {}).values())


async def test_soft_deleted_dialog_leaves_the_index_and_is_not_rebuilt() -> None:
    fake = FakeCognee()
    service = backend(fake)
    db = service._database()
    user = uid()
    await service.update_settings(user, True, CONSENT)
    gone = await indexed(service, db, user)
    kept = await indexed(service, db, user)

    await service.dialog_deleting(user, gone)  # как DialogStore.delete_dialog: сначала очередь, потом мягкое удаление
    db.delete_dialog(user, gone, False)
    await service.drain()
    await service.outbox.tick()
    assert documents(fake, user) == [f"dialog-{kept}"]
    assert gone in db._state().dialogs  # строка осталась с пометкой до физической очистки
    assert db.dialog_for_index(gone) is None and db.indexable_dialog_ids(user) == [kept]

    # Пересборка индекса (поиск выключили и включили) мягко удалённый разговор не возвращает.
    await service.update_settings(user, None, None, chat_search_enabled=False)
    await service.drain()
    await service.outbox.tick()
    await service.update_settings(user, None, None, chat_search_enabled=True)
    await service.drain()
    while await service.outbox.tick():
        pass
    assert documents(fake, user) == [f"dialog-{kept}"]


async def test_index_operation_waiting_for_a_soft_deleted_dialog_does_not_resurrect_it() -> None:
    fake = FakeCognee()
    service = backend(fake)
    db = service._database()
    user = uid()
    await service.update_settings(user, True, CONSENT)
    dialog_id = stored_dialog(db, user, HUMAN)
    current = dialog(user, 0)
    current.id = dialog_id
    service.dialog_ended(current)
    await service.drain()
    db.delete_dialog(user, dialog_id, False)  # мягко, пока операция ждала
    await service.outbox.tick()
    assert fake.documents == {}


async def test_marks_of_0_8_8_move_to_the_outbox_once_and_keep_memory_off() -> None:
    FakeDialogDatabase.reset()
    forgot, erased = uid(), uid()
    state = _File()
    state.memory_deletions = {forgot: "2026-10-25T10:00:00.000Z", erased: "2026-10-26T10:00:00.000Z"}
    FakeDialogDatabase._files["marks"] = state
    db = FakeDialogDatabase("marks")
    db.open()
    assert state.memory_deletions == {}
    assert sorted((o["user_id"], o["op"]) for o in state.outbox) == sorted([(forgot, "delete_dataset"), (erased, "delete_dataset")])
    assert db.get_memory_settings(forgot) == (False, None, None)
    FakeDialogDatabase("marks").open()  # повторное открытие ничего не добавляет
    assert len(state.outbox) == 2

    fake = FakeCognee()
    fake.datasets.add(dataset_name(forgot))  # при 0.8.8 «забыть всё» датасет не удаляло
    fake.consents[dataset_name(forgot)] = LEGACY_CONSENT
    service = CogneeMemoryBackend(fake, memory_settings(), lambda: db)  # type: ignore[arg-type]
    assert (await service.get_memory(forgot))["enabled"] is False  # датасет ещё есть, но память выключена, как была
    assert await service.outbox.tick() == 2
    assert dataset_name(forgot) in fake.deleted and not await fake.dataset_exists(dataset_name(forgot))
    assert state.outbox == []


async def test_legacy_memory_without_a_settings_row_survives_switches_and_forget_all() -> None:
    fake = FakeCognee()
    service = backend(fake)
    db = service._database()
    switched, forgotten = uid(), uid()
    for user in (switched, forgotten):
        fake.datasets.add(dataset_name(user))  # память включали при 0.8.x: только датасет с зерном согласия
        fake.consents[dataset_name(user)] = LEGACY_CONSENT

    await service.update_settings(switched, None, None, chat_search_enabled=False)
    assert db.get_memory_settings(switched) == (True, "2026-10-01", "2026-10-02T10:00:00.000Z")
    await service.forget_all(forgotten)
    await service.drain()
    await service.outbox.tick()
    assert dataset_name(forgotten) in fake.deleted

    restarted = CogneeMemoryBackend(fake, memory_settings(), lambda: db)  # type: ignore[arg-type]
    for user in (switched, forgotten):
        assert (await restarted.get_memory(user))["enabled"] is True  # ни переключатель, ни удаление памяти её не выключили


async def test_prepare_loads_the_notes_before_the_first_answer() -> None:
    fake = FakeCognee()
    service = backend(fake)
    db = service._database()
    user = uid()
    await service.update_settings(user, True, CONSENT)
    await service.notes.add(user, "person", "Есть сестра Маша")

    restarted = CogneeMemoryBackend(fake, memory_settings(), lambda: db)  # type: ignore[arg-type]
    current = dialog(user, 1)
    await restarted.prepare(current)
    assert "Есть сестра Маша" in restarted.brief(current)


async def test_found_chunks_leave_out_consent_seeds_of_old_datasets() -> None:
    fake = FakeCognee(recall_text=f"{LEGACY_CONSENT}\nЛюблю гулять у воды")
    service = backend(fake)
    user = uid()
    await service.update_settings(user, True, CONSENT)
    current = dialog(user, 1)
    service.user_message(current, "что я люблю")  # фоновый поиск по реплике: находка ложится в сводку
    await service.drain()
    brief = service.brief(current)
    assert "Люблю гулять у воды" in brief and LEGACY_CONSENT not in brief


def test_delete_route_soft_deletes_and_queues_the_document(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeCognee()
    fake.down = True  # операция остаётся в очереди: видно, что она поставлена
    app = make_app(monkeypatch, fake)
    user = str(uuid.uuid4())
    with TestClient(app) as client:
        client.put(f"/v1/users/{user}/memory/settings", json={"enabled": True, "consentVersion": CONSENT}, headers=AUTH)
        dialog_id = client.post(f"/v1/users/{user}/dialogs", headers=AUTH).json()["dialogId"]
        assert client.delete(f"/v1/users/{user}/dialogs/{dialog_id}", headers=AUTH).status_code == 204  # открытый тоже
        assert client.get(f"/v1/users/{user}/dialogs/{dialog_id}", headers=AUTH).status_code == 404
        state = FakeDialogDatabase._files["index-app"]
        assert dialog_id not in state.dialogs or dialog_id in state.deleted_dialogs  # если строка успела записаться — с пометкой
        assert [(o["op"], o["payload"]["dialog_id"]) for o in state.outbox] == [("delete_document", dialog_id)]
