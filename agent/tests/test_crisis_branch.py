"""Кризисная ветка в сокете диалога: вторая ступень детектора, шаги скрипта по кадрам, таймер, возврат после звонка.

`openspec/changes/extend-crisis-branch`: «Распознавание кризиса в реплике», «Скрипт красного уровня», «Жёлтый уровень».
Реплики синтетические, модель оценки риска подделана."""

import asyncio
from typing import Any

import pytest

from app.api import dialog_session
from app.services import crisis_script as script
from tests.conftest import AUTH, has, make_client, read_frames, send_user_message, start_dialog, types, ws_url
from tests.fake_live import FakeConnector


class FakeRisk:
    """Вторая ступень: заранее заданный ответ или ошибка; в `seen` — контексты, которые она получила."""

    def __init__(self, verdict: str | Exception = "none", delay: float = 0) -> None:
        self.verdict, self.delay, self.seen = verdict, delay, []

    async def classify(self, context: list[str], **kwargs: Any) -> str:
        self.seen.append(list(context))
        await asyncio.sleep(self.delay)
        if isinstance(self.verdict, Exception):
            raise self.verdict
        return self.verdict


def reply_done(frames: list) -> bool:
    return has(frames, "assistant_end")


def safety_of(frames: list) -> list[dict]:
    return [b for k, b in frames if k == "json" and b["type"] == "safety"]


def ended_texts(frames: list) -> list[str]:
    return [b["text"] for k, b in frames if k == "json" and b["type"] == "assistant_end"]


def turn(ws: Any, n: int, text: str) -> list:
    send_user_message(ws, f"c-{n}", text)
    return read_frames(ws, reply_done)


def with_risk(client: Any, risk: FakeRisk) -> None:
    client.app.state.risks["gemini"] = risk


def open_ws(client: Any, user_id: str) -> Any:
    dialog = start_dialog(client, user_id)
    return client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH)


def test_the_model_stage_finds_what_the_dictionary_missed(user_id: str) -> None:
    risk = FakeRisk("red")
    with make_client(None) as client:
        with_risk(client, risk)
        with open_ws(client, user_id) as ws:
            frames = turn(ws, 1, "мне кажется, что всем будет лучше без меня")
    assert ended_texts(frames) == [script.STEP1]
    frame = safety_of(frames)[0]
    assert (frame["level"], frame["stage"], frame["source"]) == ("crisis", "help", "model")
    assert risk.seen == [["мне кажется, что всем будет лучше без меня"]]


def test_the_model_stage_is_not_asked_when_the_dictionary_found_it(user_id: str) -> None:
    risk = FakeRisk("none")
    with make_client(None) as client:
        with_risk(client, risk)
        with open_ws(client, user_id) as ws:
            frames = turn(ws, 1, "хочу умереть")
    assert safety_of(frames)[0]["source"] == "dictionary" and risk.seen == []


@pytest.mark.parametrize("risk", [FakeRisk(RuntimeError("down")), FakeRisk("red", delay=1.5)], ids=["error", "timeout"])
def test_a_failed_model_stage_means_no_and_the_chat_goes_on(user_id: str, risk: FakeRisk) -> None:
    with make_client(None, connector=FakeConnector(replies=["Обычный ответ."])) as client:
        with_risk(client, risk)
        with open_ws(client, user_id) as ws:
            frames = turn(ws, 1, "расскажу про день")
    assert not has(frames, "safety") and ended_texts(frames) == ["Обычный ответ."]


def test_red_steps_by_frames(user_id: str) -> None:
    with make_client(None, connector=FakeConnector(replies=["Расскажи ещё."])) as client:
        with open_ws(client, user_id) as ws:
            first = turn(ws, 1, "я больше не хочу жить")
            asked = turn(ws, 2, "ну")
            unsafe = turn(ws, 3, "Нет")
    assert [f["stage"] for f in safety_of(first + asked + unsafe)] == ["help", "ask_safe", "call112"]
    assert ended_texts(asked) == [script.STEP2_ASK] and ended_texts(unsafe) == [script.STEP2_UNSAFE]
    assert safety_of(unsafe)[0]["showCall"] is True


def test_safe_answer_pins_the_call_and_the_model_listens(user_id: str) -> None:
    with make_client(None, connector=FakeConnector(replies=["Я слушаю тебя."])) as client:
        with open_ws(client, user_id) as ws:
            turn(ws, 1, "я больше не хочу жить")
            safe = turn(ws, 2, "Да, я в безопасности")
            listening = turn(ws, 3, "просто тяжело")
    assert ended_texts(safe) == [script.STEP2_SAFE] and safety_of(safe)[0]["stage"] == "stay" and safety_of(safe)[0]["showCall"]
    assert ended_texts(listening) == ["Я слушаю тебя."] and not has(listening, "safety")


def test_nobody_presses_the_button_the_agent_asks_about_safety(user_id: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(dialog_session, "HELP_WAIT_SECONDS", 0.05)
    with make_client(None) as client:
        with open_ws(client, user_id) as ws:
            turn(ws, 1, "я больше не хочу жить")
            frames = read_frames(ws, reply_done)
    assert safety_of(frames)[0]["stage"] == "ask_safe" and ended_texts(frames) == [script.STEP2_ASK]


def test_help_wait_is_cancelled_when_the_person_answers(user_id: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(dialog_session, "HELP_WAIT_SECONDS", 0.2)
    with make_client(None) as client:
        with open_ws(client, user_id) as ws:
            turn(ws, 1, "я больше не хочу жить")
            frames = turn(ws, 2, "Да, я в безопасности")
    assert types(frames).count("safety") == 1


def test_return_after_the_call_asks_how_it_went(user_id: str) -> None:
    with make_client(None) as client:
        with open_ws(client, user_id) as ws:
            turn(ws, 1, "я больше не хочу жить")
            ws.send_text('{"type": "help_returned"}')
            frames = read_frames(ws, reply_done)
    assert ended_texts(frames) == [script.STEP4_RETURN] and safety_of(frames)[0]["stage"] == "check"


def test_return_without_a_crisis_is_ignored(user_id: str) -> None:
    with make_client(None, connector=FakeConnector(replies=["Привет."])) as client:
        with open_ws(client, user_id) as ws:
            ws.send_text('{"type": "help_returned"}')
            frames = turn(ws, 1, "привет")
    assert not has(frames, "safety") and ended_texts(frames) == ["Привет."]


def test_yellow_then_no_gives_the_banner_and_a_model_answer(user_id: str) -> None:
    with make_client(None, connector=FakeConnector(replies=["Я рядом."])) as client:
        with open_ws(client, user_id) as ws:
            asked = turn(ws, 1, "всё бессмысленно")
            answer = turn(ws, 2, "нет")
    assert ended_texts(asked) == [script.YELLOW_ASK] and (safety_of(asked)[0]["level"], safety_of(asked)[0]["stage"]) == ("concern", "ask_hopeless")
    assert safety_of(answer)[0]["stage"] == "calm" and ended_texts(answer) == ["Я рядом."]


def test_yellow_then_yes_is_red_step_one(user_id: str) -> None:
    with make_client(None) as client:
        with open_ws(client, user_id) as ws:
            turn(ws, 1, "всё бессмысленно")
            frames = turn(ws, 2, "да")
    assert safety_of(frames)[0]["stage"] == "help" and ended_texts(frames) == [script.STEP1]
