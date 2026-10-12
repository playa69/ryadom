"""Режим VOICE_PIPELINE=gemini_live: речь в речь через Gemini Live (поддельная модель, без сети)."""

import asyncio
import json
from collections.abc import AsyncIterator, Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.clients.gemini_live import LiveError, LiveEvent
from app.main import create_app
from app.services.replies import CRISIS_REPLY
from tests.conftest import (
    AUTH,
    FAKE_PCM,
    FakeTts,
    audio_in_frame,
    has,
    read_frames,
    send_user_message,
    start_dialog,
    types,
    ws_url,
)


class FakeLink:
    """Соединение с моделью: на конец реплики отвечает заранее заданным текстом и звуком."""

    def __init__(self, voice: str, reply: str, heard: str, instructions: str, resume_handle: str | None = None) -> None:
        self.voice = voice
        self.closed = False
        self.instructions = instructions
        self.resume_handle = resume_handle
        self.handle_to_issue = "handle-1"  # handle сессии, который «выдаёт Google» после каждого ответа
        self.signal: str | None = None  # "go_away" | "drop": что Google делает после ответа
        self.commands: list[tuple[Any, ...]] = []
        self._reply = reply
        self._heard = heard
        self._queue: asyncio.Queue[LiveEvent] = asyncio.Queue()

    def _respond(self, heard: str | None) -> None:
        if heard:
            self._queue.put_nowait(LiveEvent("input_text", text=heard))
        for piece in re_split(self._reply):
            self._queue.put_nowait(LiveEvent("output_text", text=piece))
        self._queue.put_nowait(LiveEvent("audio", data=FAKE_PCM))
        self._queue.put_nowait(LiveEvent("audio", data=FAKE_PCM))
        self._queue.put_nowait(LiveEvent("generation_complete"))
        self._queue.put_nowait(LiveEvent("resumption", text=self.handle_to_issue))
        if self.signal == "go_away":
            self._queue.put_nowait(LiveEvent("go_away", text="30s"))
        elif self.signal == "drop":
            self._queue.put_nowait(LiveEvent("closed", text="соединение закрыто Google"))

    async def activity_start(self) -> None:
        self.commands.append(("start",))

    async def send_audio(self, pcm: bytes) -> None:
        self.commands.append(("audio", len(pcm)))

    async def activity_end(self) -> None:
        self.commands.append(("end",))
        self._respond(self._heard)

    async def send_text(self, text: str) -> None:
        self.commands.append(("text", text))
        self._respond(None)

    async def events(self) -> AsyncIterator[LiveEvent]:
        while True:
            event = await self._queue.get()
            yield event
            if event.kind == "closed":
                return

    async def aclose(self) -> None:
        self.closed = True


def re_split(text: str) -> list[str]:
    """Ответ кусками, как расшифровка модели: слова с пробелом на стыке."""
    words = text.split(" ")
    return [w + (" " if i < len(words) - 1 else "") for i, w in enumerate(words)]


class FakeConnector:
    name = "fake-live"

    def __init__(
        self,
        reply: str = "Понимаю, это непросто. Что сейчас тревожит больше всего?",
        heard: str = "мне сегодня тяжело",
        fail: bool = False,
        reject_handles: bool = False,
        after_first_reply: str | None = None,
    ) -> None:
        self.reply = reply
        self.heard = heard
        self.fail = fail
        self.reject_handles = reject_handles  # Google не принимает handle (устарел)
        self.after_first_reply = after_first_reply  # "go_away" | "drop": судьба первого соединения
        self.links: list[FakeLink] = []
        self.open_calls: list[tuple[str, str | None]] = []

    async def open(self, voice: str, instructions: str, resume_handle: str | None = None) -> FakeLink:
        self.open_calls.append((voice, resume_handle))
        if self.fail or (resume_handle and self.reject_handles):
            raise LiveError("Gemini Live не открылся в тесте")
        link = FakeLink(voice, self.reply, self.heard, instructions, resume_handle)
        if not self.links:
            link.signal = self.after_first_reply
        self.links.append(link)
        return link

    async def aclose(self) -> None:
        return None


def make_live_client(connector: FakeConnector, tts: Any = None) -> TestClient:
    return TestClient(create_app(lambda: tts, lambda: (None, None), live_factory=lambda: connector))


@pytest.fixture
def connector() -> FakeConnector:
    return FakeConnector()


@pytest.fixture
def live_client(connector: FakeConnector) -> Iterator[TestClient]:
    with make_live_client(connector, FakeTts()) as c:
        yield c


def deltas_text(frames: list[Any], message_id: str) -> str:
    return "".join(f[1]["text"] for f in frames if f[0] == "json" and f[1]["type"] == "assistant_delta" and f[1]["messageId"] == message_id)


