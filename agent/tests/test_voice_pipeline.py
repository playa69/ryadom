"""Голосовой путь разговора по старту (`openspec/changes/add-sber-voice-pipeline`, «Голосовой путь разговора», «Служебные
эндпоинты»): поле `pipeline` старта, путь по умолчанию, соединитель сокета, окно токенов Gemini только для Gemini Live и
классификатор тона пути Сбера без Gemini."""

import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.clients import mood_classifier
from app.clients.gemini_live import LiveError
from app.core.config import APP_CONFIG, GeminiSettings
from app.services.gemini_budget import TokenBudget
from tests.conftest import AUTH, FakeTts, has, make_app, read_frames, send_user_message, ws_url
from tests.fake_live import FakeConnector, reply_done, speak_turn


class FakeSber(FakeConnector):
    """Путь Сбера без сети: ходы как у поддельного Gemini; синтеза фраз нет, их озвучивает запасная озвучка Gemini."""

    name = "fake-sber"
    model = "fake-gigachat"

    async def open(self, voice: str, instructions: str, history: Any = None) -> Any:
        link = await super().open(voice, instructions, history)
        link.counts_tokens = False  # как у настоящей ссылки пути Сбера: токены GigaChat окно Gemini не считает
        return link

    async def speaker(self) -> Any:
        raise LiveError("синтеза фраз в тесте нет")


class FakeTone:
    """Классификатор тона пути Сбера без сети: запоминает реплики и отвечает грустью."""

    def __init__(self) -> None:
        self.heard: list[str] = []

    async def warm(self) -> None:
        return None

    async def classify(self, text: str) -> dict:
        self.heard.append(text)
        return {"tone": "sad", "intensity": 0.5}


