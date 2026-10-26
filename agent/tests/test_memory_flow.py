"""Извлечение заметок по ходу разговора (PROTEUS-242, задача 2.2): каденция, финальный проход, сбой модели, поле «Скажи, что
поправить», недоступность без модели. Модель фиктивная, Cognee — фейк."""

import json
import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.memory.cognee_backend import CogneeMemoryBackend
from app.memory.extractor import NotesExtractor
from tests.conftest import AUTH
from tests.fake_db import FakeDialogDatabase
from tests.test_memory_cognee_backend import CONSENT, FakeCognee, dialog, memory_settings, uid
from tests.test_memory_extractor import FakeModel


def build(answer: Any = None, fail: bool = False) -> tuple[CogneeMemoryBackend, FakeModel, FakeDialogDatabase]:
    FakeDialogDatabase.reset()
    db = FakeDialogDatabase("flow")
    db.open()
    service = CogneeMemoryBackend(FakeCognee(), memory_settings(MEMORY_NOTES_ENABLED="true"), lambda: db)  # type: ignore[arg-type]
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


async def test_no_extraction_without_the_flag() -> None:
    FakeDialogDatabase.reset()
    db = FakeDialogDatabase("flow")
    db.open()
    service = CogneeMemoryBackend(FakeCognee(), memory_settings(), lambda: db)  # type: ignore[arg-type]
    model = FakeModel(ADD_WORK)
    service.set_extractor(NotesExtractor(model, service.notes))
    user = uid()
    await service.update_settings(user, True, CONSENT)
    current = dialog(user, 0)
    service.user_message(current, "Я работаю в продажах")
    service.user_message(current, "и очень устаю")
    await service.drain()
    assert model.seen == []  # MEMORY_NOTES_ENABLED выключен (выкат за флагом)


def test_instruction_route(monkeypatch: pytest.MonkeyPatch) -> None:
    FakeDialogDatabase.reset()
    monkeypatch.setattr("app.main.build_cognee_client", lambda cfg: FakeCognee())
    settings = memory_settings(
        COGNEE_BASE_URL="http://cognee.test", COGNEE_SERVICE_EMAIL="a@b.c", COGNEE_SERVICE_PASSWORD="x", MEMORY_NOTES_ENABLED="true"
    )
    app = create_app(lambda: None, lambda: (None, None), memory_settings=settings, database_factory=lambda: FakeDialogDatabase("flow-route"))
    user = str(uuid.uuid4())
    base = f"/v1/users/{user}/memory"
    with TestClient(app) as client:
        # модели нет (LLM_MODE не proxy): поле «Скажи, что поправить» честно отвечает «недоступно»
        client.put(f"{base}/settings", json={"enabled": True, "consentVersion": CONSENT}, headers=AUTH)
        unavailable = client.post(f"{base}/notes/instruction", json={"text": "Убери тему про отца"}, headers=AUTH)
        assert unavailable.status_code == 503 and unavailable.json()["error"]["code"] == "MEMORY_UNAVAILABLE"

        note = client.post(f"{base}/facts", json={"category": "boundary", "text": "Не хочет обсуждать отца"}, headers=AUTH).json()
        memory = app.state.memory
        memory.set_extractor(NotesExtractor(FakeModel({"ops": [{"op": "delete", "id": note["id"], "quote": "убери тему про отца"}]}), memory.notes))
        done = client.post(f"{base}/notes/instruction", json={"text": "Убери тему про отца"}, headers=AUTH)
        assert done.status_code == 200 and done.json()["changes"]["deleted"] == [note["id"]]
        assert client.get(f"{base}/notes", headers=AUTH).json()["notes"] == []
