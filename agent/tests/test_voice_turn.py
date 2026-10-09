"""Голос без рук: длинная реплика, лимиты из конфига, перебивание голосом и его метрики."""

import asyncio
import json

import pytest
from prometheus_client import REGISTRY
from pydantic import ValidationError

from app.api.dialog_ws import MAX_AUDIO_BYTES, MAX_USER_TEXT
from app.clients.llm import STT_RATE, build_models
from app.core.config import APP_CONFIG, DialogSettings, LlmSettings
from tests.conftest import (
    AUTH,
    FakeChat,
    FakeRecognizer,
    FakeTts,
    audio_in_frame,
    has,
    make_client,
    read_frames,
    send_user_message,
    start_dialog,
    ws_url,
)

FRAME_BYTES = STT_RATE * 2 // 10  # 100 мс PCM16 на 16 кГц


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


# ─── Конфиг ───────────────────────────────────────────────────────────────────


def test_voice_limits_default_to_five_minutes_and_a_separate_stt_timeout():
    assert DialogSettings().voice_turn_max_seconds == 300
    assert LlmSettings().stt_timeout_seconds == 120
    assert MAX_AUDIO_BYTES == STT_RATE * 2 * APP_CONFIG.dialog.voice_turn_max_seconds


def test_voice_limits_come_from_env():
    assert DialogSettings(VOICE_TURN_MAX_SECONDS="60").voice_turn_max_seconds == 60
    assert LlmSettings(STT_TIMEOUT_SECONDS="45").stt_timeout_seconds == 45


@pytest.mark.parametrize("value", ["0", "601", "пять"])
def test_bad_voice_turn_limit_fails_fast(value):
    with pytest.raises(ValidationError):
        DialogSettings(VOICE_TURN_MAX_SECONDS=value)


def test_whisper_client_waits_as_long_as_the_stt_timeout():
    _, recognizer = build_models(
        LlmSettings(
            LLM_MODE="proxy", LLM_BASE_URL="https://proxy.test/v1", AGENT_API_TOKEN="k", STT_TIMEOUT_SECONDS="90"
        )
    )
    assert recognizer._client.timeout.read == 90


# ─── Длинная реплика ──────────────────────────────────────────────────────────


def test_five_minute_turn_reaches_recognition_whole(user_id):
    stt = FakeRecognizer("очень длинный рассказ")
    with make_client(chat=FakeChat(), recognizer=stt) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            speak(ws, frames=3000)  # ровно 300 с
            frames = read_frames(ws, reply_done)

    assert has(frames, "transcript", text="очень длинный рассказ")
    assert len(stt.calls[0]) == 3000 * FRAME_BYTES


def test_audio_beyond_the_limit_is_dropped_and_counted(user_id):
    stt = FakeRecognizer("всё сказанное")
    truncated = metric("agent_voice_turns_truncated_total")
    with make_client(chat=FakeChat(), recognizer=stt) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            speak(ws, frames=3010)
            read_frames(ws, reply_done)

    assert len(stt.calls[0]) == MAX_AUDIO_BYTES
    assert metric("agent_voice_turns_truncated_total") == truncated + 1


def test_long_transcript_is_kept_whole(user_id):
    words = "мне есть что рассказать " * 250  # около 6000 символов: пять минут речи
    with make_client(chat=FakeChat(), recognizer=FakeRecognizer(words.strip())) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            speak(ws, frames=10)
            read_frames(ws, reply_done)
        stored = client.get(f"/v1/users/{user_id}/dialogs/{dialog['dialogId']}", headers=AUTH).json()["messages"]

    assert len(words.strip()) < MAX_USER_TEXT
    assert stored[0]["text"] == words.strip()


def test_recognition_waits_for_the_stt_timeout_not_the_chat_one(user_id):
    """В тестах LLM_TIMEOUT_SECONDS=1: распознавание дольше секунды всё равно дожидается."""

    class SlowRecognizer(FakeRecognizer):
        async def transcribe(self, pcm: bytes) -> str:
            await asyncio.sleep(1.3)
            return await super().transcribe(pcm)

    with make_client(chat=FakeChat(), recognizer=SlowRecognizer("я дождался")) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            speak(ws, frames=10)
            frames = read_frames(ws, reply_done)

    assert has(frames, "transcript", text="я дождался")
    assert not has(frames, "error")


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


def test_voice_barge_in_is_recognized_whole_and_answered(user_id):
    stt = FakeRecognizer("подожди, я не договорил")
    interruptions = metric("agent_voice_interruptions_total")
    false_ones = metric("agent_voice_false_interruptions_total")
    with make_client(FakeTts(delay=0.2), chat=FakeChat(), recognizer=stt) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            frames = barge_in(ws)

    assert has(frames, "transcript", text="подожди, я не договорил")
    # распознаванию досталась вся реплика, с первого кадра
    assert len(stt.calls[0]) == 10 * FRAME_BYTES
    assert metric("agent_voice_interruptions_total") == interruptions + 1
    assert metric("agent_voice_false_interruptions_total") == false_ones


def test_barge_in_with_nothing_said_is_a_false_interruption(user_id):
    false_ones = metric("agent_voice_false_interruptions_total")
    with make_client(FakeTts(delay=0.2), chat=FakeChat(), recognizer=FakeRecognizer("")) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            frames = barge_in(ws, recognized=False)

    assert has(frames, "transcript", text="")
    assert metric("agent_voice_false_interruptions_total") == false_ones + 1


def test_empty_turn_without_interruption_is_not_a_false_one(user_id):
    false_ones = metric("agent_voice_false_interruptions_total")
    with make_client(chat=FakeChat(), recognizer=FakeRecognizer("")) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            speak(ws, frames=10)
            read_frames(ws, lambda f: has(f, "transcript"))

    assert metric("agent_voice_false_interruptions_total") == false_ones


def test_cancel_during_a_turn_marks_that_turn_and_not_the_next(user_id):
    """Человек заговорил, пока агент думал, и клиент отменил его ответ уже посреди реплики."""
    false_ones = metric("agent_voice_false_interruptions_total")
    with make_client(chat=FakeChat(), recognizer=FakeRecognizer("")) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            ws.send_text(json.dumps({"type": "audio_start"}))
            ws.send_text(json.dumps({"type": "tts_cancel", "messageId": "m-1"}))
            for n in range(5):
                ws.send_bytes(audio_in_frame(n, loud=True))
            ws.send_text(json.dumps({"type": "audio_end"}))
            read_frames(ws, lambda f: has(f, "transcript"))
            assert metric("agent_voice_false_interruptions_total") == false_ones + 1
            speak(ws, frames=5)  # следующая реплика — уже без перебивания
            read_frames(ws, lambda f: has(f, "transcript"))

    assert metric("agent_voice_false_interruptions_total") == false_ones + 1


def test_turn_end_delay_is_the_silence_before_audio_end(user_id):
    count = metric("agent_voice_turn_end_delay_seconds_count")
    with make_client(chat=FakeChat(), recognizer=FakeRecognizer("привет")) as client:
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
