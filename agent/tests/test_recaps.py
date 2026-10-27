"""Итог разговора, его три способа, список, черновик, настройка, удаление и срок хранения (add-mood-diary, D13, D14)."""

import time
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.services import recaps
from tests.conftest import AUTH, make_client, start_dialog
from tests.fake_db import FakeDialogDatabase as DialogDatabase

LONG = "Мне сегодня очень тревожно из-за работы, и я не знаю, как поговорить с руководителем."
SHORT = "Привет"
RECAP = "Ты рассказал про работу и решил поговорить с руководителем до пятницы."


def url(user: str, tail: str = "") -> str:
    return f"/v1/users/{user}{tail}"


def store_of(client: TestClient):
    return client.app.state.store  # type: ignore[attr-defined]


def talk(client: TestClient, user: str, text: str = LONG, memory: str = "on") -> str:
    """Начать разговор и сказать одну реплику (прямо в хранилище: сокет тесту не нужен)."""
    response = client.post(url(user, "/dialogs"), json={"memory": memory, "new": True}, headers=AUTH)
    assert response.status_code == 200, response.text
    dialog_id = response.json()["dialogId"]
    store = store_of(client)
    dialog = store.get(user, dialog_id)
    store.add_message(dialog, "user", text)
    store.add_message(dialog, "assistant", "Я здесь, расскажи.")
    return dialog_id


def end(client: TestClient, user: str, dialog_id: str, **body: Any) -> dict[str, Any]:
    response = client.post(url(user, f"/dialogs/{dialog_id}/end"), json=body, headers=AUTH)
    assert response.status_code == 200, response.text
    return response.json()["summary"]


def summary_of(client: TestClient, user: str, dialog_id: str) -> dict[str, Any]:
    return client.get(url(user, f"/dialogs/{dialog_id}"), headers=AUTH).json()["summary"]


def wait_status(client: TestClient, user: str, dialog_id: str, status: str) -> dict[str, Any]:
    for _ in range(100):
        summary = summary_of(client, user, dialog_id)
        if summary["recapStatus"] == status:
            return summary
        time.sleep(0.05)
    raise AssertionError(f"recapStatus не стал {status}: {summary_of(client, user, dialog_id)}")


class SlowChat:
    name = "slow"

    def __init__(self, reply: str, delay: float = 0.0) -> None:
        self.reply = reply
        self.delay = delay

    async def complete(self, messages):
        import asyncio

        await asyncio.sleep(self.delay)
        return self.reply

    async def aclose(self) -> None:
        return None


# ─── три способа завести итог ─────────────────────────────────────────────────


def test_manual_recap_is_saved_at_once_and_marked_manual(client, user_id):
    dialog_id = talk(client, user_id)
    summary = end(client, user_id, dialog_id, takeaway=RECAP)
    assert summary["recapStatus"] == "ready" and summary["recapSource"] == "manual"
    assert summary["recap"] == RECAP


def test_a_pre_filled_recap_is_marked_draft(client, user_id):
    dialog_id = talk(client, user_id)
    summary = end(client, user_id, dialog_id, takeaway=RECAP, recapSource="draft")
    assert summary["recapSource"] == "draft"


def test_automatic_recap_is_pending_then_ready(client, user_id):
    dialog_id = talk(client, user_id)
    summary = end(client, user_id, dialog_id, tensionAfter=4)
    assert summary["recapStatus"] in ("pending", "ready")
    ready = wait_status(client, user_id, dialog_id, "ready")
    assert ready["recapSource"] == "auto" and ready["recap"]


def test_a_manual_recap_is_not_replaced_by_the_automatic_one(user_id):
    with make_client(chat=SlowChat("Авто итог.", delay=0.4)) as client:
        dialog_id = talk(client, user_id)
        assert end(client, user_id, dialog_id)["recapStatus"] == "pending"
        # пока модель думает, человек пишет итог сам в журнале
        put = client.put(url(user_id, f"/dialogs/{dialog_id}/recap"), json={"recap": RECAP, "source": "manual"}, headers=AUTH)
        assert put.status_code == 200 and put.json()["summary"]["recapSource"] == "manual"
        time.sleep(0.8)
        final = summary_of(client, user_id, dialog_id)
        assert final["recapSource"] == "manual" and final["recap"] == RECAP


def test_the_model_recap_is_validated_and_a_failed_one_leaves_none(user_id):
    bad = "Тебе надо поговорить."
    with make_client(chat=SlowChat(bad)) as client:
        dialog_id = talk(client, user_id)
        end(client, user_id, dialog_id)
        assert wait_status(client, user_id, dialog_id, "none")["recap"] is None