class FakeSberWithTone(FakeSber):
    def __init__(self, tone: FakeTone, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.tone = tone

    def mood_classifier(self) -> FakeTone:
        return self.tone


def sber_client(gemini: FakeConnector, sber: FakeConnector | None) -> TestClient:
    return TestClient(make_app(gemini, FakeTts(), sber_factory=lambda: sber))


@pytest.fixture
def gemini_tone(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Есть ключ Gemini, его классификатор тона поддельный; в списке — всё, что он получил, включая прогрев."""
    heard: list[str] = []

    async def classify(self: object, text: str) -> dict:
        heard.append(text)
        return {"tone": "afraid", "intensity": 0.7}

    monkeypatch.setattr(mood_classifier.MoodClassifier, "__init__", lambda self, settings: None)
    monkeypatch.setattr(mood_classifier.MoodClassifier, "classify", classify)
    monkeypatch.setattr(APP_CONFIG.gemini, "api_key", SecretStr("x"))
    monkeypatch.setattr("app.api.dialog_session.MOOD_DEBOUNCE_SECONDS", 0)
    return heard


def moods(frames: list[Any]) -> list[str]:
    return [f[1]["tone"] for f in frames if f[0] == "json" and f[1]["type"] == "mood"]


def voice_turn(client: TestClient, user_id: str, dialog_id: str, until: Any) -> list[Any]:
    with client.websocket_connect(ws_url(user_id, dialog_id), headers=AUTH) as ws:
        speak_turn(ws)
        return read_frames(ws, until)


def start(client: TestClient, user_id: str, **body: Any) -> Any:
    return client.post(f"/v1/users/{user_id}/dialogs", json=body or None, headers=AUTH)


def one_turn(client: TestClient, user_id: str, dialog_id: str) -> None:
    with client.websocket_connect(ws_url(user_id, dialog_id), headers=AUTH) as ws:
        send_user_message(ws, str(uuid.uuid4()), "Мне сегодня тяжело")  # свой id: повтор того же id агент не отвечает
        read_frames(ws, lambda frames: has(frames, "assistant_end"))


def test_the_dialog_takes_the_pipeline_of_its_latest_start() -> None:
    gemini, sber = FakeConnector(reply="Ответ Gemini."), FakeSber(reply="Ответ Сбера.")
    with sber_client(gemini, sber) as client:
        user_id = str(uuid.uuid4())
        dialog = start(client, user_id, pipeline="sber").json()["dialogId"]
        one_turn(client, user_id, dialog)
        assert sber.open_calls and not gemini.open_calls

        # Администратор сменил путь: возобновлённый разговор со следующего старта идёт новым путём.
        assert start(client, user_id, pipeline="gemini").json()["dialogId"] == dialog
        one_turn(client, user_id, dialog)
        assert gemini.open_calls


def test_a_start_without_a_pipeline_takes_sber_when_the_agent_has_it() -> None:
    gemini, sber = FakeConnector(), FakeSber()
    with sber_client(gemini, sber) as client:
        user_id = str(uuid.uuid4())
        dialog = start(client, user_id).json()["dialogId"]
        one_turn(client, user_id, dialog)
        assert sber.open_calls and not gemini.open_calls
        assert client.get("/health/ready").json()["voicePipeline"] == "sber"


def test_without_the_proxy_everything_goes_to_gemini_live() -> None:
    gemini = FakeConnector()
    with sber_client(gemini, None) as client:
        user_id = str(uuid.uuid4())
        assert client.get("/health/ready").json()["voicePipeline"] == "gemini"
        dialog = start(client, user_id, pipeline="sber").json()["dialogId"]  # пути нет — Gemini Live
        one_turn(client, user_id, dialog)
        assert gemini.open_calls


def test_an_unknown_pipeline_is_refused_and_changes_nothing() -> None:
    with sber_client(FakeConnector(), FakeSber()) as client:
        user_id = str(uuid.uuid4())
        assert start(client, user_id, pipeline="robot").status_code == 400
        assert client.get(f"/v1/users/{user_id}/dialogs", headers=AUTH).json()["items"] == []


def test_when_sber_does_not_open_the_dialog_goes_on_gemini_live() -> None:
    gemini, sber = FakeConnector(reply="Ответ Gemini."), FakeSber(fail=True)
    with sber_client(gemini, sber) as client:
        user_id = str(uuid.uuid4())
        dialog = start(client, user_id, pipeline="sber").json()["dialogId"]
        with client.websocket_connect(ws_url(user_id, dialog), headers=AUTH) as ws:
            send_user_message(ws, "c1", "Мне сегодня тяжело")
            frames = read_frames(ws, lambda fs: has(fs, "assistant_end"))
        assert has(frames, "assistant_end", text="Ответ Gemini.")
        assert not has(frames, "error")


def test_the_gemini_token_window_counts_only_gemini_live_dialogs() -> None:
    gemini, sber = FakeConnector(usage={"input": 500}), FakeSber(usage={"input": 500})
    with sber_client(gemini, sber) as client:
        budget = TokenBudget(GeminiSettings.model_validate({"GEMINI_TPM_LIMIT": 1_000_000}))
        client.app.state.budget = budget
        user_id = str(uuid.uuid4())
        dialog = start(client, user_id, pipeline="sber").json()["dialogId"]
        one_turn(client, user_id, dialog)
        assert budget.window_tokens() == 0

        start(client, user_id, pipeline="gemini")
        one_turn(client, user_id, dialog)
        assert budget.window_tokens() > 0


def test_on_the_sber_path_the_tone_comes_from_gigachat_and_nothing_goes_to_gemini(gemini_tone: list[str]) -> None:
    tone = FakeTone()
    gemini, sber = FakeConnector(heard="мне грустно"), FakeSberWithTone(tone, heard="мне грустно")
    with_mood = lambda frames: reply_done(frames) and bool(moods(frames))  # noqa: E731
    with sber_client(gemini, sber) as client:
        user_id = str(uuid.uuid4())
        dialog = start(client, user_id, pipeline="sber").json()["dialogId"]
        assert moods(voice_turn(client, user_id, dialog, with_mood)) == ["sad"]
        assert tone.heard and "мне грустно" in tone.heard[-1]
        assert gemini_tone == []  # ни прогрева, ни реплики: слова человека в Gemini не ушли

        # Путь Gemini Live по-прежнему красит шарик классификатором Gemini.
        start(client, user_id, pipeline="gemini")
        assert moods(voice_turn(client, user_id, dialog, with_mood)) == ["afraid"]
        assert "мне грустно" in gemini_tone[-1]


def test_a_sber_path_without_its_own_classifier_does_not_fall_back_to_gemini(gemini_tone: list[str]) -> None:
    gemini, sber = FakeConnector(), FakeSber(heard="мне страшно")
    with sber_client(gemini, sber) as client:
        user_id = str(uuid.uuid4())
        dialog = start(client, user_id, pipeline="sber").json()["dialogId"]
        frames = voice_turn(client, user_id, dialog, reply_done)
        assert moods(frames) == [] and gemini_tone == []


def gemini_dialog(client: TestClient) -> tuple[str, str]:
    user_id = str(uuid.uuid4())
    return user_id, start(client, user_id, pipeline="gemini").json()["dialogId"]


def test_when_gemini_live_does_not_open_the_dialog_goes_on_sber() -> None:
    gemini, sber = FakeConnector(fail=True), FakeSber(reply="Ответ Сбера.")
    with sber_client(gemini, sber) as client:
        user_id, dialog = gemini_dialog(client)
        with client.websocket_connect(ws_url(user_id, dialog), headers=AUTH) as ws:
            send_user_message(ws, "c1", "Мне сегодня тяжело")
            frames = read_frames(ws, lambda fs: has(fs, "assistant_end"))
        assert has(frames, "assistant_end", text="Ответ Сбера.")
        assert not has(frames, "error")
        assert gemini.open_calls and sber.open_calls  # Gemini Live пробовался первым


def test_a_gemini_quota_refusal_starts_the_pause_and_the_next_opens_go_straight_to_sber(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(APP_CONFIG.gemini, "tpm_limit", 1_000_000)  # учёт включён: есть пауза после отказа по квоте
    gemini, sber = FakeConnector(), FakeSber(reply="Ответ Сбера.")
    gemini.quota_from = 1
    with sber_client(gemini, sber) as client:
        budget = client.app.state.budget
        user_id, dialog = gemini_dialog(client)
        one_turn(client, user_id, dialog)
        assert budget.cooling()  # отказ по квоте при открытии начал паузу, хотя разговор не прервался
        assert len(gemini.open_calls) == 1 and sber.open_calls

        # В паузе Gemini Live не пробуется: открытие идёт сразу на Сбер, ход не ждёт конца паузы.
        user_id, dialog = gemini_dialog(client)
        one_turn(client, user_id, dialog)
        assert len(gemini.open_calls) == 1


def test_in_the_pause_a_turn_is_answered_by_sber_instead_of_waiting_for_gemini(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(APP_CONFIG.gemini, "tpm_limit", 1_000_000)
    gemini, sber = FakeConnector(reply="Ответ Gemini."), FakeSber(reply="Ответ Сбера.")
    with sber_client(gemini, sber) as client:
        client.app.state.budget.on_quota_error("open")
        assert client.app.state.budget.cooling()
        user_id, dialog = gemini_dialog(client)
        with client.websocket_connect(ws_url(user_id, dialog), headers=AUTH) as ws:
            send_user_message(ws, "c1", "Мне сегодня тяжело")
            frames = read_frames(ws, lambda fs: has(fs, "assistant_end"))
        assert has(frames, "assistant_end", text="Ответ Сбера.") and not has(frames, "error")
        assert not gemini.open_calls


def test_sber_tokens_do_not_enter_the_gemini_window_when_sber_is_the_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(APP_CONFIG.gemini, "tpm_limit", 1_000_000)
    gemini, sber = FakeConnector(fail=True), FakeSber(usage={"input": 500})
    with sber_client(gemini, sber) as client:
        user_id, dialog = gemini_dialog(client)
        one_turn(client, user_id, dialog)
        assert sber.open_calls
        assert client.app.state.budget.window_tokens() == 0
