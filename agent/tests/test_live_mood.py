"""PROTEUS-168: цвет шарика по тону человека. Классификатор по расшифровке присылает клиенту кадр
`mood`; ответ модели и кризисный путь он не трогает. Поддельная модель и поддельный классификатор, без сети."""

from typing import Any

import pytest
from pydantic import SecretStr

from app.clients import mood_classifier
from app.clients.mood_classifier import parse_mood
from app.core.config import APP_CONFIG
from app.services.replies import CRISIS_REPLY
from tests.conftest import AUTH, FakeTts, has, read_frames, start_dialog, ws_url
from tests.fake_live import FakeConnector, reply_done, speak_turn
from tests.test_live import make_live_client


def moods(frames: list[Any]) -> list[dict[str, Any]]:
    return [f[1] for f in frames if f[0] == "json" and f[1]["type"] == "mood"]


@pytest.fixture
def classifier(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Есть ключ Gemini, классификатор отвечает заранее заданным тоном; в списке — тексты, которые он получил."""
    seen: list[str] = []
    answer = {"tone": "afraid", "intensity": 0.7}

    async def fake(self: object, text: str) -> dict:
        seen.append(text)
        return dict(answer)

    monkeypatch.setattr(mood_classifier.MoodClassifier, "__init__", lambda self, settings: None)
    monkeypatch.setattr(mood_classifier.MoodClassifier, "classify", fake)
    monkeypatch.setattr(APP_CONFIG.gemini, "api_key", SecretStr("x"))
    monkeypatch.setattr("app.api.dialog_session.MOOD_DEBOUNCE_SECONDS", 0)
    return seen


def run_voice_turn(user_id: str, heard: str, wait: Any) -> list[Any]:
    connector = FakeConnector(heard=heard)
    with make_live_client(connector, FakeTts()) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            speak_turn(ws)
            return read_frames(ws, wait)


def test_the_classifier_sends_a_mood_frame_and_the_answer_goes_on(user_id: str, classifier: list[str]) -> None:
    frames = run_voice_turn(
        user_id, "мне страшно", lambda f: reply_done(f) and any(x[0] == "json" and x[1]["type"] == "mood" for x in f)
    )
    frame = moods(frames)[0]
    assert (frame["tone"], frame["intensity"]) == ("afraid", 0.7) and isinstance(frame["at"], int)
    assert "risk" not in frame  # кадр только про цвет
    assert classifier and "мне страшно" in classifier[-1]
    assert has(frames, "assistant_end") and not has(frames, "safety")


def test_the_classifier_does_not_touch_the_crisis_path(user_id: str, classifier: list[str]) -> None:
    """SOS работает как раньше: по словам, и ответ — фиксированный. Классификатор лишь красит шарик."""
    frames = run_voice_turn(user_id, "я больше не хочу жить", reply_done)
    assert has(frames, "safety")
    end = next(f[1] for f in frames if f[0] == "json" and f[1]["type"] == "assistant_end")
    assert end["text"] == CRISIS_REPLY


def test_without_a_gemini_key_there_is_no_mood_frame(user_id: str) -> None:
    frames = run_voice_turn(user_id, "мне сегодня тяжело", reply_done)
    assert moods(frames) == [] and has(frames, "assistant_end")


def test_parse_mood_distrusts_the_model() -> None:
    assert parse_mood({"tone": "furious", "intensity": 1}) is None
    assert parse_mood(None) is None
    assert parse_mood({"tone": "afraid", "intensity": 7, "risk": "bomb"}) == {"tone": "afraid", "intensity": 1.0}
    assert parse_mood({"tone": "sleepy", "intensity": "много"}) == {"tone": "sleepy", "intensity": 0.0}
