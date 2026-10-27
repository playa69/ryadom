"""Извлечение заметок по ходу разговора (PROTEUS-242, задача 2.2): каденция, финальный проход, сбой модели, поле «Скажи, что
поправить», недоступность без модели. Модель фиктивная, Cognee — фейк."""

import asyncio
import json
import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.memory.cognee_backend import CogneeMemoryBackend
from app.memory.extractor import NotesExtractor
from tests.conftest import AUTH, make_app
from tests.fake_db import FakeDialogDatabase
from tests.test_memory_cognee_backend import CONSENT, FakeCognee, dialog, memory_settings, uid
from tests.test_memory_extractor import FakeModel


def build(answer: Any = None, fail: bool = False) -> tuple[CogneeMemoryBackend, FakeModel, FakeDialogDatabase]:
    FakeDialogDatabase.reset()
    db = FakeDialogDatabase("flow")
    db.open()
    service = CogneeMemoryBackend(FakeCognee(), memory_settings(), lambda: db)  # type: ignore[arg-type]
    model = FakeModel(answer, fail)
    service.set_extractor(NotesExtractor(model, service.notes))
    return service, model, db


ADD_WORK = {"ops": [{"op": "add", "kind": "situation", "text": "Работает в продажах", "quote": "работаю в продажах"}]}


async def test_pass_after_every_second_message() -> None:
    service, model, db = build(ADD_WORK)
    user = uid()
    await service.update_settings(user, True, CONSENT)
    current = dialog(user, 0)
    service.user_message(current, "Я работаю в продажах")
    await service.drain()
    assert model.seen == []  # одна реплика — модель не зовём (раз в две реплики)
    service.user_message(current, "и очень устаю")
    await service.drain()
    assert len(model.seen) == 1
    assert [row[2] for row in db.list_notes(user)] == ["Работает в продажах"]


async def test_final_pass_on_end() -> None:
    service, model, db = build(ADD_WORK)
    user = uid()
    await service.update_settings(user, True, CONSENT)
    current = dialog(user, 0)
    service.user_message(current, "Я работаю в продажах")
    service.dialog_ended(current)  # менее двух реплик: заметка появится на финальном проходе
    await service.drain()
    assert [row[2] for row in db.list_notes(user)] == ["Работает в продажах"]


async def test_model_failure_keeps_the_messages_for_the_next_pass() -> None:
    service, model, db = build(fail=True)
    user = uid()
    await service.update_settings(user, True, CONSENT)
    current = dialog(user, 0)
    service.user_message(current, "Я работаю в продажах")
    service.user_message(current, "и очень устаю")
    await service.drain()
    assert db.list_notes(user) == []
    model.fail, model.answer = False, ADD_WORK
    service.user_message(current, "вот ещё одна реплика")
    await service.drain()
    assert len(model.seen) == 2
    assert "Я работаю в продажах" in json.dumps(model.seen[-1], ensure_ascii=False)  # прежние реплики не потеряны
    assert [row[2] for row in db.list_notes(user)] == ["Работает в продажах"]


async def test_nothing_is_extracted_when_memory_is_off_or_dialog_is_unsaved() -> None:
    service, model, db = build(ADD_WORK)
    user = uid()
    current = dialog(user, 0)
    service.user_message(current, "Я работаю в продажах")
    service.user_message(current, "и очень устаю")
    service.dialog_ended(current)
    await service.drain()
    assert model.seen == []  # память не включена

    await service.update_settings(user, True, CONSENT)
    silent = dialog(user, 0)
    silent.memory_mode = "off"
    service.user_message(silent, "Я работаю в продажах")
    service.user_message(silent, "и очень устаю")
    service.dialog_ended(silent)
    await service.drain()
    assert model.seen == [] and db.list_notes(user) == []


async def test_no_extraction_without_an_extractor() -> None:
    """Нет фоновой модели (ключа прокси) — извлекателя нет, реплики никуда не уходят, разговор идёт как обычно."""
    FakeDialogDatabase.reset()
    db = FakeDialogDatabase("flow")
    db.open()
    service = CogneeMemoryBackend(FakeCognee(), memory_settings(), lambda: db)  # type: ignore[arg-type]
    user = uid()
    await service.update_settings(user, True, CONSENT)
    current = dialog(user, 0)
    service.user_message(current, "Я работаю в продажах")
    service.user_message(current, "и очень устаю")
    await service.drain()
    assert db.list_notes(user) == []


