"""Режим gemini_live: речь в речь через Gemini Live (поддельная модель, без сети)."""

import asyncio
import json
import logging
from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.clients.gemini_live import LiveError, LiveEvent
from app.core.config import APP_CONFIG
from app.main import create_app
from app.services.replies import CRISIS_REPLY
from tests.conftest import (
    components,
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
from tests.fake_live import QUOTA_TEXT, FakeConnector, FakeLink, deltas_text, re_split, reply_done, speak_turn


def make_live_client(connector: FakeConnector, tts: Any = None) -> TestClient:
    return TestClient(create_app(lambda: tts, lambda: (None, None), live_factory=lambda: connector))


@pytest.fixture(autouse=True)
def pinned_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    """Настройки live не зависят от .env разработчика; сессия меняется после каждого ответа (так проще считать открытия)."""
    for name, value in (("history_messages", 40), ("rotate_every", 1)):
        monkeypatch.setattr(APP_CONFIG.gemini, name, value)


@pytest.fixture
def connector() -> FakeConnector:
    return FakeConnector()


@pytest.fixture
def live_client(connector: FakeConnector) -> Iterator[TestClient]:
    with make_live_client(connector, FakeTts()) as c:
        yield c


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


def answered_and_counted(frames: list[Any]) -> bool:
    """Ответ дозвучал и обращение к модели засчитано: два кадра приходят в любом порядке, оба нужны."""
    return reply_done(frames) and ("live", "ok", False) in components(frames)


def test_one_turn_is_one_live_call_and_one_safety_check(live_client: TestClient, connector: FakeConnector, user_id: str) -> None:
    """Речь в речь: распознавания и озвучки отдельно нет, ход — одно обращение к модели и одна проверка безопасности."""
    dialog = start_dialog(live_client, user_id)
    with live_client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
        send_user_message(ws, "c-1", "Мне сегодня тревожно")
        frames = read_frames(ws, answered_and_counted)
    assert sorted(components(frames)) == [("live", "ok", False), ("safety", "ok", False)]


def test_a_spoken_turn_is_checked_for_safety_once_however_many_pieces_it_was_heard_in(
    live_client: TestClient, connector: FakeConnector, user_id: str
) -> None:
    dialog = start_dialog(live_client, user_id)
    with live_client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
        speak_turn(ws)
        frames = read_frames(ws, answered_and_counted)
    found = components(frames)
    assert found.count(("safety", "ok", False)) == 1
    assert found.count(("live", "ok", False)) == 1


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


def test_model_down_text_gets_one_error_and_no_template(user_id: str) -> None:
    """Gemini не открывается: агент пробует ещё раз (повторная просьба) и, не открыв сессию, сообщает об этом одним error.
    Шаблона вместо ответа нет: он звучал невпопад."""
    connector = FakeConnector(fail=True)
    with make_live_client(connector, None) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            send_user_message(ws, "c-1", "Привет")
            frames = read_frames(ws, lambda f: has(f, "error"))
        messages = client.get(f"/v1/users/{user_id}/dialogs/{dialog['dialogId']}", headers=AUTH).json()["messages"]
    assert has(frames, "error", code="VOICE_UNAVAILABLE")
    assert not has(frames, "assistant_start")
    assert [m["role"] for m in messages] == ["user"]
    assert len(connector.open_calls) >= 2  # повторная попытка была


def two_messages(client: TestClient, user_id: str) -> list[Any]:
    dialog = start_dialog(client, user_id)
    with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
        send_user_message(ws, "c-1", "Первая реплика")
        first = read_frames(ws, reply_done)
        send_user_message(ws, "c-2", "Вторая реплика")
        second = read_frames(ws, reply_done)
    return first + second


def test_go_away_reopens_the_session_with_the_history(user_id: str) -> None:
    connector = FakeConnector(after_first_reply="go_away")
    with make_live_client(connector, FakeTts()) as client:
        frames = two_messages(client, user_id)
    assert connector.open_calls == ["male", "male"]
    # Контекст новой сессии приходит текстом (handle'ов нет): прошлый обмен загружен в неё отдельными репликами.
    assert connector.links[1].history == [("user", "Первая реплика"), ("model", connector.reply)]
    assert "Первая реплика" not in connector.links[1].instructions
    assert not has(frames, "error")


def test_dropped_connection_between_turns_is_silent_and_reopened(user_id: str) -> None:
    connector = FakeConnector(after_first_reply="drop")
    with make_live_client(connector, FakeTts()) as client:
        frames = two_messages(client, user_id)
    assert not has(frames, "error")  # человек ничего не заметил
    assert connector.open_calls == ["male", "male"]
    assert connector.links[1].history == [("user", "Первая реплика"), ("model", connector.reply)]


def test_session_config_has_compression_and_no_resumption() -> None:
    from app.clients.gemini_live import live_config
    from app.core.config import GeminiSettings

    config = live_config(GeminiSettings(), "Kore", "промпт")
    assert config.context_window_compression is not None and config.context_window_compression.sliding_window is not None
    # Возобновления по handle нет: контекст новой сессии приходит текстом, а handle вернул бы накопленное аудио.
    assert config.session_resumption is None
    assert config.realtime_input_config.automatic_activity_detection.disabled is True  # границы реплик задаёт клиент
    assert config.output_audio_transcription is not None and config.input_audio_transcription is not None
    assert config.thinking_config is None  # по умолчанию (-1) параметр не отправляется: как решит Google

    off = live_config(GeminiSettings.model_validate({"GEMINI_THINKING_BUDGET": 0}), "Kore", "x")
    assert off.thinking_config is not None and off.thinking_config.thinking_budget == 0  # размышление выключено: быстрее на ~0,2 с

    tuned = live_config(
        GeminiSettings.model_validate({"GEMINI_COMPRESSION_TRIGGER_TOKENS": 90000, "GEMINI_COMPRESSION_TARGET_TOKENS": 40000}), "Kore", "x"
    )
    assert tuned.context_window_compression.trigger_tokens == 90000
    assert tuned.context_window_compression.sliding_window.target_tokens == 40000

    with_history = live_config(GeminiSettings(), "Kore", "x", history=True)
    assert with_history.history_config is not None and with_history.history_config.initial_history_in_client_content is True


def test_every_session_open_is_logged_with_its_voice(
    live_client: TestClient, connector: FakeConnector, user_id: str, caplog: pytest.LogCaptureFixture
) -> None:
    """Если человеку показалось, что голос сменился, это видно по журналу: диалог, цель открытия, голос и его имя у Google."""
    caplog.set_level(logging.INFO, logger="agent.live")
    dialog = start_dialog(live_client, user_id)
    with live_client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
        send_user_message(ws, "c-1", "Первая реплика")
        read_frames(ws, reply_done)
        ws.send_text(json.dumps({"type": "set_voice", "voice": "female"}))
        send_user_message(ws, "c-2", "Вторая реплика")
        read_frames(ws, reply_done)
    opened = [r.getMessage() for r in caplog.records if r.getMessage().startswith("gemini live opened")]
    assert opened[0].startswith(f"gemini live opened dialog={dialog['dialogId']} purpose=start voice=male voice_name=fake-male ")
    assert any("purpose=voice voice=female voice_name=fake-female" in line for line in opened)
    assert all(f"model={APP_CONFIG.gemini.live_model} " in line and " ms=" in line for line in opened)
    assert not any("Первая реплика" in line or "Вторая реплика" in line for line in opened)  # тексты реплик в журнал не идут


def test_voice_change_reconnects_with_the_history(
    live_client: TestClient, connector: FakeConnector, user_id: str
) -> None:
    dialog = start_dialog(live_client, user_id)
    with live_client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
        send_user_message(ws, "c-1", "Первая реплика")
        read_frames(ws, reply_done)
        ws.send_text(json.dumps({"type": "set_voice", "voice": "female"}))
        send_user_message(ws, "c-2", "Вторая реплика")
        read_frames(ws, reply_done)
    assert [link.voice for link in connector.links][:1] == ["male"]
    second = next(link for link in connector.links if link.voice == "female" and any(c[0] == "text" for c in link.commands))
    assert "Вторая реплика" not in second.instructions  # текущая реплика уходит отдельно, не дублируется
    assert "Вторая реплика" not in json.dumps(second.history or [], ensure_ascii=False)
    # новое соединение помнит, о чём шла речь: прошлые реплики загружены в сессию, в промпте их нет
    assert second.history == [("user", "Первая реплика"), ("model", connector.reply)]
    assert "Первая реплика" not in second.instructions
