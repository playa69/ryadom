"""Сквозные сценарии клиента через WebSocket против поддельного Gemini Live.

Каждый сценарий — то, что делает клиент приложения: открывает диалог, слушает приветствие, набирает или говорит реплику,
перебивает, обрывает соединение, завершает разговор. Агент работает на подделке Gemini Live (`tests/fake_live.py`: FakeConnector
и FakeLink, здесь они отвечают по сценарию и по плану событий хода), фиксированные фразы озвучивает FakeTts из tests/conftest.py
или настоящая обвязка GeminiLiveTts поверх той же подделки. Проверяется не текст, а то, что клиент способен заметить:
последовательность типов JSON-кадров, наличие и границы озвучки (кадры 0x02), контракт кадров (`contract()`: обязательные
поля, склейка assistant_delta против assistant_end.text, порядок tts_start/tts_end), история диалога, то, что увидела модель,
и ошибки в журнале агента (после сценария их быть не должно).

Тесты не заменяют проверку на живой модели: поведение Gemini моделируется подделкой, и там, где результат зависит от порядка
событий настоящего Gemini (расшифровка речи идёт отдельным потоком), это сказано в причине xfail.

xfail(strict=True) с причиной «ИЗВЕСТНО: …» отмечают известные недостатки Live: тест описывает, как должно быть, и падает,
пока недостаток не исправлен. Когда его исправят, strict-xfail даст XPASS и упадёт: это напоминание снять отметку. Закрытые
недостатки (P5, P7, P8, P10, P15) оставлены обычными тестами, в комментарии над ними сказано, что именно было не так.
"""

import asyncio
import json
import logging
import struct
import time
import uuid
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any

import anyio
import pytest
from fastapi.testclient import TestClient
from prometheus_client import REGISTRY
from starlette.testclient import WebSocketDenialResponse

from app.api.dialog_session import MAX_AUDIO_BYTES, PRE_ROLL_FRAMES
from app.clients.gemini_live import VERBATIM_INSTRUCTIONS, LiveError, LiveEvent, LiveHistory
from app.core.config import APP_CONFIG
from app.services.dialog_store import GREETING_NEW, GREETING_RESUMED
from app.services.replies import CRISIS_REPLY, CRISIS_SAFETY_TEXT, split_sentences
from tests.conftest import (
    AUTH,
    FAKE_PCM,
    FakeTts,
    Frame,
    audio_in_frame,
    has,
    make_app,
    ws_url,
)
from tests.fake_live import FakeConnector, FakeLink, re_split

WAIT = 6.0  # сколько ждать кадр, который должен прийти; дольше — зависание
BARRIER = "__barrier__"
REPLY = "Понимаю, это непросто. Что сейчас тревожит больше всего?"
GREETING_SENTENCES = (*split_sentences(GREETING_NEW), *split_sentences(GREETING_RESUMED))
GREETING_VOICE = ["tts_start(greeting)", "bin", "tts_end(greeting)"]  # озвучка приветствия: одно сообщение, кадры подряд
REPLY_VOICE = ["tts_start(#1)", "bin", "tts_end(#1)"]  # озвучка первого ответа на реплику
ANSWER_TEXT = ["assistant_start", "assistant_delta", "assistant_end"]  # ответ модели (дельты подряд слиты в одну)


class KnownGap(AssertionError):
    """Известный недостаток live. Только такие падения засчитываются как xfail: любое другое падение теста остаётся падением."""


def gap(ok: bool, what: str) -> None:
    if not ok:
        raise KnownGap(what)


def known_gap(reason: str):  # noqa: ANN201
    return pytest.mark.xfail(raises=KnownGap, strict=True, reason="ИЗВЕСТНО: " + reason)


@pytest.fixture(autouse=True)
def pinned_settings(monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture) -> Iterator[None]:
    """Настройки live не зависят от .env разработчика; после каждого сценария в журнале агента нет ошибок (падений задач)."""
    gemini = APP_CONFIG.gemini
    for name, value in (
        ("idle_timeout_seconds", 15),
        ("transcript_wait_ms", 1000),
        ("history_messages", 12),
    ):
        monkeypatch.setattr(gemini, name, value)
    yield
    errors = [r for r in caplog.records if r.levelno >= logging.ERROR]
    assert not errors, "ошибки в журнале агента: " + "; ".join(f"{r.name}: {r.getMessage()[:160]}" for r in errors)


# ─── Подделки: сценарий текста для Gemini ────────────────────────────────────────────────────────────────────────


@dataclass
class Script:
    """Что расшифровка Gemini «слышит» в речи человека и что отвечает модель, по очереди."""

    heard: list[str] = field(default_factory=lambda: ["мне сегодня тяжело"])
    replies: list[str] = field(default_factory=lambda: [REPLY])

    @staticmethod
    def _take(items: list[str]) -> str:
        return items.pop(0) if len(items) > 1 else (items[0] if items else "")

    def next_heard(self) -> str:
        return self._take(self.heard)

    def next_reply(self) -> str:
        return self._take(self.replies)


Plan = Callable[["ScriptedLink", str | None, str], "list[LiveEvent | float]"]


class ScriptedLink(FakeLink):
    """FakeLink с ответами по сценарию. `plan` задаёт события хода; число в списке — пауза в секундах."""

    def __init__(
        self,
        cfg: "ScriptedConnector",
        voice: str,
        instructions: str,
        history: LiveHistory | None = None,
    ) -> None:
        super().__init__(voice, "", "", instructions, history)
        self.cfg = cfg
        self.typed: list[str] = []
        self.heard_log: list[str] = []
        self.reply_log: list[str] = []
        self._tasks: set[asyncio.Task[None]] = set()
        self._output_started = False

    def default_plan(self, heard: str | None, reply: str) -> "list[LiveEvent | float]":
        events: list[LiveEvent | float] = []
        if heard:
            events.append(LiveEvent("input_text", text=heard))
        if reply:
            for piece in re_split(reply):
                events.append(LiveEvent("output_text", text=piece))
                if self.cfg.piece_delay:
                    events.append(self.cfg.piece_delay)
            if self.cfg.audio:
                events += [LiveEvent("audio", data=FAKE_PCM), LiveEvent("audio", data=FAKE_PCM)]
        events += [LiveEvent("generation_complete")]
        if self.instructions == VERBATIM_INSTRUCTIONS:
            # Сессия озвучки фразы: Google присылает turn_complete после звука, и прогрев закрывает её, прежде чем открыть
            # следующую (иначе каждая фраза ждала бы дочитывания расхода до таймаута).
            events.append(LiveEvent("turn_complete"))
        return events

    def _interrupt(self) -> None:
        """Новый ввод посреди ответа: сервер бросает идущую генерацию (и шлёт interrupted, если ответ уже начался)."""
        pending = [task for task in self._tasks if not task.done()]
        for task in pending:
            task.cancel()
        if pending and self._output_started:
            self._queue.put_nowait(LiveEvent("interrupted"))
        self._output_started = False

    async def activity_start(self) -> None:
        self._interrupt()
        await super().activity_start()

    def _respond(self, heard: str | None) -> None:  # type: ignore[override]
        self._interrupt()
        reply = self.cfg.script.next_reply()
        self.reply_log.append(reply)
        if heard:
            self.heard_log.append(heard)
        plan = self.cfg.plan or ScriptedLink.default_plan
        items = plan(self, heard, reply)
        if self.cfg.latency:  # модель думает прежде, чем начать отвечать
            items = [self.cfg.latency, *items]
        if not any(isinstance(item, float) for item in items):
            for item in items:
                self._queue.put_nowait(item)  # type: ignore[arg-type]
            return

        async def later() -> None:
            for item in items:
                if isinstance(item, float):
                    await asyncio.sleep(item)
                else:
                    self._output_started = self._output_started or item.kind in ("output_text", "audio")
                    self._queue.put_nowait(item)

        task = asyncio.get_running_loop().create_task(later())
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def activity_end(self) -> None:
        self.commands.append(("end",))
        self._respond(self.cfg.script.next_heard())

    async def send_text(self, text: str) -> None:
        self.commands.append(("text", text))
        self.typed.append(text)
        self._respond(None)

    async def nudge(self) -> None:
        self.commands.append(("nudge",))
        self._respond(None)

    async def aclose(self) -> None:
        for task in list(self._tasks):
            task.cancel()
        await super().aclose()


class ScriptedConnector(FakeConnector):
    def __init__(
        self,
        script: Script,
        fail: bool = False,
        audio: bool = True,
        plan: Plan | None = None,
        latency: float = 0.0,
        piece_delay: float = 0.0,
    ) -> None:
        super().__init__(fail=fail)
        self.script = script
        self.audio = audio
        self.plan = plan
        self.latency = latency
        self.piece_delay = piece_delay

    async def open(  # type: ignore[override]
        self, voice: str, instructions: str, history: LiveHistory | None = None
    ) -> ScriptedLink:
        self.open_calls.append(voice)
        self.history_calls.append(history)
        if self.fail:
            raise LiveError("Gemini Live не открылся в тесте")
        link = ScriptedLink(self, voice, instructions, history)
        self.links.append(link)
        return link