def test_instruction_route(monkeypatch: pytest.MonkeyPatch) -> None:
    FakeDialogDatabase.reset()
    monkeypatch.setattr("app.main.build_cognee_client", lambda cfg: FakeCognee())
    settings = memory_settings(
        COGNEE_BASE_URL="http://cognee.test", COGNEE_SERVICE_EMAIL="a@b.c", COGNEE_SERVICE_PASSWORD="x"
    )
    app = make_app(memory_settings=settings, database_factory=lambda: FakeDialogDatabase("flow-route"))
    user = str(uuid.uuid4())
    base = f"/v1/users/{user}/memory"
    with TestClient(app) as client:
        # модели нет (LLM_MODE не proxy): поле «Скажи, что поправить» честно отвечает «недоступно»
        client.put(f"{base}/settings", json={"enabled": True, "consentVersion": CONSENT}, headers=AUTH)
        unavailable = client.post(f"{base}/notes/instruction", json={"text": "Убери тему про отца"}, headers=AUTH)
        assert unavailable.status_code == 503 and unavailable.json()["error"]["code"] == "MEMORY_UNAVAILABLE"

        memory = app.state.memory
        note = asyncio.run(memory.notes.add(user, "boundary", "Не хочет обсуждать отца"))
        memory.set_extractor(NotesExtractor(FakeModel({"ops": [{"op": "delete", "id": note["id"], "quote": "убери тему про отца"}]}), memory.notes))
        done = client.post(f"{base}/notes/instruction", json={"text": "Убери тему про отца"}, headers=AUTH)
        assert done.status_code == 200 and done.json()["changes"]["deleted"] == [note["id"]]
        assert client.get(f"{base}/notes", headers=AUTH).json()["notes"] == []


async def test_unprocessed_messages_survive_an_agent_restart() -> None:
    """Агент перезапустился (выкат), не разобрав две реплики: новый процесс берёт курсор из базы и добирает их из диалога."""
    service, model, db = build(fail=True)
    user = uid()
    await service.update_settings(user, True, CONSENT)
    current = dialog(user, 0)
    from app.services.dialog_store import Message, now_iso

    def say(text: str) -> None:
        current.messages.append(Message(id=str(len(current.messages)), role="user", text=text, created_at=now_iso()))
        service.user_message(current, text)

    say("Я работаю в продажах")
    say("и очень устаю")
    await service.drain()
    assert db.list_notes(user) == [] and db.get_notes_cursor(current.id) == 0  # модель была недоступна, курсор не сдвинулся

    # «перезапуск»: новый бэкенд, та же база и тот же диалог с сохранёнными репликами
    restarted = CogneeMemoryBackend(FakeCognee(), memory_settings(), lambda: db)  # type: ignore[arg-type]
    model2 = FakeModel(ADD_WORK)
    restarted.set_extractor(NotesExtractor(model2, restarted.notes))
    await restarted.update_settings(user, True, CONSENT)
    current.messages.append(Message(id="2", role="user", text="вот ещё", created_at=now_iso()))
    restarted.user_message(current, "вот ещё")
    restarted.dialog_ended(current)
    await restarted.drain()
    sent = json.dumps(model2.seen, ensure_ascii=False)
    assert "Я работаю в продажах" in sent and "и очень устаю" in sent and "вот ещё" in sent
    assert [row[2] for row in db.list_notes(user)] == ["Работает в продажах"]
    assert db.get_notes_cursor(current.id) == 3  # разобрано всё


async def test_end_during_a_running_pass_does_not_extract_the_same_replies_twice() -> None:
    """Харнесс памяти нашёл: завершение при идущем проходе запускало второй проход по тем же репликам, заметки дублировались."""
    import asyncio

    gate = asyncio.Event()

    class SlowModel(FakeModel):
        async def complete(self, messages: list[dict[str, str]]) -> str:
            await gate.wait()
            return await super().complete(messages)

    service, _, db = build(ADD_WORK)
    model = SlowModel(ADD_WORK)
    service.set_extractor(NotesExtractor(model, service.notes))
    user = uid()
    await service.update_settings(user, True, CONSENT)
    current = dialog(user, 0)
    service.user_message(current, "Я работаю в продажах")
    service.user_message(current, "и очень устаю")  # второй реплики хватает для прохода: он идёт и ждёт модель
    await asyncio.sleep(0)
    service.dialog_ended(current)  # завершили, пока проход идёт
    gate.set()
    await service.drain()
    assert len(model.seen) == 1  # те же реплики модели второй раз не отдавались
    assert [row[2] for row in db.list_notes(user)] == ["Работает в продажах"]


async def test_a_note_differing_only_in_punctuation_and_yo_is_the_same_note() -> None:
    service, _, db = build()
    user = uid()
    await service.notes.add(user, "situation", "Работает менеджером, последнее время очень устаёт.")
    again = await service.notes.add(user, "situation", "Работает менеджером последнее время очень устает")
    assert len(db.list_notes(user)) == 1 and again["text"].startswith("Работает")


def test_memory_rules_forbid_inventing_the_person() -> None:
    """Живой прогон (scripts/memory_rules_check.py) показал: по памяти модель выдумывала вкусы и характер человека."""
    from app.services.replies import MEMORY_RULES

    assert "Ничего не додумывай" in MEMORY_RULES and "Оценок и черт характера не давай" in MEMORY_RULES
    assert "Если заметок нет" in MEMORY_RULES