def reply_done(frames: list[Any]) -> bool:
    """Ответ дошёл до конца: assistant_end и tts_end именно этого сообщения (не приветствия)."""
    ends = [f[1] for f in frames if f[0] == "json" and f[1]["type"] == "assistant_end"]
    return bool(ends) and has(frames, "tts_end", messageId=ends[-1]["messageId"])


def speak_turn(ws: Any, loud: int = 4) -> None:
    ws.send_text(json.dumps({"type": "audio_start"}))
    for i in range(loud):
        ws.send_bytes(audio_in_frame(i, loud=True))
    ws.send_text(json.dumps({"type": "audio_end"}))


def test_health_shows_pipeline(live_client: TestClient) -> None:
    body = live_client.get("/health/ready").json()
    assert body["pipeline"] == "fake-live"
    assert body["llm"] == "none" and body["stt"] == "none"


def test_text_message_is_answered_by_the_model(live_client: TestClient, connector: FakeConnector, user_id: str) -> None:
    dialog = start_dialog(live_client, user_id)
    with live_client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
        send_user_message(ws, "c-1", "Мне сегодня тревожно")
        frames = read_frames(ws, reply_done)
    assert "ack" in types(frames)
    end = next(f[1] for f in frames if f[0] == "json" and f[1]["type"] == "assistant_end")
    assert end["text"] == connector.reply
    assert deltas_text(frames, end["messageId"]) == end["text"]  # дельты в сумме дают ровно текст
    assert has(frames, "tts_start", messageId=end["messageId"])
    assert sum(1 for f in frames if f[0] == "bin" and f[1][0] == 0x02) >= 2
    link = connector.links[0]
    assert ("text", "Мне сегодня тревожно") in link.commands
    # ответ лежит в истории диалога
    history = live_client.get(f"/v1/users/{user_id}/dialogs/{dialog['dialogId']}", headers=AUTH).json()["messages"]
    assert [m["role"] for m in history] == ["user", "assistant"]
    assert history[1]["text"] == connector.reply


def test_voice_turn_goes_to_the_model_and_back(live_client: TestClient, connector: FakeConnector, user_id: str) -> None:
    dialog = start_dialog(live_client, user_id)
    with live_client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
        speak_turn(ws)
        frames = read_frames(ws, reply_done)
    transcript = next(f[1] for f in frames if f[0] == "json" and f[1]["type"] == "transcript")
    assert transcript["final"] is True and transcript["text"] == "мне сегодня тяжело" and transcript["messageId"]
    order = types(frames)
    reply_id = next(f[1]["messageId"] for f in frames if f[0] == "json" and f[1]["type"] == "assistant_end")
    tts_at = next(i for i, f in enumerate(frames) if f[0] == "json" and f[1]["type"] == "tts_start" and f[1]["messageId"] == reply_id)
    assert order.index("transcript") < order.index("assistant_start") < order.index("assistant_end")
    assert next(i for i, f in enumerate(frames) if f[0] == "json" and f[1]["type"] == "transcript") < tts_at
    kinds = [c[0] for c in connector.links[0].commands]
    assert kinds[0] == "start" and kinds[-1] == "end" and kinds.count("audio") == 4


def test_silent_recording_never_reaches_the_model(live_client: TestClient, connector: FakeConnector, user_id: str) -> None:
    dialog = start_dialog(live_client, user_id)
    with live_client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
        ws.send_text(json.dumps({"type": "audio_start"}))
        for i in range(5):
            ws.send_bytes(audio_in_frame(i, loud=False))
        ws.send_text(json.dumps({"type": "audio_end"}))
        frames = read_frames(ws, lambda f: has(f, "transcript"))
    assert has(frames, "transcript", text="", final=True)
    commands = [c for link in connector.links for c in link.commands]
    assert commands == []


def test_crisis_in_speech_replaces_the_model_answer(user_id: str) -> None:
    connector = FakeConnector(reply="Это ответ модели, которого человек слышать не должен.", heard="я больше не хочу жить")
    with make_live_client(connector, FakeTts()) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            speak_turn(ws)
            frames = read_frames(ws, reply_done)
    assert has(frames, "safety")
    end = next(f[1] for f in frames if f[0] == "json" and f[1]["type"] == "assistant_end")
    assert end["text"] == CRISIS_REPLY
    assert "Это ответ модели" not in json.dumps([f[1] for f in frames if f[0] == "json"], ensure_ascii=False)


def test_crisis_in_text_does_not_go_to_the_model(user_id: str) -> None:
    connector = FakeConnector()
    with make_live_client(connector, FakeTts()) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            send_user_message(ws, "c-1", "я хочу покончить с собой")
            frames = read_frames(ws, lambda f: has(f, "assistant_end"))
    assert has(frames, "safety")
    assert next(f[1] for f in frames if f[0] == "json" and f[1]["type"] == "assistant_end")["text"] == CRISIS_REPLY
    assert all(c[0] != "text" for link in connector.links for c in link.commands)


