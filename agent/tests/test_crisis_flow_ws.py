"""Кризисная ветка по сокету: шаги скрипта, кнопки, таймер, жёлтый уровень (REQ-SAFE-02, REQ-SAFE-03)."""

import json

import pytest

from app.core.metrics import CRISIS_CALL_PRESSED_TOTAL, CRISIS_TRIGGERS_TOTAL
from app.services import crisis_script as script
from tests.conftest import AUTH, read_frames, send_user_message, start_dialog, ws_url
from tests.fake_live import reply_done as voiced_reply_done


def ends(frames):
    return [b["text"] for k, b in frames if k == "json" and b["type"] == "assistant_end"]


def bodies(frames, kind):
    return [b for k, b in frames if k == "json" and b["type"] == kind]


def until_ends(count):
    return lambda frames: len(ends(frames)) >= count


def send(ws, frame):
    ws.send_text(json.dumps(frame))


@pytest.fixture
def ws(client, user_id):
    dialog = start_dialog(client, user_id)
    with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as socket:
        yield socket


def test_red_step_one_then_check_by_timer(ws, monkeypatch):
    monkeypatch.setattr(script, "SAFETY_CHECK_DELAY_SECONDS", 0.2)
    before = CRISIS_TRIGGERS_TOTAL.labels("red", "words")._value.get()
    send_user_message(ws, "c-1", "я больше не хочу жить")
    frames = read_frames(ws, until_ends(2))
    safety = bodies(frames, "safety")[0]
    assert safety["level"] == "crisis" and safety["step"] == "call" and safety["pinned"] is True
    assert safety["text"] == script.SHEET_TITLE
    assert ends(frames) == [script.RED_FIRST, script.RED_CHECK]
    state = bodies(frames, "safety_state")[0]
    assert state["step"] == "check" and state["ask"] == "safe"
    assert CRISIS_TRIGGERS_TOTAL.labels("red", "words")._value.get() == before + 1


def test_call_button_cancels_the_check_and_is_counted(ws, monkeypatch):
    monkeypatch.setattr(script, "SAFETY_CHECK_DELAY_SECONDS", 0.3)
    before = CRISIS_CALL_PRESSED_TOTAL.labels("red")._value.get()
    send_user_message(ws, "c-1", "хочу умереть")
    read_frames(ws, until_ends(1))
    send(ws, {"type": "safety_call"})
    send_user_message(ws, "c-2", "ладно")  # после кнопки шаг 2 не повторяется таймером
    frames = read_frames(ws, voiced_reply_done)
    assert script.RED_CHECK not in ends(frames)
    assert CRISIS_CALL_PRESSED_TOTAL.labels("red")._value.get() == before + 1


def test_unsafe_answer_by_button_gives_112_and_reopens_the_sheet(ws, monkeypatch):
    monkeypatch.setattr(script, "SAFETY_CHECK_DELAY_SECONDS", 0.1)
    send_user_message(ws, "c-1", "хочу умереть")
    read_frames(ws, until_ends(2))
    send(ws, {"type": "safety_answer", "answer": "unknown"})
    frames = read_frames(ws, until_ends(1))
    assert ends(frames) == [script.RED_UNSAFE]
    assert bodies(frames, "safety")[0]["step"] == "emergency"


def test_safe_answer_by_voice_text_pins_the_button(ws, monkeypatch):
    monkeypatch.setattr(script, "SAFETY_CHECK_DELAY_SECONDS", 0.1)
    send_user_message(ws, "c-1", "хочу умереть")
    read_frames(ws, until_ends(2))
    send_user_message(ws, "c-2", "да")
    frames = read_frames(ws, until_ends(1))
    assert ends(frames) == [script.RED_SAFE]
    assert bodies(frames, "safety_state")[0]["pinned"] is True


def test_return_after_the_call(ws):
    send_user_message(ws, "c-1", "хочу умереть")
    read_frames(ws, until_ends(1))
    send(ws, {"type": "safety_call"})
    send(ws, {"type": "safety_return"})
    frames = read_frames(ws, until_ends(1))
    assert ends(frames) == [script.RED_RETURN]


def test_yellow_asks_and_no_goes_to_a_calm_model_talk_with_the_banner(ws):
    send_user_message(ws, "c-1", "всё бессмысленно")
    frames = read_frames(ws, until_ends(1))
    assert ends(frames) == [script.YELLOW_ASK]
    assert not bodies(frames, "safety")  # лист не открывается
    assert bodies(frames, "safety_state")[0]["ask"] == "thoughts"
    send_user_message(ws, "c-2", "нет")
    frames = read_frames(ws, voiced_reply_done)
    assert bodies(frames, "safety_state")[0]["banner"] is True
    assert script.YELLOW_ASK not in ends(frames) and ends(frames)  # ответила модель


def test_yellow_yes_goes_to_red_step_one(ws):
    send_user_message(ws, "c-1", "никому не нужен")
    read_frames(ws, until_ends(1))
    send_user_message(ws, "c-2", "да")
    frames = read_frames(ws, until_ends(1))
    assert ends(frames) == [script.RED_FIRST] and bodies(frames, "safety")[0]["step"] == "call"


def test_ordinary_talk_has_no_safety_frames(ws):
    send_user_message(ws, "c-1", "расскажи, что такое осень")
    frames = read_frames(ws, voiced_reply_done)
    assert not bodies(frames, "safety") and not bodies(frames, "safety_state")