def test_the_model_recap_is_the_free_text(user_id):
    with make_client(chat=SlowChat("Ты говорил о работе, и стало легче.")) as client:
        dialog_id = talk(client, user_id)
        end(client, user_id, dialog_id)
        ready = wait_status(client, user_id, dialog_id, "ready")
        assert ready["recap"] == "Ты говорил о работе, и стало легче." and ready["recapSource"] == "auto"


# ─── когда итога нет ──────────────────────────────────────────────────────────


def test_no_recap_for_a_short_conversation(client, user_id):
    dialog_id = talk(client, user_id, SHORT)
    summary = end(client, user_id, dialog_id, takeaway=RECAP)
    assert summary["recap"] is None and summary["recapStatus"] == "none" and summary["recapSource"] is None


def test_no_recap_for_a_conversation_with_a_crisis(client, user_id):
    dialog_id = talk(client, user_id)
    store = store_of(client)
    store.mark_crisis(store.get(user_id, dialog_id))
    assert end(client, user_id, dialog_id)["recapStatus"] == "none"
    draft = client.post(url(user_id, f"/dialogs/{dialog_id}/recap/draft"), headers=AUTH)
    assert draft.status_code == 409 and draft.json()["error"]["code"] == "RECAP_NOT_AVAILABLE"


def test_no_recap_for_a_conversation_without_memory(client, user_id):
    dialog_id = talk(client, user_id, memory="off")
    assert end(client, user_id, dialog_id)["recapStatus"] == "none"


def test_the_recap_does_not_depend_on_the_memory_switch(client, user_id):
    client.put(url(user_id, "/memory/settings"), json={"enabled": False}, headers=AUTH)
    dialog_id = talk(client, user_id)
    end(client, user_id, dialog_id)
    assert wait_status(client, user_id, dialog_id, "ready")["recap"]


# ─── настройка «Подводить итог автоматически» ─────────────────────────────────


def test_the_setting_is_on_by_default_and_is_kept_apart_from_memory(client, user_id):
    assert client.get(url(user_id, "/dialog-settings"), headers=AUTH).json() == {"recapEnabled": True}
    memory_before = client.get(url(user_id, "/memory"), headers=AUTH).json()
    assert client.put(url(user_id, "/dialog-settings"), json={"recapEnabled": False}, headers=AUTH).json() == {"recapEnabled": False}
    assert client.get(url(user_id, "/memory"), headers=AUTH).json() == memory_before


def test_with_the_setting_off_there_is_no_automatic_recap_but_a_manual_one_can_be_added_later(client, user_id):
    client.put(url(user_id, "/dialog-settings"), json={"recapEnabled": False}, headers=AUTH)
    dialog_id = talk(client, user_id)
    assert end(client, user_id, dialog_id)["recapStatus"] == "none"
    put = client.put(url(user_id, f"/dialogs/{dialog_id}/recap"), json={"recap": RECAP}, headers=AUTH)
    assert put.status_code == 200 and put.json()["summary"]["recapStatus"] == "ready"


def test_the_setting_survives_a_restart(tmp_path: Path):
    user = str(uuid.uuid4())
    path = tmp_path / "dialogs.db"

    def app() -> TestClient:
        return TestClient(create_app(lambda: None, lambda: (None, None), database_factory=lambda: DialogDatabase(str(path))))

    with app() as first:
        first.put(url(user, "/dialog-settings"), json={"recapEnabled": False}, headers=AUTH)
        time.sleep(0.2)
    with app() as second:
        assert second.get(url(user, "/dialog-settings"), headers=AUTH).json() == {"recapEnabled": False}


# ─── черновик, список, запись итога ───────────────────────────────────────────


def test_the_draft_is_not_saved(client, user_id):
    client.put(url(user_id, "/dialog-settings"), json={"recapEnabled": False}, headers=AUTH)
    dialog_id = talk(client, user_id)
    end(client, user_id, dialog_id)
    before = summary_of(client, user_id, dialog_id)
    draft = client.post(url(user_id, f"/dialogs/{dialog_id}/recap/draft"), headers=AUTH)
    assert draft.status_code == 200 and isinstance(draft.json()["recap"], str) and draft.json()["recap"]
    assert summary_of(client, user_id, dialog_id) == before and before["recapStatus"] == "none"


