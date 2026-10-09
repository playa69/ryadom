"""Интеграционные тесты REST и WS API: реальный Postgres, фейковый LLM, InMemorySaver."""

import uuid
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager

import pytest
from fastapi import FastAPI
from langgraph.checkpoint.memory import InMemorySaver
from starlette.testclient import TestClient, WebSocketDenialResponse
from starlette.websockets import WebSocketDisconnect

from app.api.deps import AppContext
from app.api.internal.router import router as internal_router
from app.api.internal.ws import AUDIO_FRAME_KIND_USER, router as ws_router
from app.graph.turn_graph import build_turn_graph
from app.services.dialogs import DialogStore

AUTH = {"Authorization": "Bearer test-internal-token"}
REPLY_TEXT = "Я рядом и слышу тебя."
TRANSCRIPT_TEXT = "голосовая реплика"


class FakeLLM:
    """Детерминированный LLM: фиксированный ответ и «транскрибация»."""

    def __init__(self) -> None:
        self.chat_calls: list[list[dict[str, str]]] = []
        self.transcribe_models: list[str] = []

    async def complete(
        self, messages: list[dict[str, str]], model: str, *, max_tokens: int = 800
    ) -> str:
        self.chat_calls.append(messages)
        return REPLY_TEXT

    async def transcribe(self, audio: bytes, *, filename: str, model: str) -> str:
        self.transcribe_models.append(model)
        return TRANSCRIPT_TEXT

    async def aclose(self) -> None:
        return None


@pytest.fixture
def client(pg_dsn: str) -> Iterator[tuple[TestClient, FakeLLM]]:
    """TestClient приложения с подменённым ctx: фейковый LLM + store на docker Postgres."""
    llm = FakeLLM()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        store = await DialogStore.create(pg_dsn)
        graph = build_turn_graph(llm, model="test-chat-model", checkpointer=InMemorySaver())
        app.state.ctx = AppContext(llm=llm, store=store, checkpointer=None, graph=graph)
        yield
        await store.close()

    app = FastAPI(lifespan=lifespan)
    app.include_router(internal_router)
    app.include_router(ws_router)
    with TestClient(app) as test_client:
        yield test_client, llm


def _user_id() -> str:
    return f"user-{uuid.uuid4()}"


def _start_dialog(client: TestClient, user_id: str) -> str:
    response = client.post(f"/v1/users/{user_id}/dialogs", headers=AUTH)
    assert response.status_code == 200
    return response.json()["dialogId"]


def _receive_until(socket, frame_type: str) -> dict:
    """Читает кадры сокета до первого кадра нужного типа."""
    while True:
        frame = socket.receive_json()
        if frame["type"] == frame_type:
            return frame


# ─── REST ─────────────────────────────────────────────────────────────────────


def test_rest_requires_token(client: tuple[TestClient, FakeLLM]) -> None:
    """Без Bearer-токена — 401 на всех REST-эндпоинтах."""
    test_client, _ = client
    user = _user_id()
    assert test_client.post(f"/v1/users/{user}/dialogs").status_code == 401
    assert test_client.get(f"/v1/users/{user}/dialogs").status_code == 401
    assert test_client.get(f"/v1/users/{user}/dialogs/{uuid.uuid4()}").status_code == 401
    assert test_client.post(f"/v1/users/{user}/dialogs/{uuid.uuid4()}/end").status_code == 401
    assert test_client.delete(f"/v1/users/{user}").status_code == 401
    wrong = {"Authorization": "Bearer wrong-token"}
    assert test_client.post(f"/v1/users/{user}/dialogs", headers=wrong).status_code == 401


