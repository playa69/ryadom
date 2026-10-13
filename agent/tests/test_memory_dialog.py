"""Разговор и память (MEM-9, I2, I13): «Без памяти» не получает сводку и не порождает извлечения; кризис помечает диалог в
обеих точках кадра safety каскада и в Live и блокирует автоматическое извлечение; сводка в каскаде."""

import json
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from tests.conftest import AUTH, FakeChat, FakeRecognizer, audio_in_frame, has, read_frames, send_user_message, ws_url
from tests.memory_support import CONSENT, FakeModel, make_client, user


def prepare(client: TestClient, u: str, fact: str = "Помогают вечерние прогулки") -> None:
    client.put(f"/v1/users/{u}/memory/settings", json={"enabled": True, "consentVersion": CONSENT}, headers=AUTH)
    assert client.post(f"/v1/users/{u}/memory/facts", json={"category": "works", "text": fact}, headers=AUTH).status_code == 201
    client.portal.call(client.app.state.memory.drain)  # type: ignore[union-attr,attr-defined]


def chat_once(client: TestClient, u: str, memory: str, text: str = "привет") -> str:
    dialog = client.post(f"/v1/users/{u}/dialogs", json={"memory": memory, "new": True}, headers=AUTH).json()
    with client.websocket_connect(ws_url(u, dialog["dialogId"]), headers=AUTH) as ws:
        send_user_message(ws, "c-1", text)
        read_frames(ws, lambda f: has(f, "assistant_end"))
    return dialog["dialogId"]


def system_prompt(chat: FakeChat) -> str:
    return chat.calls[-1][0]["content"]


def test_cascade_gets_the_brief_only_with_memory_on(tmp_path: Path) -> None:
    u = user()
    chat = FakeChat()
    with make_client(tmp_path / "d.sqlite3", FakeModel(), chat=chat) as client:
        prepare(client, u)
        chat_once(client, u, "on")
        assert "Помогают вечерние прогулки" in system_prompt(chat) and "Ниже то, что человек рассказывал раньше" in system_prompt(
            chat
        )
        assert sum(1 for m in chat.calls[-1] if m["role"] == "system") == 1  # одно системное сообщение
        chat_once(client, u, "off")
        assert "Помогают вечерние прогулки" not in system_prompt(chat) and "рассказывал раньше" not in system_prompt(chat)


def test_memory_off_dialog_gets_no_job_and_no_events(tmp_path: Path) -> None:
    u = user()
    with make_client(tmp_path / "d.sqlite3", FakeModel(), chat=FakeChat()) as client:
        prepare(client, u)
        dialog_id = chat_once(client, u, "off", "Меня вечером спасают прогулки")
        client.post(f"/v1/users/{u}/dialogs/{dialog_id}/end", headers=AUTH)
        client.portal.call(client.app.state.memory.drain)  # type: ignore[union-attr,attr-defined]
        db = client.app.state.store.database  # type: ignore[attr-defined]
        assert db.run(lambda conn: conn.execute("SELECT * FROM memory_jobs").fetchall()) == []
        assert db.run(lambda conn: conn.execute("SELECT * FROM memory_events WHERE dialog_id = ?", (dialog_id,)).fetchall()) == []


def crisis_seen(client: TestClient, u: str, dialog_id: str) -> bool:
    return client.app.state.store.get(u, dialog_id).crisis_seen  # type: ignore[attr-defined]


def test_crisis_in_typed_text_marks_the_dialog_and_survives_a_restart(tmp_path: Path) -> None:
    u = user()
    path = tmp_path / "d.sqlite3"
    with make_client(path, FakeModel(), chat=FakeChat()) as client:
        dialog_id = chat_once(client, u, "on", "Иногда мне кажется, что нет смысла жить")
        assert crisis_seen(client, u, dialog_id)
    with make_client(path, FakeModel(), chat=FakeChat()) as client:
        client.get(f"/v1/users/{u}/dialogs", headers=AUTH)
        assert crisis_seen(client, u, dialog_id)


def test_crisis_in_a_voice_turn_marks_the_dialog(tmp_path: Path) -> None:
    u = user()
    recognizer = FakeRecognizer(text="я не хочу жить")
    from app.main import create_app
    from app.services.dialog_db import DialogDatabase
    from tests.memory_support import memory_settings

    app = create_app(
        lambda: None,
        lambda: (FakeChat(), recognizer),
        database_factory=lambda: DialogDatabase(str(tmp_path / "v.sqlite3")),
        memory_settings=memory_settings(),
        memory_model_factory=lambda: FakeModel(),
    )
    with TestClient(app) as client:
        dialog = client.post(f"/v1/users/{u}/dialogs", headers=AUTH).json()
        with client.websocket_connect(ws_url(u, dialog["dialogId"]), headers=AUTH) as ws:
            ws.send_text(json.dumps({"type": "audio_start"}))
            for i in range(3):
                ws.send_bytes(audio_in_frame(i, loud=True))
            ws.send_text(json.dumps({"type": "audio_end"}))
            frames: Any = read_frames(ws, lambda f: has(f, "safety"))
            assert has(frames, "safety")
        assert crisis_seen(client, u, dialog["dialogId"])


def test_crisis_dialog_is_not_extracted_automatically(tmp_path: Path) -> None:
    u = user()
    with make_client(tmp_path / "d.sqlite3", FakeModel(), chat=FakeChat()) as client:
        prepare(client, u)
        dialog = client.post(f"/v1/users/{u}/dialogs", json={"new": True}, headers=AUTH).json()
        with client.websocket_connect(ws_url(u, dialog["dialogId"]), headers=AUTH) as ws:
            for index, text in enumerate(["Тяжёлый день", "не хочу жить", "Прогулки помогают", "Пойду спать"]):
                send_user_message(ws, f"c-{index}", text)
                read_frames(ws, lambda f: has(f, "assistant_end"))
        client.post(f"/v1/users/{u}/dialogs/{dialog['dialogId']}/end", headers=AUTH)
        client.portal.call(client.app.state.memory.drain)  # type: ignore[union-attr,attr-defined]
        body = client.get(f"/v1/users/{u}/memory/changes?dialogId={dialog['dialogId']}", headers=AUTH).json()
        assert body == {"status": "skipped", "reason": "crisis", "items": []}