def test_a_stranger_or_missing_dialog_is_not_found(client, user_id):
    other = str(uuid.uuid4())
    dialog_id = talk(client, other)
    for method, tail in (("post", "/recap/draft"), ("put", "/recap"), ("delete", "")):
        response = getattr(client, method)(url(user_id, f"/dialogs/{dialog_id}{tail}"), headers=AUTH, **({"json": {"recap": RECAP}} if method == "put" else {}))
        assert response.status_code == 404


def test_a_recap_can_not_be_written_for_an_open_dialog(client, user_id):
    dialog_id = talk(client, user_id)
    assert client.put(url(user_id, f"/dialogs/{dialog_id}/recap"), json={"recap": RECAP}, headers=AUTH).status_code == 409


def test_the_list_holds_only_conversations_with_a_recap_newest_first_in_pages(client, user_id):
    ids = []
    for _ in range(3):
        dialog_id = talk(client, user_id)
        end(client, user_id, dialog_id, takeaway=RECAP)
        ids.append(dialog_id)
    short = talk(client, user_id, SHORT)
    end(client, user_id, short)
    first = client.get(url(user_id, "/recaps?limit=2"), headers=AUTH).json()
    assert [i["dialogId"] for i in first["items"]] == [ids[2], ids[1]] and first["next"]
    second = client.get(url(user_id, f"/recaps?limit=2&before={first['next']}"), headers=AUTH).json()
    assert [i["dialogId"] for i in second["items"]] == [ids[0]] and second["next"] is None
    assert first["items"][0]["recap"] == RECAP and first["items"][0]["recapAt"]


def test_the_next_dialog_does_not_carry_the_recap(client, user_id):
    dialog_id = talk(client, user_id)
    end(client, user_id, dialog_id, takeaway=RECAP)
    started = client.post(url(user_id, "/dialogs"), json={"new": True}, headers=AUTH).json()
    assert "previousRecap" not in started
    assert "recap" not in started


# ─── удаление разговора ───────────────────────────────────────────────────────


def test_delete_removes_the_conversation_with_its_recap(client, user_id):
    dialog_id = talk(client, user_id)
    end(client, user_id, dialog_id, takeaway=RECAP)
    assert client.delete(url(user_id, f"/dialogs/{dialog_id}"), headers=AUTH).status_code == 204
    assert client.get(url(user_id, f"/dialogs/{dialog_id}"), headers=AUTH).status_code == 404
    assert client.get(url(user_id, "/recaps"), headers=AUTH).json()["items"] == []
    assert client.delete(url(user_id, f"/dialogs/{dialog_id}"), headers=AUTH).status_code == 404


def test_delete_of_an_open_dialog_ends_it_first_and_starts_no_recap(client, user_id):
    store = client.app.state.store
    dialog_id = talk(client, user_id)  # открытый разговор: end не вызывался
    spawned: list[str] = []
    store._spawn_recap = lambda dialog: spawned.append(dialog.id)  # noqa: SLF001
    assert client.delete(url(user_id, f"/dialogs/{dialog_id}"), headers=AUTH).status_code == 204
    assert spawned == []  # автоитог для удаляемого разговора не запускается
    assert client.get(url(user_id, f"/dialogs/{dialog_id}"), headers=AUTH).status_code == 404


def test_delete_leaves_the_notes_of_memory(client, user_id):
    client.put(url(user_id, "/memory/settings"), json={"enabled": True}, headers=AUTH)
    dialog_id = talk(client, user_id)
    end(client, user_id, dialog_id, takeaway=RECAP)
    facts_before = client.get(url(user_id, "/memory"), headers=AUTH).json()
    client.delete(url(user_id, f"/dialogs/{dialog_id}"), headers=AUTH)
    assert client.get(url(user_id, "/memory"), headers=AUTH).json() == facts_before


def test_the_recap_is_stored_with_the_dialog_on_disk(tmp_path: Path):
    user = str(uuid.uuid4())
    path = tmp_path / "dialogs.db"

    def app() -> TestClient:
        return TestClient(create_app(lambda: None, lambda: (None, None), database_factory=lambda: DialogDatabase(str(path))))

    with app() as first:
        dialog_id = talk(first, user)
        end(first, user, dialog_id, takeaway=RECAP)
        time.sleep(0.2)
    with app() as second:
        assert summary_of(second, user, dialog_id)["recap"] == RECAP
        second.delete(url(user, f"/dialogs/{dialog_id}"), headers=AUTH)
        time.sleep(0.2)
    with app() as third:
        assert third.get(url(user, f"/dialogs/{dialog_id}"), headers=AUTH).status_code == 404


