"""Расход моделей: каждый вызов модели пишет, сколько она получила и выдала, а сессия кладёт это на сообщение.

Два уровня: клиенты моделей против поддельного прокси (что именно они записывают) и диалог целиком с базой на диске (на какое
сообщение ложится расход каждой модели и сколько секунд речи в сообщении). Таблица model_usage — данные для отчётов.
"""

import asyncio
import json
import logging
import time
import uuid
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from prometheus_client import REGISTRY

from app.api.dialog_live import LiveDialogSession, LiveTurn
from app.clients.gemini_live import GeminiLiveTts
from app.main import create_app
from app.services import usage as model_usage
from app.services.dialog_db import DialogDbError
from tests.fake_db import FakeDialogDatabase as DialogDatabase
from app.services.dialog_store import GREETING_NEW, DialogStore
from app.services.replies import split_sentences
from app.services.usage import Usage
from tests.conftest import AUTH, FakeChat, FakeRecognizer, FakeTts, read_frames, send_user_message, start_dialog, ws_url
from tests.fake_live import FakeConnector, reply_done, speak_turn
from tests.test_llm import speak
from tests.test_models import chat, completion, whisper
from tests.test_speech import qwen
from tests.test_streaming import delta, proxy_chat, sse


def metric(name: str, **labels: str) -> float:
    return REGISTRY.get_sample_value(name, labels) or 0.0


