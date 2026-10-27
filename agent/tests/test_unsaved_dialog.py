"""«Не сохранять этот разговор» (`openspec/changes/archive/2026-10-27-add-unsaved-dialog`, PROTEUS-246): разговор живёт только в памяти процесса, после
завершения остаётся пометка без текста; память, итог и расход моделей о нём ничего не знают.

Тексты реплик здесь выдуманные. Хранилище — in-memory двойник базы (`tests/fake_db.py`), «перезапуск пода» — новый `DialogStore` на том
же «файле».
"""

import json
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from starlette.testclient import WebSocketDenialResponse

from app.services.dialog_store import DialogStore
from app.services.usage import Usage
from tests.conftest import AUTH, read_frames, ws_url
from tests.fake_db import FakeDialogDatabase as DialogDatabase
from tests.test_persistence import app_client, say

SECRET = "выдуманная реплика про выдуманную тревогу"
LONG = "Мне сегодня очень тревожно из-за работы, и я не знаю, как поговорить с руководителем."


def uid() -> str:
    return str(uuid.uuid4())


async def make_store(path: Path, idle: float = 0) -> tuple[DialogStore, DialogDatabase]:
    store = DialogStore(idle_evict_seconds=idle)
    db = DialogDatabase(str(path))
    await store.attach(db, flush_interval=60)  # фоновой записи не ждём: вызываем flush вручную
    return store, db