class SelectiveTts(FakeTts):
    """Озвучка, которая отказывает на всём, кроме приветствий: ответу на реплику нечем звучать."""

    async def synthesize(self, text: str, voice: str = "male") -> bytes:
        if text not in GREETING_SENTENCES:
            self.fail = True
        return await super().synthesize(text, voice)


# ─── Соединение: чтение кадров с таймаутом ───────────────────────────────────────────────────────────────────────


def _recv(ws: Any, timeout: float) -> dict[str, Any] | None:
    """Следующее сообщение сокета или None, если за `timeout` секунд ничего не пришло (в отличие от ws.receive)."""

    async def receive() -> dict[str, Any]:
        with anyio.fail_after(timeout):
            return await ws._send_rx.receive()

    try:
        return ws.portal.call(receive)
    except TimeoutError:
        return None


def reply_done(frames: list[Frame], voiced: bool = True, n: int = 1, exclude: frozenset[str] = frozenset()) -> bool:
    """Есть n завершённых ответов (кроме `exclude`) и, если ответы озвучиваются, закрыта озвучка каждого."""
    ends = [b["messageId"] for k, b in frames if k == "json" and b["type"] == "assistant_end" and b["messageId"] not in exclude]
    if len(ends) < n:
        return False
    return not voiced or all(has(frames, "tts_end", messageId=m) for m in ends[:n])


class Conn:
    def __init__(self, ws: Any, rig: "Rig") -> None:
        self.ws = ws
        self.rig = rig
        self.frames: list[Frame] = []
        self.stalled: list[str] = []  # ожидания, которые не дождались
        self.cut = -1
        self.barrier_ok = True

    # отправка

    def send(self, **frame: Any) -> None:
        self.ws.send_text(json.dumps(frame))

    def say(self, text: str, cid: str) -> None:
        self.send(type="user_message", id=cid, text=text)

    def speak(self, frames: int = 4, *, loud: bool = True, tail: int = 0) -> None:
        self.send(type="audio_start")
        for n in range(frames):
            self.ws.send_bytes(audio_in_frame(n, loud=loud))
        for n in range(tail):
            self.ws.send_bytes(audio_in_frame(frames + n))
        self.send(type="audio_end")

    def cancel(self, message_id: str) -> None:
        self.send(type="tts_cancel", messageId=message_id)

    # чтение

    def mark(self) -> int:
        return len(self.frames)

    def _take(self, message: dict[str, Any]) -> None:
        if message["type"] == "websocket.close":
            frame: Frame = ("close", message.get("code"))
        elif message.get("bytes") is not None:
            frame = ("bin", message["bytes"])
        else:
            frame = ("json", json.loads(message["text"]))
        self.frames.append(frame)

    def pump(self, stop: Callable[[list[Frame]], bool], start: int = 0, timeout: float = WAIT) -> bool:
        end = time.monotonic() + timeout
        while True:
            if stop(self.frames[start:]):
                return True
            left = end - time.monotonic()
            if left <= 0:
                return False
            message = _recv(self.ws, left)
            if message is None:
                return False
            self._take(message)
            if message["type"] == "websocket.close":
                return stop(self.frames[start:])

    def wait(self, what: str, stop: Callable[[list[Frame]], bool], start: int = 0, timeout: float = WAIT) -> bool:
        ok = self.pump(stop, start, timeout)
        if not ok:
            self.stalled.append(what)
        return ok

    def wait_greeting(self) -> None:
        if self.rig.greets:
            self.wait("приветствие", lambda fs: has(fs, "tts_end", messageId="greeting"))
        else:
            self.wait("ready", lambda fs: has(fs, "ready"))

    def wait_reply(self, start: int, n: int = 1, exclude: frozenset[str] = frozenset(), timeout: float = WAIT) -> bool:
        voiced = self.rig.voiced
        return self.wait(f"ответ ×{n}", lambda fs: reply_done(fs, voiced, n, exclude), start, timeout)

    def wait_type(self, frame_type: str, start: int, timeout: float = WAIT, **fields: Any) -> bool:
        return self.wait(frame_type, lambda fs: has(fs, frame_type, **fields), start, timeout)

    def finish(self, voiced: bool | None = None, timeout: float = WAIT) -> None:
        """Барьер: набранная реплика после сценария. Всё, что пришло до её ack, — итог сценария; её ответ — проверка, что диалог жив."""
        mark = self.mark()
        self.say("барьер", BARRIER)
        self.pump(lambda fs: has(fs, "ack", id=BARRIER), mark, timeout)
        self.cut = next(
            (i for i in range(mark, len(self.frames)) if self.frames[i][0] == "json" and self.frames[i][1].get("id") == BARRIER),
            len(self.frames),
        )
        voiced = self.rig.voiced if voiced is None else voiced
        self.barrier_ok = self.pump(lambda fs: reply_done(fs, voiced), self.cut, timeout)

    def dump(self) -> str:
        out = []
        for kind, body in self.frames:
            if kind == "json":
                out.append(body["type"] + (f"({body.get('code') or body.get('text', '')[:20]!r})" if body["type"] in ("error", "transcript") else ""))
            else:
                out.append(kind)
        return " ".join(out)


# ─── Стенд ────────────────────────────────────────────────────────────────────────────────────────────────────────


class Rig:
    def __init__(
        self,
        client: TestClient,
        script: Script,
        tts: FakeTts | None,
        connector: ScriptedConnector,
        voiced: bool,
    ) -> None:
        self.client = client
        self.script = script
        self.tts = tts
        self.connector = connector
        self.voiced = voiced
        # приветствие озвучивается (иначе клиент прочтёт его сам или придёт error)
        self.greets = (tts is not None and not tts.fail) or (tts is None and client.app.state.tts is not None and not connector.fail)
        self.user_id = str(uuid.uuid4())
        self.conns: list[Conn] = []
        self.hung: list[str] = []  # сессии, которые не закончились после закрытия сокета (зависшая уборка)

    def start(self, voice: str | None = None) -> dict[str, Any]:
        response = self.client.post(f"/v1/users/{self.user_id}/dialogs", json={"voice": voice} if voice else None, headers=AUTH)
        assert response.status_code == 200, response.text
        return response.json()

    @contextmanager
    def socket(self, dialog: dict[str, Any]) -> Iterator[Conn]:
        store = self.client.app.state.store
        with self.client.websocket_connect(ws_url(self.user_id, dialog["dialogId"]), headers=AUTH) as ws:
            conn = Conn(ws, self)
            self.conns.append(conn)
            try:
                yield conn
            finally:
                # TestClient отменяет приложение сразу после закрытия сокета, и уборка сессии рвалась бы посередине (чего в
                # бою нет): закрываем сами и ждём, пока сессия закончится (dialog.has_live_socket снимается в самом конце).
                ws.close(1000)
                deadline = time.monotonic() + 3
                while time.monotonic() < deadline and store.get(self.user_id, dialog["dialogId"]).has_live_socket:
                    time.sleep(0.005)
                if store.get(self.user_id, dialog["dialogId"]).has_live_socket:
                    self.hung.append(dialog["dialogId"])

    def history(self, dialog: dict[str, Any]) -> list[dict[str, Any]]:
        return self.client.get(f"/v1/users/{self.user_id}/dialogs/{dialog['dialogId']}", headers=AUTH).json()["messages"]

    def done(
        self, conn: Conn, dialog: dict[str, Any], barrier: bool = True, voiced: bool | None = None, wait: float = WAIT, **extra: Any
    ) -> "Run":
        extra.setdefault("tts_calls", list(self.tts.calls) if self.tts else [])  # до ответа на барьер
        if barrier:
            conn.finish(voiced, wait)
        cut = conn.cut if barrier else len(conn.frames)
        return Run(
            rig=self,
            conn=conn,
            frames=conn.frames[:cut],
            tail=conn.frames[cut:],
            history=self.history(dialog),
            extra=extra,
        )

    # что видела модель

    def model_context(self) -> str:
        """Всё, что модель знала к моменту последнего ответа: инструкции, прошлые реплики, загруженные в сессию отдельно от
        промпта, реплики и слова сессии Gemini."""
        link = self.connector.links[-1]
        loaded = [text for _, text in link.history or []]
        return "\n".join([link.instructions, *loaded, *link.typed, *link.heard_log, *link.reply_log[:-1]])

    def model_turns(self) -> int:
        """Сколько раз модель просили ответить."""
        return sum(len(link.reply_log) for link in self.connector.links)

    def audio_bytes_to_model(self) -> int:
        return sum(c[1] for link in self.connector.links for c in link.commands if c[0] == "audio")

    def model_asked_with_voice(self) -> int:
        """Сколько раз до барьера модели отдали голос человека."""
        return sum(1 for link in self.connector.links for c in link.commands if c[0] == "end")


