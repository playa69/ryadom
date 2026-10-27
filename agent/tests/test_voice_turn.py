"""Голос без рук: длинная реплика, лимит из конфига, перебивание голосом и его метрики (поддельный Gemini Live)."""

import json

import pytest
from prometheus_client import REGISTRY
from pydantic import ValidationError

from app.api.dialog_session import MAX_AUDIO_BYTES, MAX_USER_TEXT
from app.core.config import APP_CONFIG, DialogSettings
from tests.conftest import (
    AUTH,
    FakeTts,
    audio_in_frame,
    has,
    make_client,
    read_frames,
    send_user_message,
    start_dialog,
    ws_url,
)
from tests.fake_live import FakeConnector

FRAME_BYTES = 16_000 * 2 // 10  # 100 мс PCM16 на 16 кГц


def metric(name: str) -> float:
    return REGISTRY.get_sample_value(name) or 0.0


def reply_done(frames):
    return has(frames, "assistant_end")


def speak(ws, frames: int, loud: bool = True, silent_tail: int = 0) -> None:
    ws.send_text(json.dumps({"type": "audio_start"}))
    for n in range(frames):
        ws.send_bytes(audio_in_frame(n, loud=loud))
    for n in range(silent_tail):
        ws.send_bytes(audio_in_frame(frames + n))
    ws.send_text(json.dumps({"type": "audio_end"}))


def audio_sent_to_the_model(connector: FakeConnector) -> int:
    """Сколько байт звука реплики получила модель (по всем её соединениям)."""
    return sum(command[1] for link in connector.links for command in link.commands if command[0] == "audio")


# ─── Конфиг ───────────────────────────────────────────────────────────────────


def test_voice_limit_defaults_to_five_minutes():
    assert DialogSettings().voice_turn_max_seconds == 300
    assert MAX_AUDIO_BYTES == 16_000 * 2 * APP_CONFIG.dialog.voice_turn_max_seconds


def test_voice_limit_comes_from_env():
    assert DialogSettings(VOICE_TURN_MAX_SECONDS="60").voice_turn_max_seconds == 60


@pytest.mark.parametrize("value", ["0", "601", "пять"])
def test_bad_voice_turn_limit_fails_fast(value):
    with pytest.raises(ValidationError):
        DialogSettings(VOICE_TURN_MAX_SECONDS=value)


# ─── Длинная реплика ──────────────────────────────────────────────────────────


def test_five_minute_turn_reaches_the_model_whole(user_id):
    connector = FakeConnector(heard="очень длинный рассказ")
    with make_client(connector=connector) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            speak(ws, frames=3000)  # ровно 300 с
            frames = read_frames(ws, reply_done)

    assert has(frames, "transcript", text="очень длинный рассказ")
    assert audio_sent_to_the_model(connector) == 3000 * FRAME_BYTES


def test_audio_beyond_the_limit_is_dropped_and_counted(user_id):
    connector = FakeConnector(heard="всё сказанное")
    truncated = metric("agent_voice_turns_truncated_total")
    with make_client(connector=connector) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            speak(ws, frames=3010)
            read_frames(ws, reply_done)

    assert audio_sent_to_the_model(connector) == MAX_AUDIO_BYTES
    assert metric("agent_voice_turns_truncated_total") == truncated + 1


def test_long_transcript_is_kept_whole(user_id):
    words = ("мне есть что рассказать " * 250).strip()  # около 6000 символов: пять минут речи
    with make_client(connector=FakeConnector(heard=words)) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            speak(ws, frames=10)
            read_frames(ws, reply_done)
        stored = client.get(f"/v1/users/{user_id}/dialogs/{dialog['dialogId']}", headers=AUTH).json()["messages"]

    assert len(words) < MAX_USER_TEXT
    assert stored[0]["text"] == words


# ─── Перебивание голосом ──────────────────────────────────────────────────────


def barge_in(ws, recognized: bool = True) -> list:
    """Агент озвучивает ответ, человек заговорил поверх: tts_cancel и сразу новая реплика."""
    read_frames(ws, lambda f: has(f, "tts_end"))  # приветствие
    send_user_message(ws, "c-1", "раз")
    frames = read_frames(ws, lambda f: has(f, "tts_start"))
    message_id = next(b["messageId"] for k, b in frames if k == "json" and b["type"] == "tts_start")
    ws.send_text(json.dumps({"type": "tts_cancel", "messageId": message_id}))
    speak(ws, frames=10, loud=recognized)
    heard = read_frames(ws, lambda f: has(f, "transcript"))
    return heard + read_frames(ws, reply_done) if recognized else heard


def test_voice_barge_in_reaches_the_model_whole_and_is_answered(user_id):
    connector = FakeConnector(heard="подожди, я не договорил")
    interruptions = metric("agent_voice_interruptions_total")
    false_ones = metric("agent_voice_false_interruptions_total")
    with make_client(FakeTts(), connector=connector) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            frames = barge_in(ws)

    assert has(frames, "transcript", text="подожди, я не договорил")
    # модели досталась вся реплика, с первого кадра
    assert audio_sent_to_the_model(connector) == 10 * FRAME_BYTES
    assert metric("agent_voice_interruptions_total") == interruptions + 1
    assert metric("agent_voice_false_interruptions_total") == false_ones


def test_barge_in_with_nothing_said_is_a_false_interruption(user_id):
    false_ones = metric("agent_voice_false_interruptions_total")
    with make_client(FakeTts()) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            frames = barge_in(ws, recognized=False)

    assert has(frames, "transcript", text="")
    assert metric("agent_voice_false_interruptions_total") == false_ones + 1


def test_empty_turn_without_interruption_is_not_a_false_one(user_id):
    false_ones = metric("agent_voice_false_interruptions_total")
    with make_client() as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            speak(ws, frames=10, loud=False)
            read_frames(ws, lambda f: has(f, "transcript"))

    assert metric("agent_voice_false_interruptions_total") == false_ones


def test_cancel_during_a_turn_marks_that_turn_and_not_the_next(user_id):
    """Человек заговорил, пока агент думал, и клиент отменил его ответ уже посреди реплики."""
    false_ones = metric("agent_voice_false_interruptions_total")
    with make_client() as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            ws.send_text(json.dumps({"type": "audio_start"}))
            ws.send_text(json.dumps({"type": "tts_cancel", "messageId": "m-1"}))
            for n in range(5):
                ws.send_bytes(audio_in_frame(n))  # тишина
            ws.send_text(json.dumps({"type": "audio_end"}))
            read_frames(ws, lambda f: has(f, "transcript"))
            assert metric("agent_voice_false_interruptions_total") == false_ones + 1
            speak(ws, frames=5, loud=False)  # следующая реплика — уже без перебивания
            read_frames(ws, lambda f: has(f, "transcript"))

    assert metric("agent_voice_false_interruptions_total") == false_ones + 1


def test_turn_end_delay_is_the_silence_before_audio_end(user_id):
    count = metric("agent_voice_turn_end_delay_seconds_count")
    with make_client(connector=FakeConnector(heard="привет")) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            speak(ws, frames=10, silent_tail=9)
            read_frames(ws, reply_done)

    assert metric("agent_voice_turn_end_delay_seconds_count") == count + 1


def test_metrics_endpoint_needs_no_token_and_lists_voice_metrics(client):
    response = client.get("/metrics")
    assert response.status_code == 200
    for name in (
        "agent_voice_interruptions_total",
        "agent_voice_false_interruptions_total",
        "agent_voice_turn_end_delay_seconds",
    ):
        assert name in response.text
