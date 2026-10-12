"""Память в режиме gemini_live (MEM-8.4, MEM-13.3, I2, I3): сводка и правила в системной инструкции только при `on` и
включённой памяти; после «забыть всё» новая сессия без фактов; `_instructions()` не ходит ни в базу, ни в сеть; сбой кэша —
пустая сводка, а не ошибка разговора."""

import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.api.dialog_live import LiveDialogSession
from app.core.config import APP_CONFIG
from app.services.replies import MEMORY_RULES, SYSTEM_PROMPT
from tests.conftest import AUTH, FakeTts, has, read_frames, send_user_message, ws_url
from tests.memory_support import CONSENT, FakeModel, close_env, enable, make_client, make_env, user
from tests.test_live import FakeConnector

FACT = "Помогают вечерние прогулки"


@pytest.fixture(autouse=True)
def pinned_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    for name, value in (("text_context", True), ("session_resumption", True), ("history_messages", 40)):
        monkeypatch.setattr(APP_CONFIG.gemini, name, value)


def wait(predicate: Callable[[], bool], seconds: float = 5) -> None:
    deadline = time.monotonic() + seconds
    while not predicate():
        assert time.monotonic() < deadline, "не дождались"
        time.sleep(0.02)


def remember(client: TestClient, u: str) -> None:
    client.put(f"/v1/users/{u}/memory/settings", json={"enabled": True, "consentVersion": CONSENT}, headers=AUTH)
    assert client.post(f"/v1/users/{u}/memory/facts", json={"category": "works", "text": FACT}, headers=AUTH).status_code == 201
    client.portal.call(client.app.state.memory.drain)  # type: ignore[union-attr,attr-defined]


def first_instructions(client: TestClient, connector: FakeConnector, u: str, memory: str = "on") -> str:
    dialog = client.post(f"/v1/users/{u}/dialogs", json={"memory": memory, "new": True}, headers=AUTH).json()
    before = len(connector.links)
    with client.websocket_connect(ws_url(u, dialog["dialogId"]), headers=AUTH) as ws:
        read_frames(ws, lambda f: has(f, "ready"))
        wait(lambda: len(connector.links) > before)
    return connector.links[before].instructions


def test_brief_and_rules_go_into_the_live_session(tmp_path: Path) -> None:
    connector = FakeConnector()
    u = user()
    with make_client(tmp_path / "l.sqlite3", FakeModel(), live=connector, tts=FakeTts()) as client:
        remember(client, u)
        text = first_instructions(client, connector, u)
        assert FACT in text and MEMORY_RULES in text
        assert text.index(MEMORY_RULES) < text.index(FACT)
        without = first_instructions(client, connector, u, memory="off")  # I2
        assert FACT not in without and MEMORY_RULES not in without


def test_shadow_mode_never_reaches_the_voice_model(tmp_path: Path) -> None:
    connector = FakeConnector()
    u = user()
    with make_client(tmp_path / "l.sqlite3", FakeModel(), live=connector, tts=FakeTts(), MEMORY_MODE="shadow") as client:
        remember(client, u)
        text = first_instructions(client, connector, u)
        assert FACT not in text and MEMORY_RULES not in text


def test_after_forget_all_the_next_turn_has_no_facts(tmp_path: Path) -> None:
    """«Забыть всё» посреди Live-разговора: следующий ход идёт в новой сессии без сводки (MEM-13.3)."""
    connector = FakeConnector()
    u = user()
    with make_client(tmp_path / "l.sqlite3", FakeModel(), live=connector, tts=FakeTts()) as client:
        remember(client, u)
        dialog = client.post(f"/v1/users/{u}/dialogs", headers=AUTH).json()
        with client.websocket_connect(ws_url(u, dialog["dialogId"]), headers=AUTH) as ws:
            read_frames(ws, lambda f: has(f, "ready"))
            wait(lambda: len(connector.links) == 1)
            assert FACT in connector.links[0].instructions
            assert client.delete(f"/v1/users/{u}/memory", headers=AUTH).status_code == 204
            send_user_message(ws, "c-1", "привет")
            read_frames(ws, lambda f: has(f, "assistant_end"))
        assert len(connector.links) >= 2
        assert FACT not in connector.links[-1].instructions and MEMORY_RULES not in connector.links[-1].instructions
        assert connector.links[0].closed


async def test_instructions_never_touch_the_disk_or_the_network(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Горячий путь хода (I3): сводка только из кэша процесса; база и сеть в `_instructions()` не трогаются."""
    store, db, service = await make_env(tmp_path / "h.sqlite3", FakeModel())
    u = user()
    await store.ensure_user(u)
    await enable(service, u)
    await service.add_fact(u, "works", FACT, None)
    await service.drain()
    dialog, _, _ = store.start(u)
    session = LiveDialogSession(None, store, dialog, lambda: None, FakeConnector())  # type: ignore[arg-type]

    def forbidden(*_: Any, **__: Any) -> Any:
        raise AssertionError("обращение к базе или сети на горячем пути")

    with monkeypatch.context() as patched:
        patched.setattr(type(db), "run", forbidden)
        patched.setattr(type(db), "load_user", forbidden)
        patched.setattr("sqlite3.connect", forbidden)
        patched.setattr("asyncio.to_thread", forbidden)
        patched.setattr("httpx.AsyncClient.send", forbidden)
        text = session._instructions()
        assert FACT in text
        started = time.perf_counter()
        for _ in range(1000):
            store.memory_brief(dialog)
        assert (time.perf_counter() - started) / 1000 < 0.001  # чтение сводки из кэша < 1 мс
    await close_env(store, service)


async def test_a_broken_cache_means_no_brief_not_a_broken_dialog(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    store, _, service = await make_env(tmp_path / "x.sqlite3", FakeModel())
    u = user()
    await store.ensure_user(u)
    await enable(service, u)
    await service.add_fact(u, "works", FACT, None)
    await service.drain()
    dialog, _, _ = store.start(u)

    def boom(*_: Any) -> Any:
        raise RuntimeError("кэш сломан")

    monkeypatch.setattr(service.cache, "get", boom)
    session = LiveDialogSession(None, store, dialog, lambda: None, FakeConnector())  # type: ignore[arg-type]
    text = session._instructions()
    assert FACT not in text and MEMORY_RULES not in text and text.startswith(SYSTEM_PROMPT)
    await close_env(store, service)