@contextmanager
def rig(
    *,
    replies: list[str] | None = None,
    heard: list[str] | None = None,
    tts: Any = "ok",
    connector_fail: bool = False,
    audio: bool = True,
    plan: Plan | None = None,
    real_tts: bool = False,
    voiced: bool | None = None,
    latency: float = 0.0,
    piece_delay: float = 0.0,
) -> Iterator[Rig]:
    script = Script(heard=list(heard or ["мне сегодня тяжело"]), replies=list(replies if replies is not None else [REPLY]))
    makers = {"ok": FakeTts, "fail": lambda: FakeTts(fail=True), "none": lambda: None}
    tts_obj = None if real_tts else makers[tts]() if isinstance(tts, str) else tts()
    connector = ScriptedConnector(script, fail=connector_fail, audio=audio, plan=plan, latency=latency, piece_delay=piece_delay)
    client = TestClient(make_app(connector, tts_obj, real_tts=real_tts))
    speaks = (audio and not connector_fail) or (tts_obj is not None and not tts_obj.fail)
    with client:
        yield Rig(client, script, tts_obj, connector, speaks if voiced is None else voiced)


# ─── Что видит клиент: проекции и контракт ───────────────────────────────────────────────────────────────────────


def text_shape(frames: list[Frame]) -> list[str]:
    """Типы JSON-кадров по порядку без озвучки; дельты подряд слиты, транскрипты и ошибки уточнены."""
    out: list[str] = []
    for kind, body in frames:
        if kind == "bin":
            continue
        if kind == "close":
            out.append(f"close:{body}")
            continue
        name = body["type"]
        # `component` — отчёт шлюзу об обращении к компоненту: клиент его не получает (шлюз превращает его в событие
        # аналитики), и на то, что видит человек, он не влияет.
        if name in ("tts_start", "tts_end", "component"):
            continue
        if name == "transcript":
            name = "transcript:" + ("partial" if not body.get("final") else "final" if body.get("text") else "empty")
        elif name == "error":
            name = f"error:{body.get('code')}"
        if name == "assistant_delta" and out and out[-1] == name:
            continue
        out.append(name)
    return out


def voice_shape(frames: list[Frame]) -> list[str]:
    """Озвучка: границы по сообщениям (greeting или номер ответа по порядку), кадры 0x02 подряд слиты в один «bin»."""
    numbers: dict[str, str] = {"greeting": "greeting"}
    for kind, body in frames:
        if kind == "json" and body["type"] == "assistant_start":
            numbers[body["messageId"]] = f"#{len(numbers)}"
    out: list[str] = []
    for kind, body in frames:
        if kind == "bin":
            if out and out[-1] != "bin" and out[-1].startswith("tts_start"):
                out.append("bin")
        elif kind == "json" and body["type"] in ("tts_start", "tts_end"):
            out.append(f"{body['type']}({numbers.get(body['messageId'], '?')})")
    return out


def contract(frames: list[Frame], closed_ends: bool = True) -> list[str]:
    """Нарушения контракта agent-api в кадрах одного сокета (specs/agent-api «Разговор по WebSocket», «Голос»)."""
    bad: list[str] = []
    if not frames or frames[0] != ("json", {"v": 1, "type": "ready"}):
        bad.append(f"первый кадр не ready: {frames[:1]}")
    started: dict[str, list[str]] = {}
    finished: set[str] = set()
    window: str | None = None
    sequence = 0
    ended = False
    for i, (kind, body) in enumerate(frames):
        if kind == "close":
            continue
        if ended:
            bad.append(f"кадр после ended (#{i})")
        if kind == "bin":
            if body[0] != 0x02:
                bad.append(f"двоичный кадр не 0x02 (#{i})")
            elif window is None:
                bad.append(f"кадр 0x02 вне tts_start/tts_end (#{i})")
            else:
                if struct.unpack(">I", body[1:5])[0] != sequence:
                    bad.append(f"нумерация кадров озвучки сбита (#{i})")
                sequence += 1
            if len(body) > 9605 or (len(body) - 5) % 2:
                bad.append(f"размер кадра 0x02 {len(body)} (#{i})")
            continue
        name = body.get("type")
        if body.get("v") != 1:
            bad.append(f"кадр без v=1 (#{i})")
        if name == "ready":
            if i != 0:
                bad.append(f"ready не первым (#{i})")
        elif name == "ack":
            if not (isinstance(body.get("id"), str) and isinstance(body.get("messageId"), str)):
                bad.append(f"ack без id/messageId (#{i})")
        elif name == "transcript":
            if not isinstance(body.get("text"), str) or not isinstance(body.get("final"), bool):
                bad.append(f"transcript без text/final (#{i})")
            elif body["final"] and body["text"] and not body.get("messageId"):
                bad.append(f"final-транскрипт с текстом без messageId (#{i})")
            elif body["final"] and not body["text"] and "messageId" in body:
                bad.append(f"пустой транскрипт с messageId (#{i})")
        elif name == "assistant_start":
            if body["messageId"] in started:
                bad.append(f"второй assistant_start для {body['messageId']} (#{i})")
            started[body["messageId"]] = []
        elif name == "assistant_delta":
            mid = body.get("messageId")
            if mid not in started or mid in finished:
                bad.append(f"дельта вне assistant_start/assistant_end (#{i})")
            elif not body.get("text"):
                bad.append(f"пустая дельта (#{i})")
            else:
                started[mid].append(body["text"])
        elif name == "assistant_end":
            mid = body.get("messageId")
            if mid not in started or mid in finished:
                bad.append(f"assistant_end без начала или второй (#{i})")
            else:
                finished.add(mid)
                if "".join(started[mid]) != body.get("text"):
                    bad.append(f"склейка дельт {''.join(started[mid])!r} != assistant_end.text {body.get('text')!r}")
                if not body.get("text"):
                    bad.append(f"пустой assistant_end (#{i})")
        elif name == "tts_start":
            mid = body.get("messageId")
            if window is not None:
                bad.append(f"озвучки перемежаются: tts_start({mid}) внутри {window} (#{i})")
            if mid != "greeting" and mid not in started:
                bad.append(f"tts_start для неизвестного сообщения {mid} (#{i})")
            window, sequence = mid, 0
        elif name == "tts_end":
            if body.get("messageId") != window:
                bad.append(f"tts_end({body.get('messageId')}) не закрывает {window} (#{i})")
            window = None
        elif name == "safety":
            if "text" in body and not isinstance(body["text"], str):
                bad.append(f"safety.text не строка (#{i})")
        elif name == "error":
            if not isinstance(body.get("code"), str):
                bad.append(f"error без code (#{i})")
        elif name == "ended":
            if not isinstance(body.get("summary"), dict):
                bad.append(f"ended без summary (#{i})")
            ended = True
        elif name == "component":
            if body.get("component") not in ("stt", "safety", "llm", "live", "tts", "memory"):
                bad.append(f"component с неизвестным названием {body.get('component')!r} (#{i})")
            elif body.get("outcome") not in ("ok", "error") or not isinstance(body.get("cached"), bool):
                bad.append(f"component без исхода или признака cached (#{i})")
            elif set(body) - {"v", "type", "component", "outcome", "cached"}:
                bad.append(f"в component лишние поля {sorted(set(body) - {'v', 'type', 'component', 'outcome', 'cached'})} (#{i})")
        else:
            bad.append(f"неизвестный тип кадра {name!r} (#{i})")
    if window is not None and closed_ends:
        bad.append(f"озвучка {window} не закрыта tts_end")
    if closed_ends and set(started) - finished:
        bad.append(f"ответ без assistant_end: {sorted(set(started) - finished)}")
    return bad


@dataclass
class Run:
    rig: Rig
    conn: Conn
    frames: list[Frame]  # всё до барьера
    tail: list[Frame]  # ответ на барьер
    history: list[dict[str, Any]]
    extra: dict[str, Any]

    @property
    def text(self) -> list[str]:
        return text_shape(self.frames)

    @property
    def voice(self) -> list[str]:
        return voice_shape(self.frames)

    def bodies(self, frame_type: str) -> list[dict[str, Any]]:
        return [b for k, b in self.frames if k == "json" and b["type"] == frame_type]

    @property
    def replies(self) -> list[str]:
        return [b["text"] for b in self.bodies("assistant_end")]

    @property
    def errors(self) -> list[str]:
        return [b["code"] for b in self.bodies("error")]

    def deltas(self, message_id: str) -> str:
        return "".join(b["text"] for b in self.bodies("assistant_delta") if b["messageId"] == message_id)

    def roles(self) -> list[str]:
        return [m["role"] for m in self.history]


def sound(run: Run, closed_ends: bool = True, alive: bool = True) -> None:
    """Базовая проверка прогона: ничего не зависло, контракт соблюдён, диалог жив после сценария (`alive=False` — Gemini лежит
    и на барьер ответить нечем: проверяется только, что ничего не зависло)."""
    assert not run.conn.stalled, f"не дождались {run.conn.stalled}; пришло: {run.conn.dump()}"
    assert not run.rig.hung, "сессия не закончилась после закрытия сокета (зависшая уборка задач)"
    assert contract(run.conn.frames, closed_ends) == [], f"{contract(run.conn.frames, closed_ends)}\n{run.conn.dump()}"
    if alive:
        assert run.conn.barrier_ok or run.conn.cut < 0, f"диалог не ответил после сценария: {run.conn.dump()}"


def play(scenario: Callable[[Rig], Run], **cfg: Any) -> Run:
    """Один прогон сценария на новом стенде; `cfg` — настройки `rig(...)`."""
    with rig(**cfg) as r:
        return scenario(r)


