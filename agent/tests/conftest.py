"""Общие фикстуры тестов agent."""

import asyncio
import json
import os
import struct
import time
import uuid
from collections.abc import Callable, Iterator
from typing import Any

# Конфиг читается при импорте приложения (fail-fast), поэтому env задаём до него.
# Присваиваем, а не setdefault: локальный .env разработчика не должен влиять на тесты.
os.environ["AGENT_INTERNAL_TOKEN"] = "test-internal-token"
os.environ["STREAM_DELAY_MS"] = "0"
os.environ["TTS_FRAME_INTERVAL_MS"] = "0"
os.environ["LLM_TIMEOUT_SECONDS"] = "1"  # тест зависшей модели ждёт ровно столько
os.environ["GEMINI_TPM_LIMIT"] = "0"  # учёт токенов Gemini выключен; его тесты (test_gemini_budget.py) включают его сами
os.environ.pop("AGENT_API_TOKEN", None)

import pytest  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from starlette.testclient import WebSocketTestSession  # noqa: E402

from app.main import create_app  # noqa: E402
from tests.fake_db import FakeDialogDatabase  # noqa: E402


def _let_the_session_finish(session: Any) -> None:
    """Закрыть сокет и дождаться, пока сеанс агента закончит уборку, прежде чем TestClient отменит приложение.

    `WebSocketTestSession.__exit__` шлёт disconnect и тут же отменяет задачу приложения: уборка сеанса (отмена задач, закрытие
    соединения с моделью, расход, трассы) рвалась посередине, а CancelledError выходил в тело теста. В бою сокет закрывается
    без отмены приложения. Ждём не дольше трёх секунд: зависший сеанс не должен вешать весь прогон."""
    parts = str(session.scope.get("path", "")).split("/")
    store = getattr(getattr(session.app, "state", None), "store", None)
    if store is None or len(parts) < 7 or parts[1:4] != ["v1", "users", parts[3]]:
        return
    try:
        session.close(1000)
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            dialog = store.get(parts[3], parts[5])
            if dialog is None or not dialog.has_live_socket:
                return
            time.sleep(0.005)
    except Exception:  # noqa: BLE001 - сокет уже закрыт или приложение остановлено: ждать нечего
        return


_original_exit = WebSocketTestSession.__exit__


def _exit_after_session_finished(self: WebSocketTestSession, *args: Any) -> bool | None:
    _let_the_session_finish(self)
    return _original_exit(self, *args)


WebSocketTestSession.__exit__ = _exit_after_session_finished  # type: ignore[method-assign]


@pytest.fixture(autouse=True)
def fake_db_files() -> Iterator[None]:
    """Чистый реестр «файлов» заглушки базы диалогов на каждый тест."""
    FakeDialogDatabase.reset()
    yield
    FakeDialogDatabase.reset()

# app.core.config при импорте делает load_dotenv(): значения из локального .env возвращаются. Убираем повторно те,
# чьё отсутствие ждут тесты (умолчания BackgroundModelSettings и отказ build_background_model без ключа).
for leaked in ("AGENT_API_TOKEN", "LLM_BASE_URL", "LLM_CHAT_MODEL"):
    os.environ.pop(leaked, None)

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


class FakeBackgroundModel:
    """Текстовая модель для тестов (итоги разговоров и недели): ответ задан заранее, запросы запоминаются."""

    name = "fake-chat"

    def __init__(self, reply: str = "Я рядом, расскажи ещё.", delay: float = 0.0, fail: bool = False) -> None:
        self.reply = reply
        self.delay = delay
        self.fail = fail
        self.calls: list[list[dict[str, str]]] = []

    async def complete(self, messages: list[dict[str, str]]) -> str:
        self.calls.append(messages)
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.fail:
            from app.clients.background_model import ModelError

            raise ModelError("модель сломана в тесте")
        return self.reply

    async def aclose(self) -> None:
        return None


def make_app(
    connector: Any = None, tts: Any = None, background: Any = None, real_tts: bool = False, **create_kwargs: Any
) -> FastAPI:
    """Приложение на поддельном Gemini Live (`tests/fake_live.py`): единственного голосового пути, другого у агента нет.

    `tts` — озвучка фиксированных фраз (приветствие, кризисный ответ, просьба повторить); без неё фразы не звучат, а текст
    доходит. `real_tts=True` — настоящая обвязка фраз (`GeminiLiveTts` поверх того же поддельного Gemini с кэшем и прогревом).
    `background` — фоновая текстовая модель (итоги разговоров, итоги недели); остальное (`database_factory`,
    `memory_settings`) уходит в `create_app` как есть."""
    from tests.fake_live import FakeConnector

    live = connector or FakeConnector()
    return create_app(
        live_factory=lambda: live,
        tts_factory=None if real_tts else (lambda: tts),
        background_factory=lambda: background,
        **create_kwargs,
    )


def make_client(tts: Any = None, background: Any = None, connector: Any = None, **kwargs: Any) -> TestClient:
    return TestClient(make_app(connector, tts, background, **kwargs))


@pytest.fixture
def client() -> Iterator[TestClient]:
    """Агент на поддельном Gemini Live без озвучки фраз: протокол текста и REST."""
    with make_client(None) as c:
        yield c


@pytest.fixture
def voice() -> FakeTts:
    return FakeTts()


@pytest.fixture
def voice_client(voice: FakeTts) -> Iterator[TestClient]:
    """Агент на поддельном Gemini Live с поддельной озвучкой фраз: кадры 0x02 приветствия, tts_cancel."""
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
    """Типы JSON-кадров по порядку. Кадры `component` (отчёт шлюзу об обращении к компоненту) не показаны: они идут
    между кадрами ответа в зависимости от конвейера, и порядок ответа от них не зависит. Смотреть их — `components`."""
    return [f[1]["type"] for f in frames if f[0] == "json" and f[1]["type"] != "component"]


def components(frames: list[Frame]) -> list[tuple[str, str, bool]]:
    """Обращения к компонентам, о которых сказал сокет: (название, исход, из памяти)."""
    return [(f[1]["component"], f[1]["outcome"], f[1]["cached"]) for f in frames if f[0] == "json" and f[1]["type"] == "component"]


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
