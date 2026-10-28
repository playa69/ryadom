"""Голосовой путь разговора по старту (`openspec/changes/add-sber-voice-pipeline`, «Голосовой путь разговора», «Служебные
эндпоинты»): поле `pipeline` старта, путь по умолчанию, соединитель сокета и окно токенов Gemini только для Gemini Live."""

import uuid
from typing import Any

from fastapi.testclient import TestClient

from app.clients.gemini_live import LiveError
from app.core.config import GeminiSettings
from app.services.gemini_budget import TokenBudget
from tests.conftest import AUTH, FakeTts, has, make_app, read_frames, send_user_message, ws_url
from tests.fake_live import FakeConnector


class FakeSber(FakeConnector):
    """Путь Сбера без сети: ходы как у поддельного Gemini; синтеза фраз нет, их озвучивает запасная озвучка Gemini."""

    name = "fake-sber"
    model = "fake-gigachat"

    async def speaker(self) -> Any:
        raise LiveError("синтеза фраз в тесте нет")


def sber_client(gemini: FakeConnector, sber: FakeConnector | None) -> TestClient:
    return TestClient(make_app(gemini, FakeTts(), sber_factory=lambda: sber))


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
