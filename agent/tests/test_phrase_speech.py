"""Озвучка фиксированных фраз (приветствие, кризисный ответ, просьба повторить): кадры по 200 мс, поток от провайдера, отказ,
обрыв старой озвучки новой репликой. Ответы модели звучат её собственным звуком, они здесь не участвуют.

Фразы озвучивает `GeminiLiveTts` с памятью фраз (`CachedTts`); в тестах вместо неё поддельная озвучка (`tests/conftest.py`)."""

import asyncio
import json
import struct
import time

from prometheus_client import REGISTRY

from app.clients.speech import FRAME_BYTES, TtsError
from tests.conftest import AUTH, FakeTts, has, make_client, read_frames, send_user_message, start_dialog, types, ws_url
from tests.fake_live import reply_done


def resumed_greeting_dialog(client, user_id):
    """Диалог, чьё приветствие — одно предложение («Продолжим, где остановились.»): первый POST открывает диалог, второй возвращает его."""
    start_dialog(client, user_id)
    dialog = start_dialog(client, user_id)
    assert dialog["resumed"] is True
    return dialog


class StreamingTts(FakeTts):
    """Провайдер, отдающий звук кусками со своими паузами: первый кусок рано, остальное позже."""

    finished_at = 0.0

    async def stream(self, text: str, voice: str = "male"):
        self.calls.append(text)
        yield b"\x01\x00" * (FRAME_BYTES // 2)  # ровно кадр 200 мс
        await asyncio.sleep(0.5)
        yield b"\x02\x00" * (FRAME_BYTES // 2 + 1500)  # кадр и ещё немного: граница не по кадру
        yield b"\x03\x00" * 700
        self.finished_at = time.monotonic()


def test_frames_leave_while_the_provider_is_still_sending_and_stay_200ms_aligned(user_id):
    tts = StreamingTts()
    with make_client(tts) as client:
        dialog = resumed_greeting_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            arrivals, frames = [], []
            while not has(frames, "tts_end"):
                message = ws.receive()
                if message.get("bytes") is not None:
                    arrivals.append(time.monotonic())
                    frames.append(("bin", message["bytes"]))
                else:
                    frames.append(("json", json.loads(message["text"])))

    audio = [f for k, f in frames if k == "bin"]
    sizes = [len(frame) - 5 for frame in audio]
    assert tts.finished_at - arrivals[0] > 0.3  # первый кадр ушёл задолго до конца синтеза
    assert sizes[:-1] == [FRAME_BYTES] * (len(sizes) - 1) and 0 < sizes[-1] <= FRAME_BYTES
    assert sum(sizes) == FRAME_BYTES * 2 + 3000 + 1400  # ни байта не потеряно и не добавлено
    assert [struct.unpack(">BI", frame[:5])[1] for frame in audio] == list(range(len(audio)))
    order = types(frames)
    assert order.count("tts_start") == 1 and order.index("tts_start") < order.index("tts_end")


def test_a_provider_that_dies_mid_sentence_reports_one_error_and_still_closes_the_speech(user_id):
    class DiesInTheMiddle(FakeTts):
        async def stream(self, text, voice="male"):
            yield b"\x01\x00" * FRAME_BYTES  # два кадра
            raise TtsError("связь оборвалась")

    with make_client(DiesInTheMiddle()) as client:
        dialog = start_dialog(client, user_id)  # приветствие из двух предложений
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            frames = read_frames(ws, lambda f: has(f, "tts_end"))

    assert has(frames, "error", code="VOICE_UNAVAILABLE") and types(frames).count("error") == 1
    assert len([f for k, f in frames if k == "bin"]) >= 1  # начало успели услышать


class StuckOnTheFirstSentence(FakeTts):
    """Провайдер, который на первом предложении приветствия отдаёт кадр и надолго замолкает (медленный или зависший синтез)."""

    async def stream(self, text: str, voice: str = "male"):
        self.calls.append(text)
        yield b"\x01\x00" * (FRAME_BYTES // 2)
        if text == "Я рядом.":
            await asyncio.sleep(5)
        yield b"\x02\x00" * (FRAME_BYTES // 2)


def test_a_new_message_cuts_off_the_speech_that_is_still_going(user_id):
    """Недоговорённое агентом больше не нужно: ответ модели не ждёт, пока доиграет зависшая озвучка фразы."""
    with make_client(StuckOnTheFirstSentence()) as client:
        dialog = start_dialog(client, user_id)
        with client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
            read_frames(ws, lambda f: has(f, "tts_start", messageId="greeting"))
            sent = time.monotonic()
            send_user_message(ws, "c-1", "раз")
            frames = read_frames(ws, lambda f: has(f, "tts_end", messageId="greeting") and reply_done(f))
            waited = time.monotonic() - sent

    assert has(frames, "tts_end", messageId="greeting")  # старая озвучка закрыта, а не висит
    assert waited < 2.5  # синтез приветствия заблокирован на 5 с: ответ его не ждёт


def test_time_to_first_sound_is_measured(voice_client, user_id):
    def count(stage: str) -> float:
        return sum(
            REGISTRY.get_sample_value("agent_voice_latency_seconds_count", {"stage": stage, "memory": memory}) or 0.0
            for memory in ("on", "off")
        )

    before = {stage: count(stage) for stage in ("tts_first", "first_sound")}
    dialog = start_dialog(voice_client, user_id)
    with voice_client.websocket_connect(ws_url(user_id, dialog["dialogId"]), headers=AUTH) as ws:
        read_frames(ws, lambda f: has(f, "tts_end"))  # приветствие: тайминг хода у него нет
        send_user_message(ws, "c-1", "привет")
        read_frames(ws, reply_done)

    assert count("first_sound") == before["first_sound"] + 1  # только у ответа, не у приветствия
    assert count("tts_first") >= before["tts_first"] + 2  # приветствие и ответ