def metric(name: str) -> float:
    return REGISTRY.get_sample_value(name) or 0.0


# ─── Сценарии ─────────────────────────────────────────────────────────────────────────────────────────────────────


def sc_greeting(r: Rig, resumed: bool = False) -> Run:
    if resumed:
        r.start()  # первый POST: диалог открыт, приветствие до сокета не доходит
    dialog = r.start()
    assert dialog["resumed"] is resumed
    with r.socket(dialog) as c:
        c.wait_greeting()
        return r.done(c, dialog, greeting=dialog["greeting"])


def sc_text(r: Rig, text: str = "Мне сегодня тревожно") -> Run:
    dialog = r.start()
    with r.socket(dialog) as c:
        c.wait_greeting()
        m = c.mark()
        c.say(text, "c-1")
        c.wait_reply(m)
        return r.done(c, dialog)


def sc_duplicate(r: Rig, settled: bool) -> Run:
    dialog = r.start()
    with r.socket(dialog) as c:
        c.wait_greeting()
        m = c.mark()
        c.say("раз", "c-1")
        if settled:
            c.wait_reply(m)
        c.say("раз", "c-1")  # клиент не получил ack и повторяет
        c.wait("два ack", lambda fs: types_count(fs, "ack") == 2, m)
        c.wait_reply(m)
        return r.done(c, dialog)


def types_count(frames: list[Frame], frame_type: str) -> int:
    return sum(1 for k, b in frames if k == "json" and b["type"] == frame_type)


def sc_voice(r: Rig, frames: int = 4, loud: bool = True, tail: int = 0, reply: bool = True, wait: float = WAIT) -> Run:
    dialog = r.start()
    with r.socket(dialog) as c:
        c.wait_greeting()
        m = c.mark()
        c.speak(frames, loud=loud, tail=tail)
        c.wait_type("transcript", m, timeout=wait)
        if reply:
            c.wait_reply(m, timeout=wait)
        return r.done(c, dialog, wait=wait)


def sc_barge_in(r: Rig, echo: bool = False) -> Run:
    dialog = r.start()
    with r.socket(dialog) as c:
        c.wait_greeting()
        m = c.mark()
        c.say("раз", "c-1")
        c.wait_type("tts_start", m)
        first = next((b["messageId"] for k, b in c.frames[m:] if k == "json" and b["type"] == "tts_start"), "?")
        c.cancel(first)
        m2 = c.mark()
        c.speak(4)
        c.wait_type("transcript", m2)
        if not echo:
            c.wait("ответ на перебивание", lambda fs: reply_done(fs, r.voiced, 1, frozenset({first})), m2)
        return r.done(c, dialog, first=first)


def bins_between(frames: list[Frame], message_id: str) -> int:
    inside, count = False, 0
    for kind, body in frames:
        if kind == "json" and body["type"] == "tts_start" and body["messageId"] == message_id:
            inside = True
        elif kind == "json" and body["type"] == "tts_end" and body["messageId"] == message_id:
            break
        elif kind == "bin" and inside:
            count += 1
    return count


# ─── Приветствие ──────────────────────────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("resumed", [False, True], ids=["new", "resumed"])
def test_greeting_new_and_resumed(resumed: bool) -> None:
    run = play(lambda r: sc_greeting(r, resumed))
    sound(run)
    assert run.voice == GREETING_VOICE and run.text == ["ready"]
    greeting = GREETING_RESUMED if resumed else GREETING_NEW
    assert run.extra["tts_calls"] == list(split_sentences(greeting))
    assert run.extra["greeting"] == greeting  # приветствие в ответе POST
    assert [m["text"] for m in run.history] == ["барьер", REPLY]  # в истории только барьер: приветствие сообщением не хранится


# ─── Набранная реплика ───────────────────────────────────────────────────────────────────────────────────────────


def test_typed_message() -> None:
    run = play(sc_text)
    sound(run)
    assert run.text == ["ready", "ack", "assistant_start", "assistant_delta", "assistant_end"]
    assert run.voice == GREETING_VOICE + REPLY_VOICE
    ack, end = run.bodies("ack")[0], run.bodies("assistant_end")[0]
    assert ack["id"] == "c-1" and end["text"] == REPLY and run.deltas(end["messageId"]) == end["text"]
    assert run.roles()[:2] == ["user", "assistant"] and run.history[0]["id"] == ack["messageId"]
    assert run.history[0]["text"] == "Мне сегодня тревожно" and run.history[1]["id"] == end["messageId"]
    assert run.history[1]["text"] == REPLY


@pytest.mark.parametrize("settled", [True, False], ids=["after-reply", "before-reply"])
def test_repeated_typed_message_gives_one_answer_and_second_ack(settled: bool) -> None:
    run = play(lambda r: sc_duplicate(r, settled))
    sound(run)
    acks = run.bodies("ack")
    assert [a["id"] for a in acks] == ["c-1", "c-1"] and acks[0]["messageId"] == acks[1]["messageId"]
    assert len(run.replies) == 1 and run.roles()[:2] == ["user", "assistant"]
    assert run.roles() == ["user", "assistant"] * 2  # история после повтора: одна пара диалога и пара барьера


# ─── Голосовая реплика ───────────────────────────────────────────────────────────────────────────────────────────


def test_voice_turn() -> None:
    run = play(sc_voice)
    sound(run)
    assert run.text == ["ready", "transcript:final", "assistant_start", "assistant_delta", "assistant_end"]
    assert run.voice == GREETING_VOICE + REPLY_VOICE
    transcript = run.bodies("transcript")[0]
    assert transcript["text"] == "мне сегодня тяжело" and transcript["final"] is True
    assert "ack" not in run.text  # на голосовую реплику ack не нужен
    assert run.history[0]["id"] == transcript["messageId"] and run.history[0]["text"] == transcript["text"]
    assert run.roles()[:2] == ["user", "assistant"] and run.replies == [REPLY]


@pytest.mark.parametrize("how", ["no-frames", "silent-frames"])
def test_silence_gives_an_empty_final_transcript_and_no_reply(how: str) -> None:
    frames = 0 if how == "no-frames" else 5
    run = play(lambda r: sc_voice(r, frames=frames, loud=False, reply=False))
    sound(run)
    assert run.text == ["ready", "transcript:empty"]
    assert run.bodies("transcript")[0] == {"v": 1, "type": "transcript", "text": "", "final": True}
    assert run.roles() == ["user", "assistant"], "история только от барьера"
    assert run.history[0]["text"] == "барьер"
    assert run.rig.model_asked_with_voice() == 0  # тишина модели не достаётся


# ─── Кризис ──────────────────────────────────────────────────────────────────────────────────────────────────────


def test_typed_crisis() -> None:
    run = play(lambda r: sc_text(r, "я больше не хочу жить"))
    sound(run)
    assert run.text == ["ready", "ack", "safety", "assistant_start", "assistant_delta", "assistant_end"]
    assert run.voice == GREETING_VOICE + REPLY_VOICE
    assert run.bodies("safety")[0]["text"] == CRISIS_SAFETY_TEXT and run.replies == [CRISIS_REPLY]
    assert run.history[1]["text"] == CRISIS_REPLY
    turns = run.rig.model_turns()
    assert turns == 1, f"модель просили ответить на кризис (запросов {turns}, ждали один: барьер)"
    assert [t for link in run.rig.connector.links for t in link.typed] == ["барьер"]  # кризисный текст в Gemini не уходил


def test_crisis_in_speech_replaces_the_model_answer() -> None:
    run = play(sc_voice, heard=["я больше не хочу жить"], replies=["ОТВЕТ-МОДЕЛИ, который человек слышать не должен."])
    sound(run)
    assert run.text == ["ready", "transcript:final", "safety", "assistant_start", "assistant_delta", "assistant_end"]
    assert run.voice == GREETING_VOICE + REPLY_VOICE
    assert run.replies == [CRISIS_REPLY]
    assert "ОТВЕТ-МОДЕЛИ" not in json.dumps([b for k, b in run.frames if k == "json"], ensure_ascii=False)
    assert run.history[0]["text"] == "я больше не хочу жить" and run.history[1]["text"] == CRISIS_REPLY
    transcript_at, safety_at = run.text.index("transcript:final"), run.text.index("safety")
    assert transcript_at < safety_at < run.text.index("assistant_start")


# ─── Перебивание и эхо ───────────────────────────────────────────────────────────────────────────────────────────