def test_rest_dialog_lifecycle(client: tuple[TestClient, FakeLLM]) -> None:
    """start → resume → list → get → end → erase: camelCase-контракт node-мока."""
    test_client, _ = client
    user = _user_id()

    started = test_client.post(f"/v1/users/{user}/dialogs", headers=AUTH)
    assert started.status_code == 200
    body = started.json()
    assert body["resumed"] is False
    assert body["greeting"] == "Я рядом. С чего начнём?"
    assert body["sinceLastDialogHours"] is None
    dialog_id = body["dialogId"]

    resumed = test_client.post(f"/v1/users/{user}/dialogs", headers=AUTH).json()
    assert resumed["resumed"] is True
    assert resumed["dialogId"] == dialog_id

    listing = test_client.get(f"/v1/users/{user}/dialogs", headers=AUTH)
    assert listing.status_code == 200
    items = listing.json()["items"]
    assert [item["dialogId"] for item in items] == [dialog_id]
    assert items[0]["endedAt"] is None

    detail = test_client.get(f"/v1/users/{user}/dialogs/{dialog_id}", headers=AUTH)
    assert detail.status_code == 200
    assert detail.json()["messages"] == []

    ended = test_client.post(
        f"/v1/users/{user}/dialogs/{dialog_id}/end",
        headers=AUTH,
        json={"takeaway": "Стало легче", "tensionAfter": 3},
    )
    assert ended.status_code == 200
    summary = ended.json()["summary"]
    assert summary["title"] == "Стало легче"
    assert summary["tensionAfter"] == 3

    erased = test_client.delete(f"/v1/users/{user}", headers=AUTH)
    assert erased.status_code == 204
    assert test_client.get(f"/v1/users/{user}/dialogs", headers=AUTH).json()["items"] == []


def test_rest_unknown_and_broken_dialog_is_404(client: tuple[TestClient, FakeLLM]) -> None:
    """Чужой, несуществующий и битый (не-UUID) dialog_id — 404 dialog_not_found."""
    test_client, _ = client
    user = _user_id()
    dialog_id = _start_dialog(test_client, user)

    for broken in ("not-a-uuid", str(uuid.uuid4())):
        response = test_client.get(f"/v1/users/{user}/dialogs/{broken}", headers=AUTH)
        assert response.status_code == 404
        assert response.json() == {"error": "dialog_not_found"}
        response = test_client.post(f"/v1/users/{user}/dialogs/{broken}/end", headers=AUTH)
        assert response.status_code == 404
        assert response.json() == {"error": "dialog_not_found"}

    stranger = test_client.get(f"/v1/users/{_user_id()}/dialogs/{dialog_id}", headers=AUTH)
    assert stranger.status_code == 404
    assert stranger.json() == {"error": "dialog_not_found"}


# ─── WebSocket ────────────────────────────────────────────────────────────────


def test_ws_requires_token(client: tuple[TestClient, FakeLLM]) -> None:
    """Рукопожатие без токена отклоняется с 401."""
    test_client, _ = client
    user = _user_id()
    dialog_id = _start_dialog(test_client, user)
    with pytest.raises(WebSocketDenialResponse) as denial:
        with test_client.websocket_connect(f"/v1/users/{user}/dialogs/{dialog_id}/ws"):
            pass
    assert denial.value.status_code == 401


def test_ws_unknown_dialog_is_404(client: tuple[TestClient, FakeLLM]) -> None:
    """Несуществующий и битый dialog_id отклоняются с 404 до accept."""
    test_client, _ = client
    user = _user_id()
    for broken in ("not-a-uuid", str(uuid.uuid4())):
        with pytest.raises(WebSocketDenialResponse) as denial:
            with test_client.websocket_connect(
                f"/v1/users/{user}/dialogs/{broken}/ws", headers=AUTH
            ):
                pass
        assert denial.value.status_code == 404


def test_ws_text_turn(client: tuple[TestClient, FakeLLM]) -> None:
    """Текстовый ход: ready → ack → assistant_start/delta/end, сообщения в журнале."""
    test_client, llm = client
    user = _user_id()
    dialog_id = _start_dialog(test_client, user)

    with test_client.websocket_connect(
        f"/v1/users/{user}/dialogs/{dialog_id}/ws", headers=AUTH
    ) as socket:
        assert socket.receive_json() == {"v": 1, "type": "ready"}
        socket.send_json({"type": "user_message", "id": "client-1", "text": "Мне тревожно"})

        ack = socket.receive_json()
        assert ack["type"] == "ack"
        assert ack["id"] == "client-1"
        message_id = ack["messageId"]

        start = socket.receive_json()
        assert start["type"] == "assistant_start"
        assistant_id = start["messageId"]

        delta_text = ""
        while True:
            frame = socket.receive_json()
            if frame["type"] == "assistant_delta":
                assert frame["messageId"] == assistant_id
                delta_text += frame["text"]
            elif frame["type"] == "assistant_end":
                assert frame["text"] == REPLY_TEXT
                break
        assert delta_text.strip() == REPLY_TEXT

        # Повтор с тем же client id — тот же messageId, без нового хода.
        socket.send_json({"type": "user_message", "id": "client-1", "text": "Мне тревожно"})
        repeated = socket.receive_json()
        assert repeated == {"v": 1, "type": "ack", "id": "client-1", "messageId": message_id}

    assert llm.chat_calls[0][-1] == {"role": "user", "content": "Мне тревожно"}
    assert llm.chat_calls[0][0]["role"] == "system"

    detail = test_client.get(f"/v1/users/{user}/dialogs/{dialog_id}", headers=AUTH).json()
    assert [(m["role"], m["text"]) for m in detail["messages"]] == [
        ("user", "Мне тревожно"),
        ("assistant", REPLY_TEXT),
    ]


