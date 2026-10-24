"""Прототип PROTEUS-168: модель Gemini Live молча сообщает тон человека (`report_mood`), агент шлёт клиенту кадр `mood`,
а риск `self_harm` / `harm_others` включает кризисный путь независимо от списка слов. Поддельная модель, без сети."""

from typing import Any

import pytest

from app.clients.gemini_live import LiveEvent, live_config, parse_mood
from app.core.config import APP_CONFIG
from app.services.replies import CRISIS_REPLY
from tests.conftest import AUTH, FakeTts, has, read_frames, start_dialog, ws_url
from tests.test_live import FakeConnector, FakeLink, make_live_client, reply_done, speak_turn
from tests.test_live_feedback import LinkConnector


class MoodLink(FakeLink):
    """Как настоящая модель: после расшифровки реплики вызывает report_mood, потом отвечает."""

    mood: dict[str, Any] | None = {"tone": "angry", "intensity": 0.8, "risk": "none", "replyTone": "calm"}

    def _respond(self, heard: str | None) -> None:
        if heard:
            self._queue.put_nowait(LiveEvent("input_text", text=heard))
        if self.mood is not None:
            self._queue.put_nowait(LiveEvent("mood", mood=self.mood, tool_call_id="fc_1"))
        super()._respond(None)


class HarmLink(MoodLink):
    mood = {"tone": "angry", "intensity": 0.9, "risk": "harm_others", "replyTone": "calm"}


def moods(frames: list[Any]) -> list[dict[str, Any]]:
    return [f[1] for f in frames if f[0] == "json" and f[1]["type"] == "mood"]


def run_turn(link_class: type[FakeLink], user_id: str, heard: str = "меня всё бесит") -> list[Any]:
    connector = LinkConnector(reply="Слышу, как тебя это злит. Что случилось?", heard=heard)
    connector.link_class = link_class
    with make_live_client(connector, FakeTts()) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            speak_turn(ws)
            return read_frames(ws, reply_done)


def test_report_mood_reaches_the_client_as_a_mood_frame(user_id: str) -> None:
    frames = run_turn(MoodLink, user_id)
    frame = moods(frames)[0]
    assert (frame["tone"], frame["intensity"], frame["risk"], frame["replyTone"]) == ("angry", 0.8, "none", "calm")
    assert isinstance(frame["at"], int)
    assert not has(frames, "safety")  # тон сам по себе кризис не включает


def test_mood_risk_switches_on_the_crisis_path_without_crisis_words(user_id: str) -> None:
    frames = run_turn(HarmLink, user_id, heard="он меня достал, я его накажу")
    assert has(frames, "safety")
    end = next(f[1] for f in frames if f[0] == "json" and f[1]["type"] == "assistant_end")
    assert end["text"] == CRISIS_REPLY
    assert "Слышу, как тебя это злит" not in end["text"]


def test_a_turn_without_mood_is_unchanged(user_id: str) -> None:
    class NoMood(MoodLink):
        mood = None

    frames = run_turn(NoMood, user_id)
    assert moods(frames) == []
    assert has(frames, "assistant_end")


def test_parse_mood_distrusts_the_model() -> None:
    assert parse_mood({"tone": "furious", "intensity": 1}) is None
    assert parse_mood(None) is None
    parsed = parse_mood({"tone": "afraid", "intensity": 7, "risk": "bomb", "reply_tone": "x"})
    assert parsed == {"tone": "afraid", "intensity": 1.0, "risk": "none", "replyTone": None}
    assert parse_mood({"tone": "sleepy", "intensity": "много"})["intensity"] == 0.0  # type: ignore[index]


def test_the_tool_is_declared_only_when_enabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(APP_CONFIG.gemini, "api_key", None)
    off = live_config(APP_CONFIG.gemini, "Kore", "x")
    assert not off.tools
    monkeypatch.setattr(APP_CONFIG.gemini, "mood_tool", True)
    on = live_config(APP_CONFIG.gemini, "Kore", "x")
    declaration = on.tools[0].function_declarations[0]
    assert declaration.name == "report_mood" and declaration.behavior.name == "NON_BLOCKING"


def test_a_tool_call_message_from_google_becomes_a_mood_event() -> None:
    from google.genai import types

    from app.clients.gemini_live import _translate

    message = types.LiveServerMessage(
        tool_call=types.LiveServerToolCall(
            function_calls=[
                types.FunctionCall(
                    id="fc_9", name="report_mood", args={"tone": "sleepy", "intensity": 0.6, "risk": "none"}
                ),
                types.FunctionCall(id="fc_10", name="other", args={}),
            ]
        )
    )
    events = _translate(message)
    assert [(e.kind, e.tool_call_id) for e in events] == [("mood", "fc_9")]
    assert events[0].mood["tone"] == "sleepy"  # type: ignore[index]


def test_the_classifier_sends_a_mood_frame_without_touching_the_answer(user_id: str, monkeypatch: pytest.MonkeyPatch) -> None:
    """Классификатор по расшифровке (GEMINI_MOOD_CLASSIFIER): mood приходит кадром, ответ модели идёт как обычно."""
    from pydantic import SecretStr

    from app.clients import mood_classifier

    async def fake(self: object, text: str) -> dict:
        return {"tone": "afraid", "intensity": 0.7, "risk": "none", "replyTone": None}

    monkeypatch.setattr(mood_classifier.MoodClassifier, "__init__", lambda self, settings: None)
    monkeypatch.setattr(mood_classifier.MoodClassifier, "classify", fake)
    monkeypatch.setattr(APP_CONFIG.gemini, "mood_classifier", "fake-model")
    monkeypatch.setattr(APP_CONFIG.gemini, "api_key", SecretStr("x"))
    monkeypatch.setattr(APP_CONFIG.gemini, "mood_debounce_ms", 0)
    connector = FakeConnector(heard="мне страшно")
    with make_live_client(connector, FakeTts()) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            speak_turn(ws)
            frames = read_frames(ws, lambda f: reply_done(f) and any(x[0] == "json" and x[1]["type"] == "mood" for x in f))
    assert moods(frames)[0]["tone"] == "afraid"
    assert has(frames, "assistant_end")