def test_barge_in_stops_the_voice_and_the_next_voice_turn_is_answered(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(APP_CONFIG.speech, "tts_frame_interval_ms", 120)  # кадры идут не мгновенно: есть что обрывать
    run = play(sc_barge_in, replies=["Я рядом, расскажи ещё.", "Слышу, продолжай."], heard=["подожди, я не договорил"])
    sound(run)
    first = run.extra["first"]
    full = 5  # кадров озвучки в первом ответе, если бы его не прервали
    assert bins_between(run.frames, first) < full, "после tts_cancel звук не остановился"
    assert has(run.frames, "tts_end", messageId=first)
    assert run.replies[0] == "Я рядом, расскажи ещё." and run.replies[-1] == "Слышу, продолжай."
    assert run.bodies("transcript")[0]["text"] == "подожди, я не договорил"
    assert run.roles()[:4] == ["user", "assistant", "user", "assistant"]


def test_echo_of_the_agent_is_not_a_reply_from_the_person() -> None:
    said = "Я слышу тебя. Расскажи, что у тебя на душе?"
    run = play(lambda r: sc_barge_in(r, echo=True), replies=[said, "Продолжай, я слушаю."], heard=["расскажи что у тебя на душе"])
    sound(run)
    assert run.bodies("transcript") == [{"v": 1, "type": "transcript", "text": "", "final": True}]
    assert "assistant_start" not in run.text[run.text.index("transcript:empty") :], "ответ на эхо"
    # в историю до барьера эхо не попало
    assert [m["text"] for m in run.history if m["role"] == "user"] == ["раз", "барьер"]
    # Эхо и кризис голосом уходят модели до расшифровки, а её ответ выбрасывается (клиент этого не видит, это только расход):
    # первая реплика, эхо и барьер.
    assert run.rig.model_turns() == 3


# ─── Выбор голоса, завершение, переподключение ────────────────────────────────────────────────────────────────────


def sc_set_voice(r: Rig) -> Run:
    dialog = r.start()
    with r.socket(dialog) as c:
        c.wait_greeting()
        c.send(type="set_voice", voice="robot")  # чужое значение игнорируется
        c.send(type="set_voice", voice="female")
        m = c.mark()
        c.say("Привет", "c-1")
        c.wait_reply(m)
        voices = {link.voice for link in r.connector.links if "Привет" in link.typed}
        run = r.done(c, dialog, voices=voices)
    r.client.post(f"/v1/users/{r.user_id}/dialogs/{dialog['dialogId']}/end", headers=AUTH)
    run.extra["next_voice"] = r.start()["voice"]
    return run


def test_set_voice_applies_to_the_next_reply_and_is_remembered() -> None:
    run = play(sc_set_voice)
    sound(run)
    assert run.extra["voices"] == {"female"}
    assert run.extra["next_voice"] == "female"
    assert run.text == ["ready", "ack", "assistant_start", "assistant_delta", "assistant_end"]
    assert run.voice == GREETING_VOICE + REPLY_VOICE
    assert run.rig.connector.open_calls[-1] == "female"  # у Gemini голос один на соединение: новая сессия


def sc_end(r: Rig) -> Run:
    dialog = r.start()
    with r.socket(dialog) as c:
        c.wait_greeting()
        m = c.mark()
        c.say("поговорим", "c-1")
        c.wait_reply(m)
        c.send(type="end", takeaway="Стало легче", tensionAfter=3)
        c.wait("ended и закрытие", lambda fs: has(fs, "ended") and fs[-1][0] == "close", m)
        item = r.client.get(f"/v1/users/{r.user_id}/dialogs/{dialog['dialogId']}", headers=AUTH).json()
        return r.done(c, dialog, barrier=False, item=item)


def test_end_gives_summary_and_closes_with_1000() -> None:
    run = play(sc_end)
    sound(run)
    assert run.text == ["ready", "ack", "assistant_start", "assistant_delta", "assistant_end", "ended", "close:1000"]
    summary = run.bodies("ended")[0]["summary"]
    assert summary["title"] == "Стало легче" and summary["tensionAfter"] == 3
    assert run.extra["item"]["endedAt"] and run.extra["item"]["summary"] == summary


def sc_reconnect(r: Rig, post_again: bool) -> Run:
    dialog = r.start()
    with r.socket(dialog) as first:
        first.wait_greeting()
        m = first.mark()
        first.say("Первая реплика", "c-1")
        first.wait_reply(m)
    if post_again:
        dialog = r.start()
        assert dialog["resumed"] is True and dialog["greeting"] == GREETING_RESUMED
    with r.socket(dialog) as c:
        c.wait_greeting() if post_again else c.wait_type("ready", 0)
        extra = {"history_on_return": r.history(dialog), "first": first.frames}
        m = c.mark()
        c.say("Вторая реплика", "c-2")
        c.wait_reply(m)
        extra["context"] = r.model_context()
        return r.done(c, dialog, **extra)


@pytest.mark.parametrize("post_again", [False, True], ids=["socket-only", "post-again"])
def test_reconnect_keeps_history_and_greets_only_on_a_new_start(post_again: bool) -> None:
    run = play(lambda r: sc_reconnect(r, post_again))
    sound(run)
    greeting_voice = GREETING_VOICE if post_again else []
    assert run.text == ["ready", "ack", "assistant_start", "assistant_delta", "assistant_end"]
    assert run.voice == greeting_voice + REPLY_VOICE
    assert [m["text"] for m in run.extra["history_on_return"]] == ["Первая реплика", REPLY]
    assert run.roles() == ["user", "assistant"] * 3  # две пары диалога и пара барьера
    # модель видит прежний разговор: и слова человека, и свой ответ
    assert "Первая реплика" in run.extra["context"] and "непросто" in run.extra["context"], run.extra["context"]
    calls = run.extra["tts_calls"]
    assert calls.count(GREETING_SENTENCES[0]) == 1 and (GREETING_RESUMED in calls) is post_again, f"озвучено {calls}"
    if not post_again:
        assert not has(run.conn.frames, "tts_start", messageId="greeting")


# ─── Очередь набранных реплик ────────────────────────────────────────────────────────────────────────────────────


def sc_two_typed(r: Rig, streaming: bool) -> Run:
    dialog = r.start()
    with r.socket(dialog) as c:
        c.wait_greeting()
        m = c.mark()
        c.say("первое", "c-1")
        if streaming:
            c.wait_type("assistant_delta", m)  # первый ответ уже пишется
        c.say("второе", "c-2")
        c.wait_reply(m, n=2, timeout=3.0)
        return r.done(c, dialog, wait=3.0)


@known_gap(
    "P3a вторая набранная реплика, пока модель ещё не начала отвечать на первую: ответ модели на вторую отбрасывается как "
    "«хвост прерванного ответа» (STALE_SECONDS=1 с больше задержки модели), и один ответ на обе приходит только через "
    "GEMINI_IDLE_TIMEOUT_SECONDS повторной просьбой к модели; спека требует очередь («Реплика во время ответа»)"
)
def test_second_typed_message_waits_in_the_queue_before_the_first_answer_starts() -> None:
    run = play(lambda r: sc_two_typed(r, False), replies=["Ответ на первое.", "Ответ на второе."], latency=0.3)
    gap(run.replies == ["Ответ на первое.", "Ответ на второе."], f"ответы на две подряд набранные реплики: {run.replies}")
    assert run.text.count("ack") == 2


@known_gap(
    "P3b набранная реплика посреди ответа обрывает его: assistant_end с недописанным текстом, в истории огрызок "
    "(_begin завершает идущий ход); спека требует дописать предыдущий ответ, а следующую реплику поставить в очередь"
)
def test_second_typed_message_waits_in_the_queue_while_the_first_answer_is_written() -> None:
    first = "Первое предложение ответа. Второе предложение ответа. Третье предложение ответа."
    run = play(lambda r: sc_two_typed(r, True), replies=[first, "Ответ на второе."], piece_delay=0.08)
    gap(run.replies == [first, "Ответ на второе."], f"ответы, когда вторая реплика пришла посреди первого: {run.replies}")


# ─── Расшифровка кусками: кризис, опоздавшая расшифровка, хвост ответа ──────────────────────────────────────────────


def split_heard_plan(first_words: int) -> Plan:
    """Gemini присылает расшифровку речи кусками, и второй кусок приходит уже после начала ответа."""

    def plan(link: ScriptedLink, heard: str | None, reply: str) -> list[LiveEvent | float]:
        if not heard:
            return link.default_plan(heard, reply)
        words = heard.split(" ")
        head, rest = " ".join(words[:first_words]), " " + " ".join(words[first_words:])
        events: list[LiveEvent | float] = [LiveEvent("input_text", text=head)]
        events += [LiveEvent("output_text", text=piece) for piece in re_split(reply)]
        events += [LiveEvent("audio", data=FAKE_PCM), LiveEvent("input_text", text=rest), LiveEvent("audio", data=FAKE_PCM)]
        events += [LiveEvent("generation_complete")]
        return events

    return plan


@known_gap(
    "P4 расшифровка речи пришла кусками, второй после начала ответа: transcript и история получают обрезанную реплику, "
    "ответ модели на кризис показан и озвучен до safety (premise: Gemini не гарантирует порядок input_transcription и ответа)"
)
def test_crisis_in_the_second_chunk_of_the_transcription() -> None:
    said = "я думаю что не хочу жить"
    run = play(lambda r: sc_voice(r, wait=2.0), heard=[said], replies=["ОТВЕТ-МОДЕЛИ про что-то другое."], plan=split_heard_plan(2))
    transcript = run.bodies("transcript")
    gap(bool(transcript) and transcript[0]["text"] == said, f"показана и сохранена реплика {transcript[0]['text'] if transcript else None!r}, а не {said!r}")
    gap("assistant_start" not in run.text[: run.text.index("safety")] if "safety" in run.text else False, "ответ модели показан раньше safety или safety нет")
    gap("ОТВЕТ-МОДЕЛИ" not in json.dumps([b for k, b in run.frames if k == "json"], ensure_ascii=False), "ответ модели на кризис попал к человеку")


def late_transcript_plan(delay: float) -> Plan:
    def plan(link: ScriptedLink, heard: str | None, reply: str) -> list[LiveEvent | float]:
        if not heard:
            return link.default_plan(heard, reply)
        events: list[LiveEvent | float] = [LiveEvent("output_text", text=piece) for piece in re_split(reply)]
        events += [LiveEvent("audio", data=FAKE_PCM), delay, LiveEvent("input_text", text=heard), LiveEvent("generation_complete")]
        return events

    return plan


@known_gap(
    "P12 расшифровка пришла позже GEMINI_TRANSCRIPT_WAIT_MS после первого звука ответа: слова человека и ответ молча теряются "
    "(premise: у настоящего Gemini расшифровка опаздывает больше чем на секунду)"
)
def test_a_late_transcription_does_not_lose_the_turn(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(APP_CONFIG.gemini, "transcript_wait_ms", 100)
    run = play(lambda r: sc_voice(r, wait=2.0), plan=late_transcript_plan(0.5))
    gap("transcript:final" in run.text, f"не показаны слова человека: {run.text}")
    gap(run.text == ["ready", "transcript:final", *ANSWER_TEXT], f"кадры при опоздавшей расшифровке: {run.text}")


def tail_after_complete_plan(link: ScriptedLink, heard: str | None, reply: str) -> list[LiveEvent | float]:
    pieces = re_split(reply)
    events: list[LiveEvent | float] = [LiveEvent("input_text", text=heard)] if heard else []
    events += [LiveEvent("output_text", text=piece) for piece in pieces[:-1]]
    events += [LiveEvent("audio", data=FAKE_PCM), LiveEvent("audio", data=FAKE_PCM), LiveEvent("generation_complete")]
    events += [0.05, LiveEvent("output_text", text=pieces[-1])]
    return events


@known_gap(
    "P13 хвост расшифровки ответа после generation_complete теряется: текст короче звука, в истории обрезанный ответ "
    "(premise: у настоящего Gemini последний кусок output_transcription может прийти после generation_complete)"
)
def test_the_tail_of_the_reply_text_after_generation_complete_is_kept() -> None:
    run = play(sc_text, plan=tail_after_complete_plan)
    gap(run.replies == [REPLY], f"текст ответа: {run.replies}")


# ─── Долгая реплика ──────────────────────────────────────────────────────────────────────────────────────────────


def sc_long_speech(r: Rig, pause: float) -> Run:
    dialog = r.start()
    with r.socket(dialog) as c:
        c.wait_greeting()
        m = c.mark()
        c.send(type="audio_start")
        for n in range(3):
            c.ws.send_bytes(audio_in_frame(n, loud=True))
        time.sleep(pause)  # человек продолжает говорить, модель молчит
        for n in range(3, 6):
            c.ws.send_bytes(audio_in_frame(n, loud=True))
        c.send(type="audio_end")
        c.wait_type("transcript", m, timeout=2.5)
        c.wait("ответ", lambda fs: reply_done(fs, r.voiced), m, 2.5)
        return r.done(c, dialog, wait=2.5)


# P5 закрыт: таймер молчания модели не идёт, пока человек ещё говорит (ходом считается время после audio_end).
def test_a_long_utterance_survives_the_idle_timeout_of_a_silent_model(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(APP_CONFIG.gemini, "idle_timeout_seconds", 1)  # в бою 15 с
    run = play(lambda r: sc_long_speech(r, 1.6))
    sound(run)
    assert run.text == ["ready", "transcript:final", *ANSWER_TEXT]


def sc_limit(r: Rig) -> Run:
    dialog = r.start()
    with r.socket(dialog) as c:
        c.wait_greeting()
        before = metric("agent_voice_turns_truncated_total")
        m = c.mark()
        c.speak(frames=3010)  # на десять кадров больше пяти минут
        c.wait_reply(m)
        return r.done(c, dialog, bytes=r.audio_bytes_to_model(), truncated=metric("agent_voice_turns_truncated_total") - before)


def test_five_minute_limit() -> None:
    run = play(sc_limit)
    sound(run)
    assert run.extra["bytes"] == MAX_AUDIO_BYTES and run.extra["truncated"] == 1
    assert run.text == ["ready", "transcript:final", *ANSWER_TEXT]


# ─── Модель молчит: без шаблона ──────────────────────────────────────────────────────────────────────────────────


def sc_answer_or_error(r: Rig, typed: bool) -> Run:
    """Реплика, на которую модель промолчит: ждём либо ответ (со второй попытки), либо error."""
    dialog = r.start()
    with r.socket(dialog) as c:
        c.wait_greeting()
        m = c.mark()
        if typed:
            c.say("Мне сегодня тревожно", "c-1")
        else:
            c.speak(4)
        c.wait("ответ или error", lambda fs: has(fs, "error") or reply_done(fs, r.voiced), m)
        return r.done(c, dialog)


@pytest.mark.parametrize("typed", [True, False], ids=["typed", "voice"])
def test_an_empty_model_answer_is_not_covered_with_a_template(typed: bool, monkeypatch: pytest.MonkeyPatch) -> None:
    """Модель промолчала (пустой ответ): агент просит её ответить ещё раз в свежей сессии (голосовой реплике — после паузы
    GEMINI_SILENCE_NUDGE_MS) и отвечает со второй попытки. Шаблона, не знающего сказанного, нет: в ответе только слова модели."""
    monkeypatch.setattr(APP_CONFIG.gemini, "silence_nudge_ms", 50)
    run = play(lambda r: sc_answer_or_error(r, typed), replies=["", REPLY])
    sound(run)
    assert run.errors == [] and run.replies == [REPLY]
    assert run.roles()[:2] == ["user", "assistant"] and run.history[1]["text"] == REPLY


# ─── Отказ бэкенда ───────────────────────────────────────────────────────────────────────────────────────────────


def sc_text_down(r: Rig) -> Run:
    """Набранная реплика при лежащем бэкенде: ждём error; барьер не нужен — отвечать нечем."""
    dialog = r.start()
    with r.socket(dialog) as c:
        c.wait_greeting()
        m = c.mark()
        c.say("Мне сегодня тревожно", "c-1")
        c.wait("error", lambda fs: has(fs, "error"), m)
        time.sleep(0.3)  # после error ничего больше прийти не должно
        c.pump(lambda fs: False, m, 0.2)
        return r.done(c, dialog, barrier=False)


def test_model_down_typed_message_gets_one_error_and_no_template() -> None:
    run = play(sc_text_down, connector_fail=True)
    sound(run)
    # Gemini один на весь голосовой путь: его отказ — это один error VOICE_UNAVAILABLE, своего кода у чата нет
    assert run.text == ["ready", "ack", "error:VOICE_UNAVAILABLE"], run.text
    assert run.replies == [] and run.roles() == ["user"]


def sc_voice_down(r: Rig, turns: int) -> Run:
    dialog = r.start()
    with r.socket(dialog) as c:
        c.wait_greeting()
        for n in range(1, turns + 1):
            c.speak(4)
            c.wait(f"error за реплику {n}", lambda fs, n=n: types_count(fs, "error") >= n, 0, 1.5)
        return r.done(c, dialog)


def test_voice_turn_with_the_model_down_reports_one_error_and_nothing_else() -> None:
    run = play(lambda r: sc_voice_down(r, 1), connector_fail=True)
    # Барьер — набранная реплика: Gemini лежит целиком, и ответить на неё нечем (шаблона нет).
    sound(run, alive=False)
    assert run.text[:2] == ["ready", "error:VOICE_UNAVAILABLE"] and "assistant_start" not in run.text
    assert "transcript:final" not in run.text and run.history[0]["text"] == "барьер"


@known_gap(
    "P6 второй отказ Gemini подряд молчит: ни error, ни транскрипта (флаг _unavailable_sent на всё соединение), "
    "а клиент ждёт ответ 20 с"
)
def test_every_failed_voice_turn_is_reported() -> None:
    run = play(lambda r: sc_voice_down(r, 2), connector_fail=True)
    gap(run.errors == ["VOICE_UNAVAILABLE"] * 2, f"об отказах сообщено: {run.errors} (кадры: {run.conn.dump()})")


@known_gap(
    "P14 при полностью недоступном Gemini приходят два error VOICE_UNAVAILABLE подряд (флаги _unavailable_sent в live и "
    "_voice_error_sent в базовой сессии независимы: отказ озвучки приветствия и отказ сессии): клиент дважды гасит микрофон "
    "и показывает уведомление"
)
def test_model_down_with_the_real_live_voice_reports_one_error() -> None:
    """Gemini лёг целиком, голос тоже Gemini (GeminiLiveTts): отказывают и озвучка, и разговор. Ответов нет (шаблона нет),
    а клиент должен получить об отказе один error VOICE_UNAVAILABLE."""
    run = play(sc_text_down, connector_fail=True, real_tts=True, voiced=False)
    sound(run)
    assert run.replies == []
    gap(run.errors.count("VOICE_UNAVAILABLE") == 1, f"с настоящей озвучкой пришло {run.errors}")


def plan_dies_mid_reply(link: ScriptedLink, heard: str | None, reply: str) -> list[LiveEvent | float]:
    first = re_split(reply)[:3]  # «Понимаю, это непросто.»: первое предложение и обрыв
    return [LiveEvent("output_text", text=p) for p in first] + [LiveEvent("closed", text="соединение закрыто Google")]


def test_a_connection_dying_mid_reply_keeps_what_was_said() -> None:
    run = play(sc_text, plan=plan_dies_mid_reply, voiced=False)  # звук не успел начаться
    sound(run)
    assert run.replies and run.replies[0].startswith("Понимаю") and "assistant_start" in run.text
    # единственный бэкенд оборвался: клиент вправе узнать об этом одним error
    assert set(run.errors) <= {"VOICE_UNAVAILABLE"} and len(run.errors) <= 1, run.errors
    assert len(run.rig.connector.links) == 2, "следующая реплика (барьер) должна открыть соединение заново"
    assert [m["text"] for m in run.history if m["role"] == "assistant"][0] == run.replies[0]  # в истории то, что показано
    assert len(run.replies) == 1  # шаблон поверх начатого ответа не добавляется


# ─── Отказ озвучки ───────────────────────────────────────────────────────────────────────────────────────────────


def test_failing_tts_leaves_the_text_and_reports_one_error() -> None:
    run = play(sc_voice, tts="fail")
    sound(run)
    assert run.errors == ["VOICE_UNAVAILABLE"]  # приветствие не озвучилось
    assert run.replies == [REPLY]
    assert run.text == ["ready", "error:VOICE_UNAVAILABLE", "transcript:final", *ANSWER_TEXT], run.text
    # ответы звучат голосом Gemini, TTS_MODE им не нужен
    assert any(t.startswith("tts_start(#") for t in run.voice)


def test_a_reply_without_sound_is_reported_like_a_failed_voice() -> None:
    """P10 (закрыт): Gemini прислал текст ответа без звука. Агент пробует озвучить его сам; озвучки нет, и клиент получает
    error VOICE_UNAVAILABLE, а не молча остаётся с текстом."""
    run = play(sc_voice, audio=False, tts=SelectiveTts, voiced=False)
    sound(run)
    assert run.replies == [REPLY]
    assert "tts_start(#1)" not in run.voice
    assert run.errors == ["VOICE_UNAVAILABLE"], f"не сообщено о том, что ответ не озвучен: {run.errors}"


# ─── Что знает модель после кризиса ──────────────────────────────────────────────────────────────────────────────


def sc_crisis_then_followup(r: Rig, voice: bool) -> Run:
    dialog = r.start()
    with r.socket(dialog) as c:
        c.wait_greeting()
        m = c.mark()
        if voice:
            c.speak(4)
        else:
            c.say("я больше не хочу жить", "c-1")
        c.wait_reply(m)
        m = c.mark()
        if voice:
            c.speak(4)
        else:
            c.say("не знаю, мне просто плохо", "c-2")
        c.wait_reply(m)
        context = r.model_context()
        return r.done(c, dialog, barrier=False, context=context)


# P7 закрыт: после кризиса сессия открывается заново (GEMINI_TEXT_CONTEXT), и история в ней содержит кризисную реплику и ответ агента.
def test_the_model_knows_about_a_typed_crisis_in_the_next_answer() -> None:
    run = play(lambda r: sc_crisis_then_followup(r, voice=False), replies=["Я рядом. Расскажи, что случилось."])
    sound(run, closed_ends=True)
    assert "не хочу жить" in run.extra["context"], "модель не видела кризисной реплики человека"
    assert "Я слышу, что тебе очень тяжело" in run.extra["context"], "модель не знает, что агент ответил кризисным текстом"


# P8 закрыт: новая сессия не помнит выброшенного ответа модели, в её истории то, что человек услышал на самом деле.
def test_the_model_knows_what_the_agent_said_after_a_voice_crisis() -> None:
    run = play(
        lambda r: sc_crisis_then_followup(r, voice=True),
        heard=["я больше не хочу жить", "не знаю, мне просто плохо"],
        replies=["МОЙ-ВЫБРОШЕННЫЙ-ОТВЕТ.", "Я рядом."],
    )
    sound(run, closed_ends=True)
    context = run.extra["context"]
    assert "не хочу жить" in context  # слова человека модель слышала сама
    assert "Я слышу, что тебе очень тяжело" in context, "в контексте модели нет кризисного ответа агента"
    assert "МОЙ-ВЫБРОШЕННЫЙ-ОТВЕТ" not in context, "в контексте модели лежит ответ, которого человек не слышал"


# ─── Разбиение расшифровки ответа на куски ────────────────────────────────────────────────────────────────────────


def chunked_plan(chunker: Callable[[str], list[str]]) -> Plan:
    def plan(link: ScriptedLink, heard: str | None, reply: str) -> list[LiveEvent | float]:
        events: list[LiveEvent | float] = [LiveEvent("input_text", text=heard)] if heard else []
        events += [LiveEvent("output_text", text=piece) for piece in chunker(reply)]
        events += [LiveEvent("audio", data=FAKE_PCM), LiveEvent("generation_complete")]
        return events

    return plan


def _space_then_word(text: str) -> list[str]:
    return [(" " if n else "") + word for n, word in enumerate(text.split(" "))]


def _spaces_alone(text: str) -> list[str]:
    return [piece for word in text.split(" ") for piece in (word, " ")][:-1]


def _newline_chunk(text: str) -> list[str]:
    first, *rest = text.split(" ")
    return [first, "\n", *_space_then_word(" ".join(rest))]


CHUNKINGS: dict[str, Callable[[str], list[str]]] = {
    "word-then-space": re_split,
    "space-then-word": _space_then_word,
    "per-char": list,
    "spaces-alone": _spaces_alone,
    "newline-chunk": _newline_chunk,
}


@pytest.mark.parametrize("chunking", list(CHUNKINGS))
def test_deltas_add_up_to_the_final_text_whatever_the_chunking(chunking: str) -> None:
    """Gemini режет расшифровку как угодно: сумма дельт всё равно равна assistant_end.text, пробелы не теряются и не двоятся."""
    run = play(sc_text, plan=chunked_plan(CHUNKINGS[chunking]))
    sound(run)
    # перенос строки внутри куска сохраняется как есть (клиенту это один абзац текста), остальное совпадает дословно
    expected = REPLY.replace("Понимаю, ", "Понимаю,\n", 1) if chunking == "newline-chunk" else REPLY
    assert run.replies == [expected], f"{chunking}: {run.replies!r}"
    assert run.history[1]["text"] == expected  # в истории ровно то, что показано
    assert run.text == ["ready", "ack", *ANSWER_TEXT]


# ─── Обрыв реплики, завершение посреди ответа, голос при старте ───────────────────────────────────────────────────


def sc_dropped_turn(r: Rig) -> Run:
    dialog = r.start()
    with r.socket(dialog) as first:
        first.wait_greeting()
        first.send(type="audio_start")
        for n in range(5):
            first.ws.send_bytes(audio_in_frame(n, loud=True))
        # экран закрыт: сокет рвётся без audio_end
    after_drop = r.history(dialog)
    deadline = time.monotonic() + 2
    while not all(link.closed for link in r.connector.links) and time.monotonic() < deadline:
        time.sleep(0.02)
    leaked = [link for link in r.connector.links if not link.closed]
    with r.socket(dialog) as c:
        c.wait_type("ready", 0)
        m = c.mark()
        c.say("я тут", "c-1")
        c.wait_reply(m)
        return r.done(c, dialog, after_drop=after_drop, leaked=len(leaked))


def test_a_voice_turn_without_audio_end_is_dropped_and_leaves_nothing_open() -> None:
    run = play(sc_dropped_turn)
    sound(run)
    assert run.extra["after_drop"] == [], "недоговорённая реплика попала в историю"
    assert run.roles()[:2] == ["user", "assistant"] and run.history[0]["text"] == "я тут"
    assert run.extra["leaked"] == 0, "после обрыва остались открытые соединения Gemini"
    assert run.text == ["ready", "ack", *ANSWER_TEXT]


def sc_drop_midreply(r: Rig) -> Run:
    dialog = r.start()
    with r.socket(dialog) as first:
        first.wait_greeting()
        m = first.mark()
        first.say("Мне тревожно", "c-1")
        first.wait_type("assistant_delta", m)
        # сокет рвётся посреди ответа
    after_drop = r.history(dialog)
    with r.socket(dialog) as c:
        c.wait_type("ready", 0)
        m = c.mark()
        c.say("я тут", "c-2")
        c.wait_reply(m)
        return r.done(c, dialog, after_drop=after_drop)


def test_a_socket_dropped_mid_reply_leaves_the_shown_part_in_the_history() -> None:
    """specs/agent-api «Обрыв посреди ответа»: клиент перечитывает историю и находит там то, что успело показаться."""
    full = "Первое предложение ответа. Второе предложение ответа. Третье предложение ответа."
    run = play(sc_drop_midreply, replies=[full, "Я рядом."], piece_delay=0.08)
    sound(run)
    dropped = run.extra["after_drop"]
    assert [m["role"] for m in dropped] == ["user", "assistant"], dropped
    assert dropped[1]["text"] and full.startswith(dropped[1]["text"]), f"{dropped[1]['text']!r}"
    assert run.replies == ["Я рядом."]  # после обрыва агент ничего не досылает на новый сокет
    assert run.text == ["ready", "ack", *ANSWER_TEXT]


def sc_end_midreply(r: Rig) -> Run:
    dialog = r.start()
    with r.socket(dialog) as c:
        c.wait_greeting()
        m = c.mark()
        c.say("поговорим", "c-1")
        c.send(type="end")
        c.wait("ended и закрытие", lambda fs: has(fs, "ended") and fs[-1][0] == "close", m)
        return r.done(c, dialog, barrier=False)


def test_end_during_a_reply_closes_cleanly() -> None:
    run = play(sc_end_midreply)
    sound(run, closed_ends=False)
    assert run.text[-2:] == ["ended", "close:1000"] and run.text.count("ended") == 1


def sc_voice_at_start(r: Rig) -> Run:
    dialog = r.start(voice="female")
    assert dialog["voice"] == "female"
    with r.socket(dialog) as c:
        c.wait_greeting()
        m = c.mark()
        c.say("Привет", "c-1")
        c.wait_reply(m)
        voices = set(r.tts.voices) | {link.voice for link in r.connector.links}
        return r.done(c, dialog, voices=voices)


def test_voice_chosen_at_start_is_used_for_the_greeting_and_the_reply() -> None:
    run = play(sc_voice_at_start)
    sound(run)
    assert run.extra["voices"] == {"female"}
    assert run.voice == GREETING_VOICE + REPLY_VOICE


# ─── Тишина перед речью, второй сокет, молчащая модель, ответ без текста ───────────────────────────────────────────


def sc_leading_silence(r: Rig) -> Run:
    dialog = r.start()
    with r.socket(dialog) as c:
        c.wait_greeting()
        m = c.mark()
        c.send(type="audio_start")
        for n in range(8):  # секунда тишины до речи
            c.ws.send_bytes(audio_in_frame(n, loud=False))
        for n in range(8, 12):
            c.ws.send_bytes(audio_in_frame(n, loud=True))
        for n in range(12, 15):
            c.ws.send_bytes(audio_in_frame(n, loud=False))
        c.send(type="audio_end")
        c.wait_type("transcript", m)
        c.wait_reply(m)
        return r.done(c, dialog, audio=r.audio_bytes_to_model())


def test_silence_before_speech_does_not_change_what_the_person_sees() -> None:
    run = play(sc_leading_silence)
    sound(run)
    assert run.text == ["ready", "transcript:final", *ANSWER_TEXT]
    assert run.bodies("transcript")[0]["text"] == "мне сегодня тяжело"
    frame = 3200
    # тишину перед речью Gemini не получает, кроме запаса в 500 мс; хвост после речи уходит как есть
    assert run.extra["audio"] == (PRE_ROLL_FRAMES + 4 + 3) * frame


def sc_second_socket(r: Rig) -> Run:
    dialog = r.start()
    with r.socket(dialog) as c:
        c.wait_greeting()
        opened = len(r.connector.open_calls)
        status = None
        try:
            with r.client.websocket_connect(ws_url(r.user_id, dialog["dialogId"]), headers=AUTH):
                pass
        except WebSocketDenialResponse as denied:
            status = denied.status_code
        m = c.mark()
        c.say("я тут", "c-1")
        c.wait_reply(m)
        return r.done(c, dialog, status=status, opened=len(r.connector.open_calls) - opened)


def test_a_second_socket_is_refused_and_the_first_keeps_working() -> None:
    run = play(sc_second_socket)
    sound(run)
    assert run.extra["status"] == 409
    assert run.extra["opened"] == 0  # отказ не трогает Gemini: ни нового соединения, ни закрытия живого
    assert run.text == ["ready", "ack", *ANSWER_TEXT]


def hang_plan(link: ScriptedLink, heard: str | None, reply: str) -> list[LiveEvent | float]:
    return []  # модель молчит: ни расшифровки, ни ответа, ни generation_complete


def test_a_hung_model_gets_one_error_for_a_typed_message(monkeypatch: pytest.MonkeyPatch) -> None:
    """Модель зависла (ни одного события): по GEMINI_IDLE_TIMEOUT_SECONDS агент просит модель ответить ещё раз в свежей
    сессии, та тоже висит — один error. Шаблона нет."""
    monkeypatch.setattr(APP_CONFIG.gemini, "idle_timeout_seconds", 1)  # в бою 15 с
    run = play(sc_text_down, plan=hang_plan)
    sound(run)
    assert run.text == ["ready", "ack", "error:VOICE_UNAVAILABLE"], run.text
    assert len(run.rig.connector.links) == 2  # повторная просьба ушла в свежую сессию
    assert run.replies == []


def test_a_hung_model_does_not_leave_a_voice_turn_unreported(monkeypatch: pytest.MonkeyPatch) -> None:
    """P15 закрыт: модель промолчала после голосовой реплики (ни расшифровки, ни ответа). Раньше через
    GEMINI_IDLE_TIMEOUT_SECONDS приходил пустой transcript и больше ничего; теперь зависание — отказ: error VOICE_UNAVAILABLE.
    Шаблона нет."""
    monkeypatch.setattr(APP_CONFIG.gemini, "idle_timeout_seconds", 1)

    def voice_down(r: Rig) -> Run:
        dialog = r.start()
        with r.socket(dialog) as c:
            c.wait_greeting()
            m = c.mark()
            c.speak(4)
            c.wait("error", lambda fs: has(fs, "error"), m)
            return r.done(c, dialog, barrier=False)

    run = play(voice_down, plan=hang_plan)
    assert run.errors == ["VOICE_UNAVAILABLE"], run.text
    assert run.replies == []


def audio_only_plan(link: ScriptedLink, heard: str | None, reply: str) -> list[LiveEvent | float]:
    events: list[LiveEvent | float] = [LiveEvent("input_text", text=heard)] if heard else []
    return [*events, LiveEvent("audio", data=FAKE_PCM), LiveEvent("audio", data=FAKE_PCM), LiveEvent("generation_complete")]


def sc_text_wait(r: Rig, wait: float) -> Run:
    dialog = r.start()
    with r.socket(dialog) as c:
        c.wait_greeting()
        m = c.mark()
        c.say("Мне сегодня тревожно", "c-1")
        c.wait_reply(m, timeout=wait)
        return r.done(c, dialog, wait=wait)


@known_gap(
    "P16 Gemini прислал звук без расшифровки ответа: assistant_start уходит с первым звуком, а assistant_end не придёт "
    "никогда (нет текста), клиент остаётся в состоянии streaming, ответа нет в истории (premise: у настоящего Gemini "
    "расшифровка ответа бывает пустой)"
)
def test_a_reply_with_sound_but_no_transcription_is_closed() -> None:
    run = play(lambda r: sc_text_wait(r, 2.0), plan=audio_only_plan)
    problems = contract(run.conn.frames)
    gap(not problems, f"контракт нарушен: {problems}; кадры: {run.conn.dump()}")


def test_a_crisis_transcription_that_arrives_a_moment_after_the_first_sound_is_still_caught() -> None:
    """Расшифровка приходит позже первого звука ответа, но в пределах GEMINI_TRANSCRIPT_WAIT_MS: ответ ждёт, кризис ловится."""
    said = "я больше не хочу жить"
    run = play(sc_voice, heard=[said], replies=["ОТВЕТ-МОДЕЛИ, который человек слышать не должен."], plan=late_transcript_plan(0.3))
    sound(run)
    assert run.text == ["ready", "transcript:final", "safety", *ANSWER_TEXT]
    assert run.replies == [CRISIS_REPLY] and run.bodies("transcript")[0]["text"] == said
    assert "ОТВЕТ-МОДЕЛИ" not in json.dumps([b for k, b in run.frames if k == "json"], ensure_ascii=False)


# ─── Настоящая обвязка live: приветствие и кризис через GeminiLiveTts + CachedTts ─────────────────────────────────


def wait_warm(r: Rig, items: int = 12) -> None:
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline and len(r.client.app.state.tts._items) < items:
        time.sleep(0.02)


def sc_real_wiring(r: Rig) -> Run:
    wait_warm(r)
    opened = len(r.connector.open_calls)
    dialog = r.start()
    with r.socket(dialog) as c:
        c.wait_greeting()
        m = c.mark()
        c.say("я больше не хочу жить", "c-1")
        c.wait_reply(m)
        return r.done(c, dialog, opened=len(r.connector.open_calls) - opened)


def test_greeting_and_crisis_reply_through_the_real_live_voice_are_served_from_the_cache() -> None:
    run = play(sc_real_wiring, real_tts=True)
    sound(run)
    assert run.text == ["ready", "ack", "safety", *ANSWER_TEXT]
    assert run.voice == GREETING_VOICE + REPLY_VOICE
    # на диалог открыто ровно одно новое соединение Gemini (для самих реплик): фразы взяты из прогретой памяти
    assert run.extra["opened"] == 1, f"приветствие или кризисный ответ открыли лишние соединения Gemini: {run.extra['opened']}"