class MemorySpy:
    """MemoryLink-заглушка: что хранилище успело рассказать памяти."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []

    def user_message(self, dialog: Any, text: str) -> None:
        self.calls.append(("user_message", dialog.id))

    def dialog_ended(self, dialog: Any) -> None:
        self.calls.append(("dialog_ended", dialog.id))

    async def dialog_deleting(self, user_id: str, dialog_id: str) -> None:
        self.calls.append(("dialog_deleting", dialog_id))

    async def user_loaded(self, user_id: str) -> None:
        return None

    def user_unloaded(self, user_id: str) -> None:
        return None

    def user_erased(self, user_id: str) -> None:
        return None

    def brief(self, dialog: Any, count: bool = True) -> str:
        return "Зовут Алекс"

    async def prepare(self, dialog: Any) -> None:
        return None

    def removals(self, user_id: str) -> int:
        return 0

    def enabled(self, user_id: str) -> bool:
        return True


# ─── Хранилище: «Ничего не сохраняется» ───────────────────────────────────────────────────────────────────────────


async def test_nothing_reaches_the_database_while_an_unsaved_dialog_runs(tmp_path: Path) -> None:
    path = tmp_path / "d.db"
    store, db = await make_store(path)
    user = uid()
    await store.ensure_user(user)
    dialog, _, _ = store.start(user, "female", saved=False)
    assert dialog.saved is False and dialog.memory_mode == "off"  # память у такого разговора выключена всегда
    store.socket_opened(dialog)
    first = store.add_message(dialog, "user", SECRET)
    store.add_message(dialog, "assistant", "Я рядом.")
    dialog.client_ids["c-1"] = first.id
    store.add_usage(dialog, first.id, [Usage("gemini", "live", "input", "audio", "second", 3.0)])
    store.mark_crisis(dialog)
    store.set_voice(dialog, "male")

    assert await store.flush() is True
    assert db.counts() == (0, 0)  # ни диалога, ни реплик
    assert DialogDatabase.usage_rows(str(path)) == []  # ни расхода моделей
    assert [m.text for m in dialog.messages][0] == SECRET  # а в памяти процесса разговор есть
    await store.detach()
    assert DialogDatabase._files[str(path)].dialogs == {}  # остановка пода тоже ничего не дописывает


async def test_an_ended_unsaved_dialog_leaves_a_mark_without_text(tmp_path: Path) -> None:
    path = tmp_path / "d.db"
    store, db = await make_store(path)
    user = uid()
    await store.ensure_user(user)
    dialog, _, _ = store.start(user, "female", saved=False)
    first = store.add_message(dialog, "user", SECRET)
    store.add_message(dialog, "assistant", "Я рядом.")
    dialog.client_ids["c-1"] = first.id
    store.mark_crisis(dialog)

    summary = store.end(dialog, "Забираю с собой вот это", 3)
    assert await store.flush() is True

    assert db.counts() == (1, 0)  # одна строка-пометка, сообщений нет
    row = DialogDatabase._files[str(path)].dialogs[dialog.id]
    assert row[0] == dialog.id and row[1] == user and row[2] == dialog.started_at and row[3] == dialog.ended_at
    assert row[3] is not None  # начало и конец записаны
    assert row[4] is None and row[5] is None  # ни итога (название берётся из реплики), ни приветствия
    assert row[8] == "off" and row[9] == 0 and row[10] is False  # память off, кризис не записан, пометка «не сохранён»
    assert SECRET not in json.dumps(row, ensure_ascii=False) and "Забираю" not in json.dumps(row, ensure_ascii=False)
    assert dialog.messages == [] and dialog.client_ids == {}  # текст из памяти процесса удалён
    assert summary["title"] == "Разговор" and summary["tensionAfter"] is None  # «что забираешь» и напряжение не сохраняются
    assert summary["recap"] is None and summary["recapStatus"] == "none" and summary["recapAvailable"] is False
    assert summary["userMessages"] == 1 and summary["assistantMessages"] == 1  # только счёт для кадра `ended`
    assert dialog.to_item()["summary"] is None and dialog.to_item()["saved"] is False  # журнал отдаёт пометку без сводки
    await store.detach()


async def test_the_mark_comes_back_after_a_restart_and_is_not_ended_twice(tmp_path: Path) -> None:
    path = tmp_path / "d.db"
    store, _ = await make_store(path)
    user = uid()
    await store.ensure_user(user)
    dialog, _, _ = store.start(user, "female", saved=False)
    store.add_message(dialog, "user", SECRET)
    store.end(dialog, None, None)
    await store.detach()

    after, _ = await make_store(path)
    await after.ensure_user(user)
    restored = after.get(user, dialog.id)
    assert restored is not None and restored.saved is False and restored.memory_mode == "off"
    assert restored.messages == [] and restored.ended_at == dialog.ended_at
    assert restored.to_item()["summary"] is None
    summary = restored.summary
    assert summary is not None and after.end(restored, "поздно", 5) is summary  # повторное завершение ничего не меняет
    assert restored.ended_at == dialog.ended_at
    await after.detach()


async def test_a_restart_loses_an_unsaved_dialog_that_has_not_ended(tmp_path: Path) -> None:
    path = tmp_path / "d.db"
    store, db = await make_store(path)
    user = uid()
    await store.ensure_user(user)
    dialog, _, _ = store.start(user, "female", saved=False)
    store.socket_opened(dialog)
    store.add_message(dialog, "user", SECRET)
    await store.flush()
    await store.detach()  # под выкачен заново

    after, db_after = await make_store(path)
    await after.ensure_user(user)
    assert after.get(user, dialog.id) is None  # разговор потерян, следа нет
    assert after.list(user, 10, None)[0] == []
    assert db_after.counts() == (0, 0)
    await after.detach()


async def test_an_abandoned_unsaved_dialog_is_ended_by_the_stale_pass_and_leaves_the_mark(tmp_path: Path) -> None:
    path = tmp_path / "d.db"
    store = DialogStore(idle_end_seconds=60)
    db = DialogDatabase(str(path))
    await store.attach(db, flush_interval=60)
    user = uid()
    await store.ensure_user(user)
    dialog, _, _ = store.start(user, "female", saved=False)
    store.add_message(dialog, "user", SECRET)
    assert store.end_stale(datetime.now(UTC) + timedelta(seconds=120)) == 1
    await store.flush()
    assert db.counts() == (1, 0) and dialog.messages == []
    await store.detach()


# ─── Хранилище: память, выгрузка, удаление, срок ──────────────────────────────────────────────────────────────────


async def test_memory_is_told_nothing_about_an_unsaved_dialog(tmp_path: Path) -> None:
    store, _ = await make_store(tmp_path / "d.db")
    spy = MemorySpy()
    store.memory = spy  # type: ignore[assignment]
    user = uid()
    await store.ensure_user(user)
    dialog, _, _ = store.start(user, "female", saved=False)
    store.add_message(dialog, "user", SECRET)
    assert store.memory_brief(dialog) == ""  # блока памяти нет, хотя память человека ему что-то могла бы подать
    store.end(dialog, None, None)
    await store.delete_by_person(dialog)
    assert spy.calls == []  # ни реплик, ни завершения, ни удаления документа в индексе
    await store.detach()


async def test_an_open_unsaved_dialog_keeps_its_person_in_memory_until_it_ends(tmp_path: Path) -> None:
    store, _ = await make_store(tmp_path / "d.db", idle=1800)
    user = uid()
    await store.ensure_user(user)
    dialog, _, _ = store.start(user, "female", saved=False)
    store.add_message(dialog, "user", SECRET)
    now = __import__("time").monotonic() + 7200
    assert store.evict_idle(now) == 0  # выгрузка унесла бы разговор, которого нет нигде, кроме памяти процесса
    store.end(dialog, None, None)
    await store.flush()
    assert store.evict_idle(now) == 1  # завершён: на диске пометка, человека можно выгружать
    await store.ensure_user(user)
    assert store.get(user, dialog.id) is not None  # и пометка вернулась с диска
    await store.detach()


async def test_the_mark_is_deleted_by_the_person_without_touching_the_index(tmp_path: Path) -> None:
    path = tmp_path / "d.db"
    store, db = await make_store(path)
    user = uid()
    await store.ensure_user(user)
    dialog, _, _ = store.start(user, "female", saved=False)
    store.add_message(dialog, "user", SECRET)
    store.end(dialog, None, None)
    await store.flush()
    await store.delete_by_person(dialog)
    assert store.get(user, dialog.id) is None
    assert dialog.id in DialogDatabase._files[str(path)].deleted_dialogs  # помечена удалённой, физически уберёт очистка
    await store.detach()


async def test_the_mark_follows_the_retention_period(tmp_path: Path) -> None:
    path = tmp_path / "d.db"
    store, _ = await make_store(path)
    user = uid()
    await store.ensure_user(user)
    dialog, _, _ = store.start(user, "female", saved=False)
    store.add_message(dialog, "user", SECRET)
    store.end(dialog, None, None)
    await store.flush()
    await store.detach()

    after, _ = await make_store(path)
    after.retention_days = 90
    await after.ensure_user(user)
    expired, deleted = await after.retention_pass(datetime.now(UTC) + timedelta(days=91))
    assert (expired, deleted) == (1, 1)
    assert after.get(user, dialog.id) is None
    await after.detach()


async def test_an_empty_open_dialog_with_the_other_choice_is_replaced(tmp_path: Path) -> None:
    store, _ = await make_store(tmp_path / "d.db")
    user = uid()
    await store.ensure_user(user)
    saved, _, _ = store.start(user, "female")
    unsaved, resumed, _ = store.start(user, "female", saved=False)
    assert resumed is False and unsaved.id != saved.id and unsaved.saved is False
    assert store.get(user, saved.id) is None  # пустой сохраняемый не переиспользуется
    again, resumed, _ = store.start(user, "female", saved=True)  # возвращённый открытый остаётся со своим выбором? пустой — нет
    assert resumed is False and again.saved is True and store.get(user, unsaved.id) is None
    await store.detach()


async def test_a_returned_open_unsaved_dialog_keeps_its_choice(tmp_path: Path) -> None:
    store, _ = await make_store(tmp_path / "d.db")
    user = uid()
    await store.ensure_user(user)
    dialog, _, _ = store.start(user, "female", saved=False)
    store.add_message(dialog, "user", SECRET)
    same, resumed, _ = store.start(user, "female")  # старт без выбора возвращает открытый как есть
    assert resumed is True and same is dialog and same.saved is False
    fresh, resumed, _ = store.start(user, "female", new=True, saved=True)  # «Завершить и начать новый»
    assert resumed is False and fresh.saved is True
    assert dialog.ended_at is not None and dialog.messages == []  # прежний завершён пометкой
    await store.detach()


async def test_without_memory_is_not_unsaved(tmp_path: Path) -> None:
    """«Без памяти» (`memory: off`) — только память: разговор записывается, подводится итог, остаётся срок хранения."""
    path = tmp_path / "d.db"
    store, db = await make_store(path)
    user = uid()
    await store.ensure_user(user)
    dialog, _, _ = store.start(user, "female", memory_mode="off")
    assert dialog.saved is True and dialog.memory_mode == "off"
    store.add_message(dialog, "user", LONG)
    summary = store.end(dialog, None, None)
    assert summary["recapAvailable"] is True and summary["title"] == LONG[:80]
    await store.flush()
    assert db.counts() == (1, 1)
    assert DialogDatabase._files[str(path)].dialogs[dialog.id][10] is True
    await store.detach()


# ─── Приложение: REST и сокет ─────────────────────────────────────────────────────────────────────────────────────


def url(user: str, tail: str = "") -> str:
    return f"/v1/users/{user}{tail}"


def test_start_answers_with_the_choice_and_old_clients_get_a_saved_dialog(client: TestClient, user_id: str) -> None:
    plain = client.post(url(user_id, "/dialogs"), headers=AUTH).json()
    assert plain["saved"] is True and plain["memoryMode"] == "on"
    unsaved = client.post(url(user_id, "/dialogs"), json={"saved": False, "new": True, "memory": "on"}, headers=AUTH).json()
    assert unsaved["saved"] is False and unsaved["memoryMode"] == "off" and unsaved["dialogId"] != plain["dialogId"]
    without_memory = client.post(url(user_id, "/dialogs"), json={"memory": "off", "new": True}, headers=AUTH).json()
    assert without_memory["saved"] is True and without_memory["memoryMode"] == "off"  # две разные вещи


def test_the_journal_lists_the_mark_without_a_summary_or_text(client: TestClient, user_id: str) -> None:
    dialog_id = client.post(url(user_id, "/dialogs"), json={"saved": False}, headers=AUTH).json()["dialogId"]
    store = client.app.state.store  # type: ignore[attr-defined]
    dialog = store.get(user_id, dialog_id)
    store.add_message(dialog, "user", LONG)
    store.add_message(dialog, "assistant", "Я здесь, расскажи.")
    during = client.get(url(user_id, f"/dialogs/{dialog_id}"), headers=AUTH).json()
    assert during["saved"] is False and len(during["messages"]) == 2  # пока разговор идёт, он виден клиенту

    ended = client.post(url(user_id, f"/dialogs/{dialog_id}/end"), json={"takeaway": LONG, "tensionAfter": 4}, headers=AUTH)
    assert ended.status_code == 200
    assert ended.json()["summary"]["recap"] is None and ended.json()["summary"]["recapAvailable"] is False

    entry = client.get(url(user_id, f"/dialogs/{dialog_id}"), headers=AUTH).json()
    assert entry["saved"] is False and entry["summary"] is None and entry["messages"] == []
    assert entry["endedAt"] is not None and entry["memoryMode"] == "off"
    listed = client.get(url(user_id, "/dialogs"), headers=AUTH).json()["items"]
    assert [(i["dialogId"], i["saved"], i["summary"]) for i in listed] == [(dialog_id, False, None)]
    assert client.get(url(user_id, "/recaps"), headers=AUTH).json()["items"] == []  # итогов недели о нём нет

    draft = client.post(url(user_id, f"/dialogs/{dialog_id}/recap/draft"), headers=AUTH)
    assert draft.status_code == 409 and draft.json()["error"]["code"] == "RECAP_NOT_AVAILABLE"
    put = client.put(url(user_id, f"/dialogs/{dialog_id}/recap"), json={"recap": "что угодно"}, headers=AUTH)
    assert put.status_code == 409 and put.json()["error"]["code"] == "RECAP_NOT_AVAILABLE"
    assert client.delete(url(user_id, f"/dialogs/{dialog_id}"), headers=AUTH).status_code == 204  # «Удалить разговор» работает


def test_a_restart_during_an_unsaved_dialog_leaves_no_trace_and_the_socket_is_refused(tmp_path: Path) -> None:
    path = tmp_path / "pvc" / "dialogs.db"
    user = uid()
    with app_client(path) as old:
        started = old.post(url(user, "/dialogs"), json={"saved": False}, headers=AUTH).json()
        dialog_id = started["dialogId"]
        say(old, user, dialog_id, SECRET, "c-1")
        say(old, user, dialog_id, "ещё одна выдуманная реплика", "c-2")
        assert len(old.get(url(user, f"/dialogs/{dialog_id}"), headers=AUTH).json()["messages"]) == 4
        old.portal.call(old.app.state.store.flush)  # type: ignore[attr-defined]
        assert DialogDatabase.message_rows(str(path)) == []  # реплики в базе не появились
        assert old.get(url(user, "/dialogs"), headers=AUTH).json()["items"][0]["saved"] is False

    with app_client(path) as new:  # под выкачен заново
        assert new.get(url(user, "/dialogs"), headers=AUTH).json()["items"] == []  # пометки нет
        assert new.get(url(user, f"/dialogs/{dialog_id}"), headers=AUTH).status_code == 404
        with pytest.raises(WebSocketDenialResponse) as denied:
            with new.websocket_connect(ws_url(user, dialog_id), headers=AUTH):
                pass
        assert denied.value.status_code == 404
    assert DialogDatabase.message_rows(str(path)) == [] and DialogDatabase.usage_rows(str(path)) == []


def test_an_unsaved_dialog_ended_over_the_socket_leaves_the_mark_only(tmp_path: Path) -> None:
    path = tmp_path / "pvc" / "dialogs.db"
    user = uid()
    with app_client(path) as app:
        dialog_id = app.post(url(user, "/dialogs"), json={"saved": False}, headers=AUTH).json()["dialogId"]
        say(app, user, dialog_id, SECRET, "c-1")
        ended = app.post(url(user, f"/dialogs/{dialog_id}/end"), headers=AUTH)
        assert ended.status_code == 200
        app.portal.call(app.app.state.store.flush)  # type: ignore[attr-defined]
        assert DialogDatabase.message_rows(str(path)) == []
        assert DialogDatabase.usage_rows(str(path)) == []
        state = DialogDatabase._files[str(path)]
        assert list(state.dialogs) == [dialog_id] and state.dialogs[dialog_id][10] is False

    with app_client(path) as new:
        item = new.get(url(user, "/dialogs"), headers=AUTH).json()["items"][0]
        assert item["dialogId"] == dialog_id and item["saved"] is False and item["summary"] is None
        entry = new.get(url(user, f"/dialogs/{dialog_id}"), headers=AUTH).json()
        assert entry["messages"] == [] and entry["endedAt"] is not None


def test_a_crisis_in_an_unsaved_dialog_is_handled_as_usual_and_not_written(tmp_path: Path) -> None:
    path = tmp_path / "pvc" / "dialogs.db"
    user = uid()
    with app_client(path) as app:
        dialog_id = app.post(url(user, "/dialogs"), json={"saved": False}, headers=AUTH).json()["dialogId"]
        frames = say(app, user, dialog_id, "я не хочу жить", "c-1", until="safety")
        assert any(k == "json" and b["type"] == "safety" for k, b in frames)  # экран помощи показан как обычно
        store = app.app.state.store  # type: ignore[attr-defined]
        assert store.get(user, dialog_id).crisis_seen is True
        app.post(url(user, f"/dialogs/{dialog_id}/end"), headers=AUTH)
        app.portal.call(store.flush)
        state = DialogDatabase._files[str(path)]
        assert state.messages == {} and state.dialogs[dialog_id][9] == 0  # ни кризисных кусков, ни признака кризиса


def test_the_socket_tells_the_gateway_that_the_dialog_is_not_saved(client: TestClient, user_id: str) -> None:
    unsaved = client.post(url(user_id, "/dialogs"), json={"saved": False, "new": True}, headers=AUTH).json()["dialogId"]
    with client.websocket_connect(ws_url(user_id, unsaved), headers=AUTH) as ws:
        frames = read_frames(ws, lambda f: any(k == "json" and b["type"] == "ready" for k, b in f))
    ready = next(b for k, b in frames if k == "json" and b["type"] == "ready")
    assert ready["saved"] is False
    ended = client.post(url(user_id, f"/dialogs/{unsaved}/end"), headers=AUTH).json()
    assert ended["saved"] is False

    saved = client.post(url(user_id, "/dialogs"), json={"new": True}, headers=AUTH).json()["dialogId"]
    with client.websocket_connect(ws_url(user_id, saved), headers=AUTH) as ws:
        frames = read_frames(ws, lambda f: any(k == "json" and b["type"] == "ready" for k, b in f))
    assert "saved" not in next(b for k, b in frames if k == "json" and b["type"] == "ready")
    assert client.post(url(user_id, f"/dialogs/{saved}/end"), headers=AUTH).json()["saved"] is True
