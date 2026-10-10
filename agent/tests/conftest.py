"""Общие фикстуры тестов agent."""

import asyncio
import json
import os
import re
import struct
import uuid
from collections.abc import AsyncIterator, Callable, Iterator
from typing import Any

# Конфиг читается при импорте приложения (fail-fast), поэтому env задаём до него.
# Присваиваем, а не setdefault: локальный .env разработчика не должен влиять на тесты.
os.environ["AGENT_INTERNAL_TOKEN"] = "test-internal-token"
os.environ["STREAM_DELAY_MS"] = "0"
os.environ["TTS_FRAME_INTERVAL_MS"] = "0"
os.environ["TTS_MODE"] = "none"
os.environ["LLM_MODE"] = "template"
os.environ["LLM_TIMEOUT_SECONDS"] = "1"  # тест зависшей модели ждёт ровно столько
os.environ["INCOMPLETE_HOLD_MS"] = "400"  # пауза для оборванной на полуслове реплики: в бою 1500, тесты не ждут столько
os.environ.pop("SALUTE_SPEECH_AUTH_KEY", None)
os.environ.pop("AGENT_API_TOKEN", None)

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.main import create_app  # noqa: E402

TOKEN = "test-internal-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}

# 0,5 с речи на каждое предложение: два кадра по 200 мс и неполный третий.
FAKE_PCM = struct.pack("<h", 1000) * 12_000


class FakeTts:
    """Озвучка для тестов: детерминированный PCM вместо настоящего синтеза."""

    name = "fake"

    def __init__(self, delay: float = 0.0, fail: bool = False) -> None:
        self.delay = delay
        self.fail = fail
        self.calls: list[str] = []
        self.voices: list[str] = []

    async def synthesize(self, text: str, voice: str = "male") -> bytes:
        self.calls.append(text)
        self.voices.append(voice)
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.fail:
            from app.clients.speech import TtsError

            raise TtsError("синтез сломан в тесте")
        return FAKE_PCM

    async def aclose(self) -> None:
        return None


class FakeChat:
    """Чат-модель для тестов: ответ задан заранее, запросы запоминаются."""

    name = "fake-chat"

    def __init__(
        self,
        reply: str = "Я рядом, расскажи ещё.",
        delay: float = 0.0,
        fail: bool = False,
        pieces: list[str] | None = None,
        piece_delay: float = 0.0,
        truncated: bool = False,
    ) -> None:
        self.reply = reply
        self.delay = delay
        self.fail = fail
        self.pieces = pieces
        self.piece_delay = piece_delay
        self.truncated = truncated
        self.calls: list[list[dict[str, str]]] = []

    async def complete(self, messages: list[dict[str, str]]) -> str:
        self.calls.append(messages)
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.fail:
            from app.clients.llm import ModelError

            raise ModelError("модель сломана в тесте")
        return self.reply

    async def stream(self, messages: list[dict[str, str]]) -> AsyncIterator[str]:
        """Ответ по словам, как стрим настоящей модели. `pieces` задаёт свою нарезку, `truncated` — обрыв по токенам."""
        self.calls.append(messages)
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.fail:
            from app.clients.llm import ModelError

            raise ModelError("модель сломана в тесте")
        for piece in self.pieces if self.pieces is not None else re.findall(r"\S+\s*", self.reply):
            yield piece
            if self.piece_delay:
                await asyncio.sleep(self.piece_delay)
        if self.truncated:
            from app.clients.llm import ReplyTruncated

            raise ReplyTruncated("оборван по токенам в тесте")

    async def aclose(self) -> None:
        return None


class FakeRecognizer:
    """Распознавание для тестов: возвращает заданный текст и запоминает присланный звук."""

    name = "fake-stt"

    def __init__(self, text: str = "мне сегодня тяжело", fail: bool = False) -> None:
        self.text = text
        self.fail = fail
        self.calls: list[bytes] = []

    async def transcribe(self, pcm: bytes) -> str:
        self.calls.append(pcm)
        if self.fail:
            from app.clients.llm import ModelError

            raise ModelError("распознавание сломано в тесте")
        return self.text

    async def aclose(self) -> None:
        return None


def make_client(tts: Any = None, chat: Any = None, recognizer: Any = None) -> TestClient:
    return TestClient(create_app(lambda: tts, lambda: (chat, recognizer)))


@pytest.fixture
def client() -> Iterator[TestClient]:
    """Агент без озвучки: протокол текста и REST."""
    with make_client(None) as c:
        yield c


@pytest.fixture
def voice() -> FakeTts:
    return FakeTts()


@pytest.fixture
def voice_client(voice: FakeTts) -> Iterator[TestClient]:
    """Агент с поддельной озвучкой: кадры 0x02, приветствие, tts_cancel."""
    with make_client(voice) as c:
        yield c


@pytest.fixture
def user_id() -> str:
    return str(uuid.uuid4())


def start_dialog(client: TestClient, user_id: str) -> dict[str, Any]:
    response = client.post(f"/v1/users/{user_id}/dialogs", headers=AUTH)
    assert response.status_code == 200, response.text
    return response.json()


def ws_url(user_id: str, dialog_id: str) -> str:
    return f"/v1/users/{user_id}/dialogs/{dialog_id}/ws"


Frame = tuple[str, Any]


def read_frames(ws: Any, stop: Callable[[list[Frame]], bool], limit: int = 400) -> list[Frame]:
    """Читает кадры сокета, пока `stop` не скажет хватит. ("json", dict) | ("bin", bytes) | ("close", код)."""
    frames: list[Frame] = []
    for _ in range(limit):
        message = ws.receive()
        if message["type"] == "websocket.close":
            frames.append(("close", message.get("code")))
            break
        if message.get("bytes") is not None:
            frames.append(("bin", message["bytes"]))
        else:
            frames.append(("json", json.loads(message["text"])))
        if stop(frames):
            break
    return frames


def types(frames: list[Frame]) -> list[str]:
    return [f[1]["type"] for f in frames if f[0] == "json"]


def has(frames: list[Frame], frame_type: str, **fields: Any) -> bool:
    return any(
        kind == "json" and body["type"] == frame_type and all(body.get(k) == v for k, v in fields.items())
        for kind, body in frames
    )


def send_user_message(ws: Any, client_id: str, text: str) -> None:
    ws.send_text(json.dumps({"type": "user_message", "id": client_id, "text": text}))


def audio_in_frame(sequence: int, loud: bool = False) -> bytes:
    """Кадр голоса человека: [0x01][номер uint32 BE][100 мс на 16 кГц]: тишина или громкий звук (`loud`)."""
    samples = struct.pack("<h", 3000) * 1600 if loud else bytes(3200)
    return struct.pack(">BI", 0x01, sequence) + samples
