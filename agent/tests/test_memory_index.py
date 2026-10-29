"""Индекс прошлых разговоров в Cognee (PROTEUS-242, задачи 3.1–3.5, 4.5): переключатель поиска, удаление разговора, очередь с
повторами, недоступность Cognee, стирание аккаунта. Cognee — фейк; жёсткое удаление проверено на настоящем Cognee спайком."""

import uuid

import pytest
from fastapi.testclient import TestClient

from tests.conftest import AUTH, make_app as make_live_app
from tests.fake_db import FakeDialogDatabase
from tests.test_memory_cognee_backend import CONSENT, FakeCognee, backend, dataset_name, dialog, memory_settings, stored_dialog, uid

HUMAN = [("user", "Я работаю в продажах и люблю гулять у воды"), ("assistant", "Понимаю"), ("user", "Сестра Маша меня поддерживает")]


@pytest.fixture(autouse=True)
def no_index_delay(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.memory.cognee_backend.INDEX_DELAY_SECONDS", 0)


async def indexed(service, db, user: str) -> str:
    dialog_id = stored_dialog(db, user, HUMAN)
    current = dialog(user, 0)
    current.id = dialog_id
    service.dialog_ended(current)
    await service.drain()
    await service.outbox.tick()
    return dialog_id


async def test_turning_search_off_deletes_the_index_and_on_rebuilds_it_from_the_journal() -> None:
    fake = FakeCognee()
    service = backend(fake)
    db = service._database()
    user = uid()
    await service.update_settings(user, True, CONSENT)
    first = await indexed(service, db, user)
    second = await indexed(service, db, user)
    assert len(fake.documents[dataset_name(user)]) == 2

    await service.update_settings(user, None, None, chat_search_enabled=False)
    await service.drain()
    await service.outbox.tick()
    assert fake.deleted == [dataset_name(user)] and dataset_name(user) not in fake.documents
    assert db.get_cognee_data_id(first) is None and db.get_cognee_data_id(second) is None  # у разговоров документов больше нет
    assert (await service.get_memory(user))["notes"] == [] and (await service.get_memory(user))["chatSearchEnabled"] is False

    # разговор «Не сохранять» в пересборку не идёт
    stored_dialog(db, user, HUMAN, mode="off")
    await service.update_settings(user, None, None, chat_search_enabled=True)
    await service.drain()
    while await service.outbox.tick():  # rebuild → index_dialog по каждому разговору
        pass
    assert len(fake.documents[dataset_name(user)]) == 2
    assert db.get_cognee_data_id(first) is not None


async def test_deleting_a_dialog_removes_its_document_and_keeps_the_notes() -> None:
    fake = FakeCognee()
    service = backend(fake)
    db = service._database()
    user = uid()
    await service.update_settings(user, True, CONSENT)
    await service.notes.add(user, "person", "Есть сестра Маша")
    gone = await indexed(service, db, user)
    kept = await indexed(service, db, user)

    await service.dialog_deleting(user, gone)
    await service.drain()
    await service.outbox.tick()
    remaining = [name for name, _ in fake.documents[dataset_name(user)].values()]
    assert remaining == [f"dialog-{kept}"]
    assert [n["text"] for n in await service.notes.list(user)] == ["Есть сестра Маша"]  # заметки остаются


async def test_cognee_down_notes_work_and_index_catches_up_with_backoff() -> None:
    fake = FakeCognee()
    service = backend(fake)
    db = service._database()
    user = uid()
    await service.update_settings(user, True, CONSENT)
    fake.down = True
    dialog_id = stored_dialog(db, user, HUMAN)
    current = dialog(user, 0)
    current.id = dialog_id
    service.dialog_ended(current)
    await service.drain()
    assert await service.outbox.tick() == 0  # Cognee недоступен: операция осталась с повтором
    assert db.outbox_pending() == 1
    await service.notes.add(user, "interest", "Любит гулять у воды")  # заметки работают без Cognee
    assert len(await service.notes.list(user)) == 1

    fake.down = False
    for o in db._state().outbox:  # время повтора пришло
        o["next_at"] = "2000-01-01T00:00:00Z"
    assert await service.outbox.tick() == 1 and db.outbox_pending() == 0
    assert len(fake.documents[dataset_name(user)]) == 1


async def test_dialog_deleted_while_waiting_is_not_resurrected() -> None:
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
    db._state().dialogs.pop(dialog_id)  # разговор удалили, пока операция ждала
    await service.outbox.tick()
    assert fake.documents == {}


async def test_short_or_crisis_only_dialog_makes_no_document() -> None:
    fake = FakeCognee()
    service = backend(fake)
    db = service._database()
    user = uid()
    await service.update_settings(user, True, CONSENT)
    dialog_id = stored_dialog(db, user, [("user", "Привет"), ("assistant", "Привет!")])
    current = dialog(user, 0)
    current.id = dialog_id
    service.dialog_ended(current)
    await service.drain()
    await service.outbox.tick()
    assert fake.documents == {} and db.get_cognee_data_id(dialog_id) is None


def make_app(monkeypatch: pytest.MonkeyPatch, fake: FakeCognee):
    FakeDialogDatabase.reset()
    monkeypatch.setattr("app.main.build_cognee_client", lambda cfg: fake)
    settings = memory_settings(COGNEE_BASE_URL="http://cognee.test", COGNEE_SERVICE_EMAIL="a@b.c", COGNEE_SERVICE_PASSWORD="x")
    return make_live_app(memory_settings=settings, database_factory=lambda: FakeDialogDatabase("index-app"))


def test_delete_dialog_route(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeCognee()
    app = make_app(monkeypatch, fake)
    user = str(uuid.uuid4())
    with TestClient(app) as client:
        client.put(f"/v1/users/{user}/memory/settings", json={"enabled": True, "consentVersion": CONSENT}, headers=AUTH)
        started = client.post(f"/v1/users/{user}/dialogs", headers=AUTH).json()
        dialog_id = started["dialogId"]
        assert client.delete(f"/v1/users/{user}/dialogs/{dialog_id}", headers=AUTH).status_code == 204  # открытый тоже
        assert client.get(f"/v1/users/{user}/dialogs/{dialog_id}", headers=AUTH).status_code == 404
        assert client.delete(f"/v1/users/{user}/dialogs/{dialog_id}", headers=AUTH).status_code == 404
        stranger = client.post(f"/v1/users/{str(uuid.uuid4())}/dialogs", headers=AUTH).json()["dialogId"]
        assert client.delete(f"/v1/users/{user}/dialogs/{stranger}", headers=AUTH).status_code == 404  # чужой


def test_erase_user_waits_for_cognee_and_answers_503_when_it_is_down(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeCognee()
    app = make_app(monkeypatch, fake)
    user = str(uuid.uuid4())
    with TestClient(app) as client:
        client.put(f"/v1/users/{user}/memory/settings", json={"enabled": True, "consentVersion": CONSENT}, headers=AUTH)
        client.post(f"/v1/users/{user}/dialogs", headers=AUTH)
        fake.down = True
        refused = client.delete(f"/v1/users/{user}", headers=AUTH)
        assert refused.status_code == 503  # данные не объявлены удалёнными
        assert client.get(f"/v1/users/{user}/dialogs", headers=AUTH).json()  # диалоги на месте
        fake.down = False
        assert client.delete(f"/v1/users/{user}", headers=AUTH).status_code == 204
        assert fake.deleted == [dataset_name(user)]


# ─── удалённая заметка подавляет свою реплику в поиске (D15) ─────────────────────────────────────────────────────────


FATHER = "Не хочу говорить про отца, он меня бросил"


async def note_from_reply(service, db, user: str, dialog_id: str, reply: str, text: str = "Не хочет обсуждать отца") -> str:
    from app.memory.suppress import fingerprint

    note = await service.notes.add(user, "boundary", text, dialog_id, source_hash=fingerprint(reply))
    return note["id"]


async def test_deleting_a_note_rebuilds_the_dialog_document_without_the_source_reply() -> None:
    fake = FakeCognee()
    service = backend(fake)
    db = service._database()
    user = uid()
    await service.update_settings(user, True, CONSENT)
    dialog_id = stored_dialog(db, user, [("user", FATHER), ("assistant", "Понимаю"), ("user", "Работаю в продажах и люблю гулять"), ("user", "Сестра Маша меня поддерживает")])
    current = dialog(user, 0)
    current.id = dialog_id
    service.dialog_ended(current)
    await service.drain()
    await service.outbox.tick()
    first_id = db.get_cognee_data_id(dialog_id)
    assert FATHER in next(iter(fake.documents[dataset_name(user)].values()))[1]
    note_id = await note_from_reply(service, db, user, dialog_id, FATHER)

    await service.notes.delete(user, note_id)
    await service.drain()
    while await service.outbox.tick():
        pass

    documents = fake.documents[dataset_name(user)]
    assert first_id not in documents and len(documents) == 1  # старый удалён, новый собран
    assert "отца" not in next(iter(documents.values()))[1] and "гулять" in next(iter(documents.values()))[1]
    assert db.get_cognee_data_id(dialog_id) not in (None, first_id)


async def test_found_chunks_hide_the_reply_of_a_deleted_note_before_the_document_is_rebuilt() -> None:
    fake = FakeCognee(recall_text=f"Реплики человека в разговоре от 2026-10-20:\n- {FATHER}\n- Работаю в продажах")
    service = backend(fake)
    db = service._database()
    user = uid()
    await service.update_settings(user, True, CONSENT)
    dialog_id = stored_dialog(db, user, [("user", FATHER)])
    note_id = await note_from_reply(service, db, user, dialog_id, FATHER)
    current = dialog(user, 0)

    assert FATHER in await service._visible(user, fake.recall_text)  # заметка жива: реплика находится
    await service.notes.delete(user, note_id)
    seen = await service._visible(user, fake.recall_text)
    assert FATHER not in seen and "продажах" in seen


async def test_clearing_all_notes_and_editing_one_suppress_their_sources_too() -> None:
    service = backend(FakeCognee())
    db = service._database()
    user = uid()
    first = await note_from_reply(service, db, user, "d1", "У меня есть кот Барсик", "Живёт с котом Барсиком")
    await note_from_reply(service, db, user, "d2", "Работаю в продажах", "Работает в продажах")
    from app.memory.suppress import fingerprint

    await service.notes.patch(user, first, "Живёт с кошкой Муськой")
    assert db.suppressed_hashes(user) == {fingerprint("У меня есть кот Барсик")}
    await service.notes.delete_all(user)
    assert db.suppressed_hashes(user) == {fingerprint("У меня есть кот Барсик"), fingerprint("Работаю в продажах")}
    db.erase_user(user)
    assert db.suppressed_hashes(user) == set()  # отпечатки уходят вместе с аккаунтом


def test_document_leaves_out_what_notes_never_keep() -> None:
    """Харнесс памяти нашёл: диагноз, лекарства и «лучше бы меня не было» шли в индекс дословно, хотя заметкой стать не могли."""
    from app.memory.indexer import build_document

    messages = [
        ("user", "Мне поставили диагноз депрессия, пью антидепрессанты по утрам."),
        ("user", "Иногда думаю, что лучше бы меня не было."),
        ("user", "Номер карты 4276 1234 5678 9012."),
        ("user", "Работаю дизайнером, это нравится."),
        ("user", "Люблю гулять у воды по вечерам."),
    ]
    document = build_document("2026-10-20T10:00:00Z", messages) or ""
    assert "дизайнером" in document and "гулять" in document
    assert not any(word in document for word in ("диагноз", "антидепрессант", "не было", "карта", "4276"))


def test_document_leaves_out_requests_to_forget_or_correct() -> None:
    """Харнесс памяти нашёл: «Забудь, что я говорил про отца» попадало в индекс и возвращало тему, которую просили убрать."""
    from app.memory.indexer import build_document

    messages = [
        ("user", "Хочу поговорить про отпуск, давно не отдыхал."),
        ("user", "Поправь, пожалуйста: у меня не кот, а кошка Муська."),
        ("user", "Забудь, что я говорил про отца."),
        ("user", "Люблю гулять у воды по вечерам."),
    ]
    document = build_document("2026-10-20T10:00:00Z", messages) or ""
    assert "отпуск" in document and "гулять" in document
    assert "отца" not in document and "Поправь" not in document