def test_model_down_text_still_gets_an_answer(user_id: str) -> None:
    connector = FakeConnector(fail=True)
    with make_live_client(connector, None) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            send_user_message(ws, "c-1", "Привет")
            frames = read_frames(ws, lambda f: has(f, "assistant_end"))
    assert has(frames, "error", code="VOICE_UNAVAILABLE")
    assert has(frames, "assistant_end")  # шаблонный ответ, человек не остаётся без ответа


def two_messages(client: TestClient, user_id: str) -> list[Any]:
    dialog = start_dialog(client, user_id)
    with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
        send_user_message(ws, "c-1", "Первая реплика")
        first = read_frames(ws, reply_done)
        send_user_message(ws, "c-2", "Вторая реплика")
        second = read_frames(ws, reply_done)
    return first + second


def test_go_away_reopens_the_session_with_the_handle(user_id: str) -> None:
    connector = FakeConnector(after_first_reply="go_away")
    with make_live_client(connector, FakeTts()) as client:
        frames = two_messages(client, user_id)
    assert connector.open_calls == [("male", None), ("male", "handle-1")]
    assert "Первая реплика" not in connector.links[1].instructions  # контекст у возобновлённой сессии свой, текстом не дублируем
    assert not has(frames, "error")


def test_dropped_connection_between_turns_is_silent_and_resumed(user_id: str) -> None:
    connector = FakeConnector(after_first_reply="drop")
    with make_live_client(connector, FakeTts()) as client:
        frames = two_messages(client, user_id)
    assert not has(frames, "error")  # человек ничего не заметил
    assert connector.open_calls == [("male", None), ("male", "handle-1")]


def test_rejected_handle_falls_back_to_the_history(user_id: str) -> None:
    connector = FakeConnector(after_first_reply="drop", reject_handles=True)
    with make_live_client(connector, FakeTts()) as client:
        two_messages(client, user_id)
    assert connector.open_calls == [("male", None), ("male", "handle-1"), ("male", None)]
    assert "Первая реплика" in connector.links[-1].instructions  # handle не принят: контекст вернулся текстом


def test_session_config_has_compression_and_resumption() -> None:
    from app.clients.gemini_live import live_config
    from app.core.config import APP_CONFIG, GeminiSettings

    config = live_config(APP_CONFIG.gemini, "Kore", "промпт", "h-1")
    assert config.context_window_compression is not None and config.context_window_compression.sliding_window is not None
    assert config.session_resumption is not None and config.session_resumption.handle == "h-1"
    assert config.realtime_input_config.automatic_activity_detection.disabled is True  # границы реплик задаёт клиент
    assert config.output_audio_transcription is not None and config.input_audio_transcription is not None
    assert config.thinking_config is None  # по умолчанию (-1) параметр не отправляется: как решит Google

    off = live_config(GeminiSettings.model_validate({"GEMINI_THINKING_BUDGET": 0}), "Kore", "x")
    assert off.thinking_config is not None and off.thinking_config.thinking_budget == 0  # размышление выключено: быстрее на ~0,2 с

    plain = live_config(GeminiSettings.model_validate({"GEMINI_COMPRESSION": False, "GEMINI_SESSION_RESUMPTION": False}), "Kore", "x")
    assert plain.context_window_compression is None and plain.session_resumption is None

    tuned = live_config(
        GeminiSettings.model_validate({"GEMINI_COMPRESSION_TRIGGER_TOKENS": 90000, "GEMINI_COMPRESSION_TARGET_TOKENS": 40000}), "Kore", "x"
    )
    assert tuned.context_window_compression.trigger_tokens == 90000
    assert tuned.context_window_compression.sliding_window.target_tokens == 40000


def test_voice_change_reconnects_with_the_history(live_client: TestClient, connector: FakeConnector, user_id: str) -> None:
    dialog = start_dialog(live_client, user_id)
    with live_client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
        send_user_message(ws, "c-1", "Первая реплика")
        read_frames(ws, reply_done)
        ws.send_text(json.dumps({"type": "set_voice", "voice": "female"}))
        send_user_message(ws, "c-2", "Вторая реплика")
        read_frames(ws, reply_done)
    assert [link.voice for link in connector.links][:1] == ["male"]
    second = next(link for link in connector.links if link.voice == "female" and any(c[0] == "text" for c in link.commands))
    assert "Первая реплика" in second.instructions  # новое соединение помнит, о чём шла речь
    assert "Вторая реплика" not in second.instructions  # а текущая реплика уходит отдельно, не дублируется