def test_ws_voice_turn(client: tuple[TestClient, FakeLLM]) -> None:
    """Голосовой ход: бинарные PCM-кадры → transcript → ответ ассистента."""
    test_client, llm = client
    user = _user_id()
    dialog_id = _start_dialog(test_client, user)

    with test_client.websocket_connect(
        f"/v1/users/{user}/dialogs/{dialog_id}/ws", headers=AUTH
    ) as socket:
        assert socket.receive_json()["type"] == "ready"
        socket.send_json({"type": "audio_start"})
        for seq in range(3):
            header = bytes([AUDIO_FRAME_KIND_USER]) + seq.to_bytes(4, "big")
            socket.send_bytes(header + b"\x00\x01" * 1600)
        socket.send_json({"type": "audio_end"})

        transcript = socket.receive_json()
        assert transcript["type"] == "transcript"
        assert transcript["text"] == TRANSCRIPT_TEXT
        assert transcript["final"] is True
        assert transcript["messageId"]

        end = _receive_until(socket, "assistant_end")
        assert end["text"] == REPLY_TEXT

    assert llm.transcribe_models == ["openai/whisper-large-v3"]
    assert llm.chat_calls[0][-1] == {"role": "user", "content": TRANSCRIPT_TEXT}

    detail = test_client.get(f"/v1/users/{user}/dialogs/{dialog_id}", headers=AUTH).json()
    assert [(m["role"], m["text"]) for m in detail["messages"]] == [
        ("user", TRANSCRIPT_TEXT),
        ("assistant", REPLY_TEXT),
    ]


def test_ws_bad_and_unknown_frames(client: tuple[TestClient, FakeLLM]) -> None:
    """Битый JSON — BAD_FRAME, неизвестный тип — UNKNOWN_FRAME."""
    test_client, _ = client
    user = _user_id()
    dialog_id = _start_dialog(test_client, user)

    with test_client.websocket_connect(
        f"/v1/users/{user}/dialogs/{dialog_id}/ws", headers=AUTH
    ) as socket:
        assert socket.receive_json()["type"] == "ready"
        socket.send_text("not json")
        frame = socket.receive_json()
        assert frame["type"] == "error"
        assert frame["code"] == "BAD_FRAME"

        socket.send_json({"type": "teleport"})
        frame = socket.receive_json()
        assert frame["type"] == "error"
        assert frame["code"] == "UNKNOWN_FRAME"


def test_ws_end_frame_closes_with_summary(client: tuple[TestClient, FakeLLM]) -> None:
    """Кадр end: summary диалога и закрытие сокета кодом 1000."""
    test_client, _ = client
    user = _user_id()
    dialog_id = _start_dialog(test_client, user)

    with test_client.websocket_connect(
        f"/v1/users/{user}/dialogs/{dialog_id}/ws", headers=AUTH
    ) as socket:
        assert socket.receive_json()["type"] == "ready"
        socket.send_json({"type": "user_message", "id": "c1", "text": "Просто выговориться"})
        _receive_until(socket, "assistant_end")
        socket.send_json({"type": "end", "takeaway": "Отпустило", "tensionAfter": 2})

        ended = socket.receive_json()
        assert ended["type"] == "ended"
        assert ended["summary"]["title"] == "Отпустило"
        assert ended["summary"]["tensionAfter"] == 2
        with pytest.raises(WebSocketDisconnect) as disconnect:
            socket.receive_json()
        assert disconnect.value.code == 1000

    detail = test_client.get(f"/v1/users/{user}/dialogs/{dialog_id}", headers=AUTH).json()
    assert detail["endedAt"] is not None
    assert detail["summary"]["title"] == "Отпустило"