# ─── срок хранения ────────────────────────────────────────────────────────────


def age(client: TestClient, user: str, dialog_id: str, days: float) -> None:
    store = store_of(client)
    dialog = store.get(user, dialog_id)
    stamp = (datetime.now(UTC) - timedelta(days=days)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    for message in dialog.messages:
        message.created_at = stamp
    dialog.started_at = stamp


def run(client: TestClient, coro_factory):
    return client.portal.call(coro_factory)  # type: ignore[union-attr]


def retention(client: TestClient) -> tuple[int, int]:
    store = store_of(client)
    return client.portal.call(store.retention_pass, datetime.now(UTC))  # type: ignore[union-attr]


def test_retention_deletes_a_dialog_older_than_the_term_with_its_recap(client, user_id):
    store = store_of(client)
    store.retention_days, store.retention_dry_run = 21, False
    old, fresh = talk(client, user_id), talk(client, user_id)
    end(client, user_id, old, takeaway=RECAP)
    end(client, user_id, fresh, takeaway=RECAP)
    age(client, user_id, old, 22)
    assert retention(client) == (1, 1)
    assert client.get(url(user_id, f"/dialogs/{old}"), headers=AUTH).status_code == 404
    assert client.get(url(user_id, f"/dialogs/{fresh}"), headers=AUTH).status_code == 200


def test_retention_off_keeps_everything(client, user_id):
    store = store_of(client)
    store.retention_days, store.retention_dry_run = 0, False
    dialog_id = talk(client, user_id)
    age(client, user_id, dialog_id, 400)
    assert retention(client) == (0, 0)
    assert client.get(url(user_id, f"/dialogs/{dialog_id}"), headers=AUTH).status_code == 200


def test_the_dry_run_only_counts(client, user_id):
    from prometheus_client import REGISTRY

    store = store_of(client)
    store.retention_days, store.retention_dry_run = 21, True
    dialog_id = talk(client, user_id)
    age(client, user_id, dialog_id, 30)
    assert retention(client) == (1, 0)
    assert client.get(url(user_id, f"/dialogs/{dialog_id}"), headers=AUTH).status_code == 200
    assert REGISTRY.get_sample_value("agent_dialogs_retention_would_delete") == 1.0


def test_retention_reaches_dialogs_of_people_not_in_memory(tmp_path: Path):
    user = str(uuid.uuid4())
    path = tmp_path / "dialogs.db"

    def app() -> TestClient:
        return TestClient(create_app(lambda: None, lambda: (None, None), database_factory=lambda: DialogDatabase(str(path))))

    with app() as first:
        dialog_id = talk(first, user)
        end(first, user, dialog_id, takeaway=RECAP)
        age(first, user, dialog_id, 30)
        store_of(first)._touch(store_of(first).get(user, dialog_id))
        time.sleep(0.3)
    with app() as second:  # новый под: человек в памяти не загружен, разговор лежит только на диске
        store = store_of(second)
        store.retention_days, store.retention_dry_run = 21, False
        assert second.portal.call(store.retention_pass, datetime.now(UTC)) == (1, 1)  # type: ignore[union-attr]
        assert second.get(url(user, f"/dialogs/{dialog_id}"), headers=AUTH).status_code == 404
        # Удаление мягкое: строка осталась в базе с пометкой, следующий проход её уже не считает.
        assert second.portal.call(store.retention_pass, datetime.now(UTC)) == (0, 0)  # type: ignore[union-attr]


# ─── валидация итога ──────────────────────────────────────────────────────────


@pytest.mark.parametrize("value", [None, "", "   ", "x" * 501, 1, {"about": "x"}])
def test_clean_recap_rejects_what_does_not_fit(value):
    assert recaps.clean_recap(value) is None


def test_clean_recap_normalises_spaces():
    assert recaps.clean_recap(" a  b ") == "a b"



def test_the_week_digest_without_a_model_is_unavailable(client, user_id):
    marks = [{"date": f"2026-10-{19 + i:02d}", "mood": 3, "factor": None} for i in range(3)]
    body = {"kind": "week", "periodStart": "2026-10-19", "marks": marks, "recaps": [{"date": "2026-10-20", "text": RECAP}]}
    assert client.post(url(user_id, "/digests"), json=body, headers=AUTH).status_code == 502  # запасного текста нет