def wait_until(condition: Any, what: str, timeout: float = 3.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if condition():
            return
        time.sleep(0.01)
    raise AssertionError(f"не дождались: {what}")


def usage_by_message(path: Path) -> list[tuple[Any, ...]]:
    """Расход по сообщениям: (роль сообщения или "dialog", модель, задача, направление, модальность, единица, сумма)."""
    roles = {(m[1], m[0]): m[3] for m in DialogDatabase.message_rows(str(path))}
    grouped: dict[tuple, float] = {}
    for row in DialogDatabase.usage_rows(str(path)):
        dialog_id, message_id, _, model, task, direction, modality, unit, amount = row
        key = (roles.get((dialog_id, message_id), "dialog"), model, task, direction, modality, unit)
        grouped[key] = grouped.get(key, 0.0) + amount
    return sorted((*key, total) for key, total in grouped.items())


def speech_by_message(path: Path) -> list[tuple[str, str, float | None]]:
    return [(m[3], m[4], m[6]) for m in DialogDatabase.message_rows(str(path))]


# ─── Клиенты моделей ──────────────────────────────────────────────────────────────────────────────────────────────


async def test_chat_answer_records_its_tokens_and_without_usage_nothing() -> None:
    body = {**completion("Я рядом."), "usage": {"prompt_tokens": 120, "completion_tokens": 9, "total_tokens": 129}}
    with model_usage.collect() as spent:
        await chat(lambda r: httpx.Response(200, json=body)).complete([{"role": "user", "content": "привет"}])
        await chat(lambda r: httpx.Response(200, json=completion("Без расхода."))).complete([])
    assert spent == [
        Usage("chat-model", "chat", "input", "text", "tokens", 120),
        Usage("chat-model", "chat", "output", "text", "tokens", 9),
    ]


async def test_chat_stream_records_the_usage_chunk() -> None:
    usage_chunk = json.dumps({"choices": [], "usage": {"prompt_tokens": 300, "completion_tokens": 12}})
    model = proxy_chat(lambda r: httpx.Response(200, content=sse(delta("Я "), delta("рядом.", "stop"), usage_chunk, "[DONE]")))
    with model_usage.collect() as spent:
        assert [piece async for piece in model.stream([])] == ["Я ", "рядом."]
    assert [(u.model, u.direction, u.amount) for u in spent] == [("model", "input", 300), ("model", "output", 12)]


async def test_whisper_records_the_seconds_of_audio_it_got() -> None:
    with model_usage.collect() as spent:
        await whisper(lambda r: httpx.Response(200, json={"text": "привет"})).transcribe(bytes(48_000))  # 1,5 с на 16 кГц
    assert spent == [Usage("stt-model", "stt", "input", "audio", "seconds", 1.5)]


async def test_qwen_records_characters_and_seconds_even_when_the_speech_is_cut() -> None:
    model = "qwen/qwen-audio-3.0-tts-flash"
    with model_usage.collect() as whole:
        await qwen(lambda r: httpx.Response(200, content=b"\x01\x00" * 24_000)).synthesize("Привет", "male")  # 1 с на 24 кГц
    assert whole == [Usage(model, "tts", "input", "text", "chars", 6), Usage(model, "tts", "output", "audio", "seconds", 1.0)]

    async def body() -> AsyncIterator[bytes]:
        yield b"\x01\x00" * 12_000
        yield b"\x01\x00" * 12_000

    with model_usage.collect() as cut:
        stream = qwen(lambda r: httpx.Response(200, content=body())).stream("Привет", "male")
        async for _ in stream:
            break  # человек перебил: дальше не слушаем
        await stream.aclose()  # type: ignore[attr-defined]
    assert cut == [Usage(model, "tts", "input", "text", "chars", 6), Usage(model, "tts", "output", "audio", "seconds", 0.5)]


async def test_gemini_phrase_session_logs_its_voice_without_the_text(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.INFO, logger="agent.gemini")
    tts = GeminiLiveTts(FakeConnector(reply="Я рядом."))
    assert await tts.synthesize("Тайная фраза", "female")
    await asyncio.gather(*tts._drains)
    [line] = [r.getMessage() for r in caplog.records if r.getMessage().startswith("gemini live opened")]
    assert "purpose=tts voice=female voice_name=fake-female model=fake-live-model phrase_chars=12 " in line
    assert "Тайная" not in line


async def test_gemini_phrase_usage_arrives_after_the_sound_and_is_read_in_the_background() -> None:
    connector = FakeConnector(reply="Я рядом.", usage={"input_text": 40, "output_audio": 25}, turn_complete=True)
    tts = GeminiLiveTts(connector)
    with model_usage.collect() as spent:
        assert await tts.synthesize("Я рядом.", "male")  # звук отдан по generation_complete, не дожидаясь usage
        await asyncio.gather(*tts._drains)
    assert spent == [
        Usage("fake-live-model", "phrase", "input", "text", "tokens", 40),
        Usage("fake-live-model", "phrase", "output", "audio", "tokens", 25),
    ]
    assert connector.links[0].closed  # после usage соединение закрыто


# ─── Каскад: расход каждой модели — на своём сообщении ────────────────────────────────────────────────────────────


class SpendingRecognizer(FakeRecognizer):
    async def transcribe(self, pcm: bytes) -> str:
        model_usage.record("stt-model", "stt", "input", "audio", "seconds", len(pcm) / 32_000)
        return await super().transcribe(pcm)


class SpendingChat(FakeChat):
    async def stream(self, messages: list[dict[str, str]]) -> AsyncIterator[str]:
        async for piece in super().stream(messages):
            yield piece
        model_usage.record("chat-model", "chat", "input", "text", "tokens", 120)
        model_usage.record("chat-model", "chat", "output", "text", "tokens", 9)


class SpendingTts(FakeTts):
    async def synthesize(self, text: str, voice: str = "male") -> bytes:
        model_usage.record("tts-model", "tts", "input", "text", "chars", len(text))
        return await super().synthesize(text, voice)


def chars(text: str) -> int:
    """Символы, ушедшие на озвучку: текст озвучивается по предложениям."""
    return sum(len(sentence) for sentence in split_sentences(text))


def test_cascade_turns_put_each_models_usage_on_the_message_it_produced(tmp_path: Path) -> None:
    path, user = tmp_path / "d.sqlite3", str(uuid.uuid4())
    chat_model = SpendingChat()
    app = create_app(
        lambda: SpendingTts(), lambda: (chat_model, SpendingRecognizer()), database_factory=lambda: DialogDatabase(str(path))
    )
    dialogs, human = metric("agent_dialogs_total"), metric("agent_speech_seconds_total", speaker="human")
    with TestClient(app) as client:
        dialog = start_dialog(client, user)
        with client.websocket_connect(ws_url(user, dialog["dialogId"]), headers=AUTH) as ws:
            speak(ws, frames=10)  # реплика 1 с
            read_frames(ws, reply_done)
            send_user_message(ws, "c-2", "И ещё одно")
            read_frames(ws, reply_done)

    reply = chars(chat_model.reply)
    assert usage_by_message(path) == [
        ("assistant", "chat-model", "chat", "input", "text", "tokens", 240.0),
        ("assistant", "chat-model", "chat", "output", "text", "tokens", 18.0),
        ("assistant", "tts-model", "tts", "input", "text", "chars", 2.0 * reply),
        ("dialog", "tts-model", "tts", "input", "text", "chars", float(chars(GREETING_NEW))),  # приветствие — не сообщение
        ("user", "stt-model", "stt", "input", "audio", "seconds", 1.0),  # набранная реплика распознавания не тратит
    ]
    spoken = [(role, seconds) for role, _, seconds in speech_by_message(path)]
    assert spoken == [("user", 1.0), ("assistant", 0.5), ("user", None), ("assistant", 0.5)]  # FakeTts: 0,5 с на предложение
    assert metric("agent_dialogs_total") == dialogs + 1  # один диалог, хоть реплик две
    assert metric("agent_speech_seconds_total", speaker="human") == human + 1.0


# ─── Gemini Live: расход хода — на ответе модели ──────────────────────────────────────────────────────────────────

USAGE = {"input_text": 300, "input_audio": 1000, "output_audio": 60}


def live_tokens(direction: str, modality: str) -> float:
    return metric(
        "agent_model_usage_total", model="fake-live-model", task="live", direction=direction, modality=modality, unit="tokens"
    )


def test_live_turn_usage_goes_on_the_models_answer_and_speech_on_the_messages(tmp_path: Path) -> None:
    path, user = tmp_path / "d.sqlite3", str(uuid.uuid4())
    connector = FakeConnector(usage=USAGE, turn_complete=True)
    app = create_app(
        lambda: FakeTts(), lambda: (None, None), live_factory=lambda: connector, database_factory=lambda: DialogDatabase(str(path))
    )
    before = live_tokens("input", "audio")
    with TestClient(app) as client:
        dialog = start_dialog(client, user)
        with client.websocket_connect(ws_url(user, dialog["dialogId"]), headers=AUTH) as ws:
            speak_turn(ws, loud=4)  # 4 кадра по 100 мс
            read_frames(ws, reply_done)
            wait_until(lambda: live_tokens("input", "audio") == before + 1000, "usage хода посчитан")

    assert usage_by_message(path) == [
        ("assistant", "fake-live-model", "live", "input", "audio", "tokens", 1000.0),
        ("assistant", "fake-live-model", "live", "input", "text", "tokens", 300.0),
        ("assistant", "fake-live-model", "live", "output", "audio", "tokens", 60.0),
    ]
    spoken = [(role, seconds) for role, _, seconds in speech_by_message(path)]
    assert spoken == [("user", 0.4), ("assistant", 1.0)]  # ответ модели: два куска FAKE_PCM по 0,5 с


async def test_live_usage_without_an_answer_message_goes_on_the_dialog(tmp_path: Path) -> None:
    store, db = DialogStore(), DialogDatabase(str(tmp_path / "d.sqlite3"))
    await store.attach(db, flush_interval=0.01)
    user = str(uuid.uuid4())
    await store.ensure_user(user)
    dialog, _, _ = store.start(user)
    session = LiveDialogSession(None, store, dialog, lambda: None, FakeConnector())  # type: ignore[arg-type]
    # Обычный порядок: usage приходит с turn_complete, когда ответ уже закончен.
    answered, silent = LiveTurn(kind="text", generating=False), LiveTurn(kind="voice", generating=False)
    store.add_message(dialog, "assistant", "Ответ модели", answered.message_id)
    session._usage_turn = answered
    session._count_usage({"input_text": 10})
    session._usage_turn = silent  # модель промолчала или ответ выброшен: сообщения нет
    session._count_usage({"input_audio": 20})
    session._usage_turn = None  # usage не по ходу (например, загрузка истории в новую сессию)
    session._count_usage({"input_text": 30})

    # Usage пришёл, пока ответ ещё пишется (события ответа ждут в очереди): ждёт конца хода и ложится на ответ.
    early = LiveTurn(kind="text")
    session._usage_turn = early
    session._count_usage({"output_audio": 40})
    store.add_message(dialog, "assistant", "Ответ дописан", early.message_id)
    await session._finish(early)
    await store.detach()

    rows = sorted(
        ((row[1], row[6], row[8]) for row in DialogDatabase.usage_rows(str(tmp_path / "d.sqlite3"))),
        key=lambda row: row[2],
    )
    assert rows == [
        (answered.message_id, "text", 10.0),
        (None, "audio", 20.0),
        (None, "text", 30.0),
        (early.message_id, "audio", 40.0),
    ]


async def test_without_a_database_usage_is_only_counted() -> None:
    store = DialogStore()
    dialog, _, _ = store.start(str(uuid.uuid4()))
    store.add_usage(dialog, None, [Usage("m", "live", "input", "text", "tokens", 5)])
    assert dialog.usage == []  # в памяти не копится: без диска общий счёт ведёт Prometheus
