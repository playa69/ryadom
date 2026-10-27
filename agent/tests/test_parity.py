"""Паритет каскада и gemini_live: одни и те же сценарии, то, что видит клиент.

Каждый сценарий прогоняется дважды через WebSocket TestClient: против каскада (FakeChat + FakeRecognizer + FakeTts, как в
tests/conftest.py) и против gemini_live (FakeConnector/FakeLink из tests/test_live.py). Сравниваются не тексты, а то, что
клиент способен заметить: последовательность типов JSON-кадров, наличие и границы озвучки (кадры 0x02), обязательные поля,
склейка assistant_delta против assistant_end.text, история диалога, то, что увидела модель, и ошибки в журнале агента.

Тесты не заменяют проверку на живой модели: поведение Gemini моделируется подделкой, и там, где результат зависит от
порядка событий настоящего Gemini (расшифровка речи идёт отдельным потоком), это сказано в причине xfail.

ТАБЛИЦА ДОПУСТИМЫХ РАЗЛИЧИЙ (не считаются деградацией и тестами не проверяются)

  1. Скорость ответа: live быстрее (нет STT, чата и синтеза по очереди).
  2. Тембр голоса, формулировки ответов, нарезка assistant_delta, число и размер кадров 0x02 внутри одной озвучки
     (Gemini отдаёт звук своими кусками; клиент видит те же 200-мс кадры, это держит общий _speak).
  3. Транскрипт голоса (final) в live приходит вместе с началом ответа, а не отдельно до него: порядок
     «transcript раньше assistant_start» сохранён. Кадров transcript с final=false нет ни у каскада, ни у live.
  4. Тишину перед речью live не пересылает модели (кроме запаса в 500 мс), whisper получает запись целиком.
  5. Эхо и кризис голосом live всё равно отдаёт модели (речь уходит до расшифровки), а её ответ выбрасывает: клиент этого
     не видит (расход, не поведение). Каскад в этих случаях чат не вызывает. Тишину не отдаёт ни тот, ни другой.
  6. Ответы live озвучивает сам Gemini, а не TTS_MODE: при отказе TTS ответы в live всё равно звучат, а приветствие и
     кризисный ответ идут через TTS (GeminiLiveTts) так же, как в каскаде.
  7. Gemini один вместо трёх бэкендов: отказ Gemini — это и отказ чата, и отказ голоса, поэтому там, где каскад шлёт
     `error AGENT_LLM_UNAVAILABLE`, live шлёт один `error VOICE_UNAVAILABLE` (клиент гасит микрофон и пишет «Голос сейчас
     недоступен»). Шаблона нет ни там, ни там.
  8. Расход: после обрыва Gemini посреди хода live открывает соединение заново на следующей реплике.
  9. Модель промолчала (пустой ответ) или соединение оборвалось, а слова человека известны: live просит модель ответить ещё
     раз в свежей сессии (голосовой реплике — после паузы GEMINI_SILENCE_NUDGE_MS) и отвечает со второй попытки; каскад
     сообщает `error AGENT_LLM_UNAVAILABLE`. Шаблона нет ни там, ни там.

ИЗВЕСТНЫЕ РАСХОЖДЕНИЯ (xfail(strict=True), причина начинается с «PARITY:»): каждое — настоящая деградация live
относительно каскада; когда расхождение исправят, strict-xfail упадёт (XPASS) и напомнит снять отметку.

  P1   оборванная на полуслове реплика не удерживается (INCOMPLETE_HOLD_MS игнорируется)
  P2   продолжение оборванной реплики получает отдельный ответ, а не один на обе части
  P3a  вторая набранная реплика, пока модель ещё не начала отвечать: ответ на вторую отброшен как «хвост» (окно
       STALE_SECONDS длиннее задержки модели)
  P3b  набранная реплика посреди ответа обрывает его (у каскада реплика ждёт в очереди)
  P4   расшифровка речи кусками, второй после начала ответа: транскрипт и история обрезаны, safety позже ответа модели
  P5   закрыт: реплика длиннее GEMINI_IDLE_TIMEOUT_SECONDS при молчащей модели (таймер молчания идёт после audio_end)
  P6   второй отказ Gemini подряд не сообщается клиенту ни error, ни транскриптом
  P7, P8 закрыты сменой сессии после кризиса (GEMINI_TEXT_CONTEXT): новая сессия получает историю с кризисным ответом агента
  P9   ограничение длины ответа (MAX_REPLY_CHARS) не действует
  P10  закрыт: ответ без звука от Gemini агент озвучивает сам (тем же голосом), а если озвучки нет, клиент получает error
       VOICE_UNAVAILABLE, как у каскада
  P11  dev-переключатель озвучки (/dev/tts none) не выключает звук ответов
  P12  расшифровка позже GEMINI_TRANSCRIPT_WAIT_MS: слова человека и ответ теряются молча
  P13  хвост расшифровки ответа после generation_complete теряется (текст короче звука)
  P14  при лежащем Gemini и настоящей обвязке (GeminiLiveTts) приходят два error VOICE_UNAVAILABLE вместо одного
  P15  закрыт: зависшая модель — отказ: на голосовую реплику без расшифровки приходит error VOICE_UNAVAILABLE
  P16  звук ответа без расшифровки: assistant_start есть, assistant_end не придёт никогда
"""

import asyncio
import json
import logging
import re
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

from app.api.dialog_live import PRE_ROLL_FRAMES
from app.api.dialog_ws import MAX_AUDIO_BYTES, MAX_REPLY_CHARS
from app.clients.gemini_live import VERBATIM_INSTRUCTIONS, LiveError, LiveEvent, LiveHistory
from app.clients.llm import ModelError
from app.core.config import APP_CONFIG
from app.main import create_app
from app.services.dialog_store import GREETING_NEW, GREETING_RESUMED
from app.services.replies import CRISIS_REPLY, CRISIS_SAFETY_TEXT, REPLIES, split_sentences
from tests.conftest import (
    AUTH,
    FAKE_PCM,
    FakeChat,
    FakeRecognizer,
    FakeTts,
    Frame,
    audio_in_frame,
    has,
    make_client,
    ws_url,
)
from tests.test_live import FakeConnector, FakeLink, re_split

WAIT = 6.0  # сколько ждать кадр, который должен прийти; дольше — зависание
HOLD_SECONDS = 0.4  # INCOMPLETE_HOLD_MS в conftest
BARRIER = "__barrier__"
REPLY = "Понимаю, это непросто. Что сейчас тревожит больше всего?"
GREETING_SENTENCES = (*split_sentences(GREETING_NEW), *split_sentences(GREETING_RESUMED))


class ParityGap(AssertionError):
    """Деградация live относительно каскада. Только такие падения засчитываются как xfail известных расхождений."""


def gap(ok: bool, what: str) -> None:
    if not ok:
        raise ParityGap(what)


def same(cascade: Any, live: Any, what: str) -> None:
    gap(cascade == live, f"{what}: каскад={cascade!r}, live={live!r}")


def known_gap(reason: str):  # noqa: ANN201
    return pytest.mark.xfail(raises=ParityGap, strict=True, reason="PARITY: " + reason)


@pytest.fixture(autouse=True)
def pinned_settings(monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture) -> Iterator[None]:
    """Настройки live не зависят от .env разработчика; после каждого сценария в журнале агента нет ошибок (падений задач)."""
    gemini = APP_CONFIG.gemini
    for name, value in (
        ("idle_timeout_seconds", 15),
        ("transcript_wait_ms", 1000),
        ("history_messages", 12),
        ("session_resumption", True),
        ("text_context", True),  # по умолчанию: прошлые реплики уходят в новую сессию отдельно от промпта
    ):
        monkeypatch.setattr(gemini, name, value)
    yield
    errors = [r for r in caplog.records if r.levelno >= logging.ERROR]
    assert not errors, "ошибки в журнале агента: " + "; ".join(f"{r.name}: {r.getMessage()[:160]}" for r in errors)


# ─── Подделки: один сценарий текста для обоих конвейеров ─────────────────────────────────────────────────────────


@dataclass
class Script:
    """Что «слышит» распознавание (каскад) / расшифровка Gemini (live) и что отвечает модель, по очереди."""

    heard: list[str] = field(default_factory=lambda: ["мне сегодня тяжело"])
    replies: list[str] = field(default_factory=lambda: [REPLY])

    @staticmethod
    def _take(items: list[str]) -> str:
        return items.pop(0) if len(items) > 1 else (items[0] if items else "")

    def next_heard(self) -> str:
        return self._take(self.heard)

    def next_reply(self) -> str:
        return self._take(self.replies)


class ScriptedChat(FakeChat):
    def __init__(
        self, script: Script, fail: bool = False, delay: float = 0.0, piece_delay: float = 0.0, dies_after: int | None = None
    ) -> None:
        super().__init__(fail=fail, delay=delay, piece_delay=piece_delay)
        self.script = script
        self.dies_after = dies_after

    async def stream(self, messages):  # noqa: ANN001, ANN201
        self.calls.append(messages)
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.fail:
            raise ModelError("модель сломана в тесте")
        for n, piece in enumerate(re.findall(r"\S+\s*", self.script.next_reply())):
            if self.dies_after is not None and n >= self.dies_after:
                raise ModelError("связь оборвалась")
            yield piece
            if self.piece_delay:
                await asyncio.sleep(self.piece_delay)


class ScriptedStt(FakeRecognizer):
    def __init__(self, script: Script, fail: bool = False) -> None:
        super().__init__(fail=fail)
        self.script = script

    async def transcribe(self, pcm: bytes) -> str:
        self.calls.append(pcm)
        if self.fail:
            raise ModelError("распознавание сломано в тесте")
        return self.script.next_heard()


Plan = Callable[["ScriptedLink", str | None, str], "list[LiveEvent | float]"]


class ScriptedLink(FakeLink):
    """FakeLink с ответами по сценарию. `plan` задаёт события хода; число в списке — пауза в секундах."""

    def __init__(
        self,
        cfg: "ScriptedConnector",
        voice: str,
        instructions: str,
        resume_handle: str | None = None,
        history: LiveHistory | None = None,
    ) -> None:
        super().__init__(voice, "", "", instructions, resume_handle, history)
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
        events += [LiveEvent("generation_complete"), LiveEvent("resumption", text=self.handle_to_issue)]
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
        self, voice: str, instructions: str, resume_handle: str | None = None, history: LiveHistory | None = None
    ) -> ScriptedLink:
        self.open_calls.append((voice, resume_handle))
        self.history_calls.append(history)
        if self.fail:
            raise LiveError("Gemini Live не открылся в тесте")
        link = ScriptedLink(self, voice, instructions, resume_handle, history)
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
        self.stamps: list[float] = []
        self.stalled: list[str] = []  # ожидания, которые не дождались
        self.cut = -1
        self.barrier_ok = True
        self.audio_end_at = 0.0

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
        self.audio_end_at = time.monotonic()

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
        self.stamps.append(time.monotonic())

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
        kind: str,
        client: TestClient,
        script: Script,
        tts: FakeTts | None,
        chat: ScriptedChat | None,
        stt: ScriptedStt | None,
        connector: ScriptedConnector | None,
        voiced: bool,
    ) -> None:
        self.kind = kind
        self.client = client
        self.script = script
        self.tts = tts
        self.chat = chat
        self.stt = stt
        self.connector = connector
        self.voiced = voiced
        # приветствие озвучивается (иначе клиент прочтёт его сам или придёт error)
        self.greets = (tts is not None and not tts.fail) or (tts is None and client.app.state.tts is not None and not (connector and connector.fail))
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
            kind=self.kind,
            rig=self,
            conn=conn,
            frames=conn.frames[:cut],
            tail=conn.frames[cut:],
            history=self.history(dialog),
            extra=extra,
        )

    # что видела модель

    def model_context(self) -> str:
        """Всё, что модель знала к моменту последнего ответа: история для чата или инструкции, прошлые реплики, загруженные в
        сессию отдельно от промпта (text_context), реплики и слова сессии Gemini."""
        if self.chat is not None:
            return "\n".join(m["content"] for m in self.chat.calls[-1])
        assert self.connector is not None
        link = self.connector.links[-1]
        loaded = [text for _, text in link.history or []]
        return "\n".join([link.instructions, *loaded, *link.typed, *link.heard_log, *link.reply_log[:-1]])

    def model_turns(self) -> int:
        """Сколько раз модель просили ответить."""
        if self.chat is not None:
            return len(self.chat.calls)
        assert self.connector is not None
        return sum(len(link.reply_log) for link in self.connector.links)

    def audio_bytes_to_model(self) -> int:
        if self.stt is not None:
            return len(self.stt.calls[0]) if self.stt.calls else 0
        assert self.connector is not None
        return sum(c[1] for link in self.connector.links for c in link.commands if c[0] == "audio")

    def model_asked_with_voice(self) -> int:
        """Сколько раз до барьера модели отдали голос человека."""
        if self.stt is not None:
            return len(self.stt.calls)
        assert self.connector is not None
        return sum(1 for link in self.connector.links for c in link.commands if c[0] == "end")


@contextmanager
def rig(
    kind: str,
    *,
    replies: list[str] | None = None,
    heard: list[str] | None = None,
    tts: Any = "ok",
    chat_fail: bool = False,
    stt_fail: bool = False,
    connector_fail: bool = False,
    audio: bool = True,
    plan: Plan | None = None,
    real_tts: bool = False,
    voiced: bool | None = None,
    latency: float = 0.0,
    piece_delay: float = 0.0,
    chat_dies_after: int | None = None,
) -> Iterator[Rig]:
    script = Script(heard=list(heard or ["мне сегодня тяжело"]), replies=list(replies if replies is not None else [REPLY]))
    makers = {"ok": FakeTts, "fail": lambda: FakeTts(fail=True), "none": lambda: None}
    tts_obj = None if real_tts else makers[tts]() if isinstance(tts, str) else tts()
    if kind == "cascade":
        chat = ScriptedChat(script, fail=chat_fail, delay=latency, piece_delay=piece_delay, dies_after=chat_dies_after)
        stt = ScriptedStt(script, fail=stt_fail)
        client, connector = make_client(tts_obj, chat=chat, recognizer=stt), None
        speaks = tts_obj is not None and not tts_obj.fail
    else:
        chat = stt = None
        connector = ScriptedConnector(script, fail=connector_fail, audio=audio, plan=plan, latency=latency, piece_delay=piece_delay)
        client = TestClient(create_app(None if real_tts else (lambda: tts_obj), lambda: (None, None), live_factory=lambda: connector))
        speaks = (audio and not connector_fail) or (tts_obj is not None and not tts_obj.fail)
    with client:
        yield Rig(kind, client, script, tts_obj, chat, stt, connector, speaks if voiced is None else voiced)


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
        # `component` — отчёт шлюзу об обращении к компоненту: каскад и речь в речь зовут разные части, и на
        # сходство кадров для клиента он не влияет (клиент его не получает, шлюз превращает в событие аналитики).
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
    kind: str
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
    """Базовая проверка прогона: ничего не зависло, контракт соблюдён, диалог жив после сценария (`alive=False` — бэкенд лежит
    и на барьер ответить нечем: проверяется только, что ничего не зависло)."""
    assert not run.conn.stalled, f"{run.kind}: не дождались {run.conn.stalled}; пришло: {run.conn.dump()}"
    assert not run.rig.hung, f"{run.kind}: сессия не закончилась после закрытия сокета (зависшая уборка задач)"
    assert contract(run.conn.frames, closed_ends) == [], f"{run.kind}: {contract(run.conn.frames, closed_ends)}\n{run.conn.dump()}"
    if alive:
        assert run.conn.barrier_ok or run.conn.cut < 0, f"{run.kind}: диалог не ответил после сценария: {run.conn.dump()}"


def one(kind: str, scenario: Callable[[Rig], Run], **cfg: Any) -> Run:
    with rig(kind, **cfg) as r:
        return scenario(r)


def both(scenario: Callable[[Rig], Run], **cfg: Any) -> tuple[Run, Run]:
    runs = []
    for kind in ("cascade", "live"):
        with rig(kind, **cfg) as r:
            runs.append(scenario(r))
    return runs[0], runs[1]


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
    cascade, live = both(lambda r: sc_greeting(r, resumed))
    sound(cascade), sound(live)
    expected = ["tts_start(greeting)", "bin", "tts_end(greeting)"]
    assert cascade.voice == expected and cascade.text == ["ready"]
    same(cascade.text, live.text, "кадры приветствия")
    same(cascade.voice, live.voice, "озвучка приветствия")
    sentences = list(split_sentences(GREETING_RESUMED if resumed else GREETING_NEW))
    assert cascade.extra["tts_calls"] == sentences
    same(cascade.extra["tts_calls"], live.extra["tts_calls"], "что озвучено")
    same(cascade.extra["greeting"], live.extra["greeting"], "приветствие в ответе POST")
    for run in (cascade, live):  # в истории только барьер: приветствие сообщением не хранится
        assert [m["text"] for m in run.history] == ["барьер", REPLY], run.kind


# ─── Набранная реплика ───────────────────────────────────────────────────────────────────────────────────────────


def test_typed_message() -> None:
    cascade, live = both(sc_text)
    sound(cascade), sound(live)
    assert cascade.text == ["ready", "ack", "assistant_start", "assistant_delta", "assistant_end"]
    same(cascade.text, live.text, "кадры ответа на набранное")
    same(cascade.voice, live.voice, "озвучка ответа")
    assert cascade.voice[-3:] == ["tts_start(#1)", "bin", "tts_end(#1)"]
    for run in (cascade, live):
        ack, end = run.bodies("ack")[0], run.bodies("assistant_end")[0]
        assert ack["id"] == "c-1" and end["text"] == REPLY and run.deltas(end["messageId"]) == end["text"], run.kind
        assert run.roles()[:2] == ["user", "assistant"] and run.history[0]["id"] == ack["messageId"], run.kind
        assert run.history[0]["text"] == "Мне сегодня тревожно" and run.history[1]["id"] == end["messageId"], run.kind
        assert run.history[1]["text"] == REPLY, run.kind
    same(cascade.roles(), live.roles(), "история")


@pytest.mark.parametrize("settled", [True, False], ids=["after-reply", "before-reply"])
def test_repeated_typed_message_gives_one_answer_and_second_ack(settled: bool) -> None:
    cascade, live = both(lambda r: sc_duplicate(r, settled))
    sound(cascade), sound(live)
    for run in (cascade, live):
        acks = run.bodies("ack")
        assert [a["id"] for a in acks] == ["c-1", "c-1"] and acks[0]["messageId"] == acks[1]["messageId"], run.kind
        assert len(run.replies) == 1 and run.roles()[:2] == ["user", "assistant"], run.kind
    same(cascade.roles(), live.roles(), "история после повтора")
    same(len(cascade.replies), len(live.replies), "число ответов после повтора")


# ─── Голосовая реплика ───────────────────────────────────────────────────────────────────────────────────────────


def test_voice_turn() -> None:
    cascade, live = both(sc_voice)
    sound(cascade), sound(live)
    assert cascade.text == ["ready", "transcript:final", "assistant_start", "assistant_delta", "assistant_end"]
    same(cascade.text, live.text, "кадры голосовой реплики")
    same(cascade.voice, live.voice, "озвучка ответа")
    for run in (cascade, live):
        transcript = run.bodies("transcript")[0]
        assert transcript["text"] == "мне сегодня тяжело" and transcript["final"] is True, run.kind
        assert "ack" not in run.text, run.kind  # на голосовую реплику ack не нужен
        assert run.history[0]["id"] == transcript["messageId"] and run.history[0]["text"] == transcript["text"], run.kind
        assert run.roles()[:2] == ["user", "assistant"] and run.replies == [REPLY], run.kind


@pytest.mark.parametrize("how", ["no-frames", "silent-frames"])
def test_silence_gives_an_empty_final_transcript_and_no_reply(how: str) -> None:
    frames = 0 if how == "no-frames" else 5
    cascade, live = both(lambda r: sc_voice(r, frames=frames, loud=False, reply=False))
    sound(cascade), sound(live)
    assert cascade.text == ["ready", "transcript:empty"]
    same(cascade.text, live.text, "кадры на тишину")
    for run in (cascade, live):
        assert run.bodies("transcript")[0] == {"v": 1, "type": "transcript", "text": "", "final": True}, run.kind
        assert run.roles() == ["user", "assistant"], f"{run.kind}: история только от барьера"
        assert run.history[0]["text"] == "барьер", run.kind
    assert cascade.rig.model_asked_with_voice() == live.rig.model_asked_with_voice() == 0  # тишина модели не достаётся


# ─── Кризис ──────────────────────────────────────────────────────────────────────────────────────────────────────


def test_typed_crisis() -> None:
    cascade, live = both(lambda r: sc_text(r, "я больше не хочу жить"))
    sound(cascade), sound(live)
    assert cascade.text == ["ready", "ack", "safety", "assistant_start", "assistant_delta", "assistant_end"]
    same(cascade.text, live.text, "кадры кризисной реплики")
    same(cascade.voice, live.voice, "озвучка кризисного ответа")
    for run in (cascade, live):
        assert run.bodies("safety")[0]["text"] == CRISIS_SAFETY_TEXT and run.replies == [CRISIS_REPLY], run.kind
        assert run.history[1]["text"] == CRISIS_REPLY, run.kind
        assert run.rig.model_turns() == 1, f"{run.kind}: модель просили ответить на кризис (запросов {run.rig.model_turns()}, ждали один: барьер)"
    assert [t for link in live.rig.connector.links for t in link.typed] == ["барьер"]  # кризисный текст в Gemini не уходил


def test_crisis_in_speech_replaces_the_model_answer() -> None:
    cascade, live = both(sc_voice, heard=["я больше не хочу жить"], replies=["ОТВЕТ-МОДЕЛИ, который человек слышать не должен."])
    sound(cascade), sound(live)
    assert cascade.text == ["ready", "transcript:final", "safety", "assistant_start", "assistant_delta", "assistant_end"]
    same(cascade.text, live.text, "кадры кризиса голосом")
    same(cascade.voice, live.voice, "озвучка кризисного ответа")
    for run in (cascade, live):
        assert run.replies == [CRISIS_REPLY], run.kind
        assert "ОТВЕТ-МОДЕЛИ" not in json.dumps([b for k, b in run.frames if k == "json"], ensure_ascii=False), run.kind
        assert run.history[0]["text"] == "я больше не хочу жить" and run.history[1]["text"] == CRISIS_REPLY, run.kind
        transcript_at, safety_at = run.text.index("transcript:final"), run.text.index("safety")
        assert transcript_at < safety_at < run.text.index("assistant_start"), run.kind


# ─── Перебивание и эхо ───────────────────────────────────────────────────────────────────────────────────────────


def test_barge_in_stops_the_voice_and_the_next_voice_turn_is_answered(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(APP_CONFIG.speech, "tts_frame_interval_ms", 120)  # кадры идут не мгновенно: есть что обрывать
    cascade, live = both(
        sc_barge_in, replies=["Я рядом, расскажи ещё.", "Слышу, продолжай."], heard=["подожди, я не договорил"]
    )
    sound(cascade), sound(live)
    full = {"cascade": 3, "live": 5}  # кадров озвучки в первом ответе, если бы его не прервали
    for run in (cascade, live):
        first = run.extra["first"]
        assert bins_between(run.frames, first) < full[run.kind], f"{run.kind}: после tts_cancel звук не остановился"
        assert has(run.frames, "tts_end", messageId=first), run.kind
        assert run.replies[0] == "Я рядом, расскажи ещё." and run.replies[-1] == "Слышу, продолжай.", run.kind
        assert run.bodies("transcript")[0]["text"] == "подожди, я не договорил", run.kind
        assert run.roles()[:4] == ["user", "assistant", "user", "assistant"], run.kind
    same(cascade.text, live.text, "кадры при перебивании")
    same(cascade.voice, live.voice, "озвучка при перебивании")


def test_echo_of_the_agent_is_not_a_reply_from_the_person() -> None:
    said = "Я слышу тебя. Расскажи, что у тебя на душе?"
    cascade, live = both(
        lambda r: sc_barge_in(r, echo=True), replies=[said, "Продолжай, я слушаю."], heard=["расскажи что у тебя на душе"]
    )
    sound(cascade), sound(live)
    for run in (cascade, live):
        assert run.bodies("transcript") == [{"v": 1, "type": "transcript", "text": "", "final": True}], run.kind
        assert "assistant_start" not in run.text[run.text.index("transcript:empty") :], f"{run.kind}: ответ на эхо"
        # в историю до барьера эхо не попало
        assert [m["text"] for m in run.history if m["role"] == "user"] == ["раз", "барьер"], run.kind
    same(cascade.text, live.text, "кадры при эхо")
    # каскад на эхо чат не зовёт (первая реплика и барьер); live отдаёт эхо модели и выбрасывает её ответ (допустимое различие №5)
    assert cascade.rig.model_turns() == 2 and live.rig.model_turns() == 3


# ─── Выбор голоса, завершение, переподключение ────────────────────────────────────────────────────────────────────


def sc_set_voice(r: Rig) -> Run:
    dialog = r.start()
    with r.socket(dialog) as c:
        c.wait_greeting()
        c.send(type="set_voice", voice="robot")  # чужое значение игнорируется
        c.send(type="set_voice", voice="female")
        before = len(r.tts.voices) if r.tts else 0
        m = c.mark()
        c.say("Привет", "c-1")
        c.wait_reply(m)
        if r.chat is not None:
            voices = set(r.tts.voices[before:])
        else:
            voices = {link.voice for link in r.connector.links if "Привет" in link.typed}
        run = r.done(c, dialog, voices=voices)
    r.client.post(f"/v1/users/{r.user_id}/dialogs/{dialog['dialogId']}/end", headers=AUTH)
    run.extra["next_voice"] = r.start()["voice"]
    return run


def test_set_voice_applies_to_the_next_reply_and_is_remembered() -> None:
    cascade, live = both(sc_set_voice)
    sound(cascade), sound(live)
    for run in (cascade, live):
        assert run.extra["voices"] == {"female"}, run.kind
        assert run.extra["next_voice"] == "female", run.kind
    same(cascade.text, live.text, "кадры после set_voice")
    same(cascade.voice, live.voice, "озвучка после set_voice")
    assert live.rig.connector.open_calls[-1][0] == "female"  # у Gemini голос один на соединение: новая сессия


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
    cascade, live = both(sc_end)
    sound(cascade), sound(live)
    assert cascade.text[-2:] == ["ended", "close:1000"]
    same(cascade.text, live.text, "кадры завершения")
    same(cascade.bodies("ended")[0]["summary"], live.bodies("ended")[0]["summary"], "сводка")
    for run in (cascade, live):
        summary = run.bodies("ended")[0]["summary"]
        assert summary["title"] == "Стало легче" and summary["tensionAfter"] == 3, run.kind
        assert run.extra["item"]["endedAt"] and run.extra["item"]["summary"] == summary, run.kind


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
    cascade, live = both(lambda r: sc_reconnect(r, post_again))
    sound(cascade), sound(live)
    expected_voice = ["tts_start(greeting)", "bin", "tts_end(greeting)"] if post_again else []
    assert cascade.voice[: len(expected_voice)] == expected_voice
    same(cascade.text, live.text, "кадры второго сокета")
    same(cascade.voice, live.voice, "озвучка второго сокета")
    for run in (cascade, live):
        assert [m["text"] for m in run.extra["history_on_return"]] == ["Первая реплика", REPLY], run.kind
        assert run.roles() == ["user", "assistant"] * 3, run.kind  # две пары диалога и пара барьера
        # модель видит прежний разговор: и слова человека, и свой ответ
        assert "Первая реплика" in run.extra["context"] and "непросто" in run.extra["context"], f"{run.kind}: {run.extra['context']!r}"
    for run in (cascade, live):
        calls = run.extra["tts_calls"]
        assert calls.count(GREETING_SENTENCES[0]) == 1 and (GREETING_RESUMED in calls) is post_again, f"{run.kind}: озвучено {calls}"
    if not post_again:
        assert not has(cascade.conn.frames, "tts_start", messageId="greeting")


# ─── Оборванная на полуслове реплика ──────────────────────────────────────────────────────────────────────────────


def sc_unfinished(r: Rig) -> Run:
    dialog = r.start()
    with r.socket(dialog) as c:
        c.wait_greeting()
        m = c.mark()
        c.speak(4)
        c.wait_type("transcript", m)
        c.wait_reply(m)
        start = next(c.stamps[i] for i, (k, b) in enumerate(c.frames) if k == "json" and b["type"] == "assistant_start")
        return r.done(c, dialog, waited=start - c.audio_end_at)


@known_gap("P1 оборванная на полуслове реплика не удерживается: live отвечает сразу, INCOMPLETE_HOLD_MS не действует (_open_gate)")
def test_unfinished_phrase_waits_for_the_person_to_finish() -> None:
    cascade, live = both(sc_unfinished, heard=["мне кажется, что…"])
    sound(cascade), sound(live)
    assert cascade.extra["waited"] >= HOLD_SECONDS * 0.8, "каскад должен держать ответ на оборванной реплике"
    gap(live.extra["waited"] >= HOLD_SECONDS * 0.8, f"live ответил через {live.extra['waited']:.2f} с, каскад ждёт {HOLD_SECONDS} с")


def sc_continuation(r: Rig) -> Run:
    dialog = r.start()
    with r.socket(dialog) as c:
        c.wait_greeting()
        m = c.mark()
        c.speak(4)
        c.wait_type("transcript", m)
        c.speak(4)  # договорил в пределах паузы
        c.wait_reply(m)
        time.sleep(HOLD_SECONDS * 2)  # второго ответа по таймеру быть не должно
        return r.done(c, dialog)


@known_gap("P2 продолжение оборванной реплики получает отдельный ответ: у каскада один ответ на обе части, у live два")
def test_continuation_of_an_unfinished_phrase_gets_one_answer() -> None:
    cascade, live = both(sc_continuation, heard=["мне кажется, что…", "я просто устал."], replies=["Слышу тебя.", "Лишний ответ."])
    sound(cascade), sound(live)
    assert len(cascade.replies) == 1 and [m["text"] for m in cascade.history if m["role"] == "user"][:2] == [
        "мне кажется, что…",
        "я просто устал.",
    ]
    seen = re.sub(r"\[\d{4}-[^\]]*Z\] ", "", cascade.rig.chat.calls[0][-1]["content"])  # время реплик в контексте не важно
    assert "мне кажется, что… я просто устал." in seen  # модель видит обе части как одну реплику
    gap(len(live.replies) == 1, f"live ответил {len(live.replies)} раза(ов) на две части одной мысли: {live.replies}")


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
    cascade, live = both(lambda r: sc_two_typed(r, False), replies=["Ответ на первое.", "Ответ на второе."], latency=0.3)
    sound(cascade)
    assert cascade.replies == ["Ответ на первое.", "Ответ на второе."]
    assert cascade.text.count("ack") == 2
    same(cascade.replies, live.replies, "ответы на две подряд набранные реплики")


@known_gap(
    "P3b набранная реплика посреди ответа обрывает его: assistant_end с недописанным текстом, в истории огрызок "
    "(_begin завершает идущий ход); у каскада предыдущий ответ дописывается, следующая реплика ждёт в очереди"
)
def test_second_typed_message_waits_in_the_queue_while_the_first_answer_is_written() -> None:
    first = "Первое предложение ответа. Второе предложение ответа. Третье предложение ответа."
    cascade, live = both(lambda r: sc_two_typed(r, True), replies=[first, "Ответ на второе."], piece_delay=0.08)
    sound(cascade)
    assert cascade.replies == [first, "Ответ на второе."]
    same(cascade.replies, live.replies, "ответы, когда вторая реплика пришла посреди первого")


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
        events += [LiveEvent("generation_complete"), LiveEvent("resumption", text=link.handle_to_issue)]
        return events

    return plan


@known_gap(
    "P4 расшифровка речи пришла кусками, второй после начала ответа: transcript и история получают обрезанную реплику, "
    "ответ модели на кризис показан и озвучен до safety (premise: Gemini не гарантирует порядок input_transcription и ответа)"
)
def test_crisis_in_the_second_chunk_of_the_transcription() -> None:
    said = "я думаю что не хочу жить"
    cascade, live = both(lambda r: sc_voice(r, wait=2.0), heard=[said], replies=["ОТВЕТ-МОДЕЛИ про что-то другое."], plan=split_heard_plan(2))
    sound(cascade, closed_ends=True)
    assert cascade.bodies("transcript")[0]["text"] == said and cascade.replies == [CRISIS_REPLY]
    assert cascade.text.index("safety") < cascade.text.index("assistant_start")
    transcript = live.bodies("transcript")
    gap(bool(transcript) and transcript[0]["text"] == said, f"live показал и сохранил реплику {transcript[0]['text'] if transcript else None!r}, а не {said!r}")
    gap("assistant_start" not in live.text[: live.text.index("safety")] if "safety" in live.text else False, "ответ модели показан раньше safety или safety нет")
    gap("ОТВЕТ-МОДЕЛИ" not in json.dumps([b for k, b in live.frames if k == "json"], ensure_ascii=False), "ответ модели на кризис попал к человеку")


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
    cascade, live = both(lambda r: sc_voice(r, wait=2.0), plan=late_transcript_plan(0.5))
    sound(cascade, closed_ends=True)
    assert cascade.text == ["ready", "transcript:final", "assistant_start", "assistant_delta", "assistant_end"]
    gap("transcript:final" in live.text, f"live не показал слов человека: {live.text}")
    same(cascade.text, live.text, "кадры при опоздавшей расшифровке")


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
    cascade, live = both(sc_text, plan=tail_after_complete_plan)
    sound(cascade, closed_ends=True)
    assert cascade.replies == [REPLY]
    same(cascade.replies, live.replies, "текст ответа")


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
    cascade, live = both(lambda r: sc_long_speech(r, 1.6))
    sound(cascade)
    assert cascade.text == ["ready", "transcript:final", "assistant_start", "assistant_delta", "assistant_end"]
    gap(not live.conn.stalled, f"live не дождался: {live.conn.stalled}; пришло: {live.conn.dump()}")
    same(cascade.text, live.text, "кадры длинной реплики")


def sc_limit(r: Rig) -> Run:
    dialog = r.start()
    with r.socket(dialog) as c:
        c.wait_greeting()
        before = metric("agent_voice_turns_truncated_total")
        m = c.mark()
        c.speak(frames=3010)  # на десять кадров больше пяти минут
        c.wait_reply(m)
        return r.done(c, dialog, bytes=r.audio_bytes_to_model(), truncated=metric("agent_voice_turns_truncated_total") - before)


def test_five_minute_limit_is_the_same() -> None:
    cascade, live = both(sc_limit)
    sound(cascade), sound(live)
    for run in (cascade, live):
        assert run.extra["bytes"] == MAX_AUDIO_BYTES and run.extra["truncated"] == 1, run.kind
    same(cascade.text, live.text, "кадры после предельной реплики")


# ─── Длина ответа ────────────────────────────────────────────────────────────────────────────────────────────────


@known_gap("P9 ограничение длины ответа не действует: у каскада ответ режется на MAX_REPLY_CHARS, у live приходит целиком")
def test_a_runaway_reply_is_cut_to_the_limit() -> None:
    wall = " ".join(f"Это предложение номер {n}, и оно довольно длинное." for n in range(40))
    assert len(wall) > MAX_REPLY_CHARS * 1.5
    cascade, live = both(sc_text, replies=[wall])
    sound(cascade), sound(live)
    assert len(cascade.replies[0]) <= MAX_REPLY_CHARS
    gap(len(live.replies[0]) <= MAX_REPLY_CHARS, f"ответ live {len(live.replies[0])} символов при пределе {MAX_REPLY_CHARS}")


# ─── Модель молчит: без шаблона ──────────────────────────────────────────────────────────────────────────────────


def sc_answer_or_error(r: Rig, typed: bool) -> Run:
    """Реплика, на которую модель промолчит: ждём либо ответ (live со второй попытки), либо error (каскад)."""
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
    """Различие №9: модель промолчала. Каскад сообщает об этом (error), live просит модель ответить ещё раз в свежей сессии
    и отвечает. Шаблона, не знающего сказанного, нет ни там, ни там."""
    monkeypatch.setattr(APP_CONFIG.gemini, "silence_nudge_ms", 50)
    cascade, live = both(lambda r: sc_answer_or_error(r, typed), replies=["", REPLY])
    sound(cascade), sound(live)
    assert cascade.errors == ["AGENT_LLM_UNAVAILABLE"] and cascade.replies == [] and cascade.roles()[:1] == ["user"]
    assert live.errors == [] and live.replies == [REPLY]
    assert live.roles()[:2] == ["user", "assistant"] and live.history[1]["text"] == REPLY
    for run in (cascade, live):
        assert not set(run.replies) & set(REPLIES), run.kind


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
    cascade, live = both(sc_text_down, chat_fail=True, connector_fail=True)
    sound(cascade), sound(live)
    assert cascade.text == ["ready", "ack", "error:AGENT_LLM_UNAVAILABLE"]
    # допустимое различие №7: единственный бэкенд лёг, live сообщает об этом одним error своего кода, остальное то же
    assert live.text == ["ready", "ack", "error:VOICE_UNAVAILABLE"], live.text
    for run in (cascade, live):
        assert run.replies == [] and run.roles() == ["user"], run.kind


def sc_voice_down(r: Rig, turns: int) -> Run:
    dialog = r.start()
    with r.socket(dialog) as c:
        c.wait_greeting()
        for n in range(1, turns + 1):
            c.speak(4)
            c.wait(f"error за реплику {n}", lambda fs, n=n: types_count(fs, "error") >= n, 0, 1.5)
        return r.done(c, dialog)


def test_voice_turn_with_the_recognition_down_reports_one_error_and_nothing_else() -> None:
    cascade, live = both(lambda r: sc_voice_down(r, 1), stt_fail=True, connector_fail=True)
    # Барьер — набранная реплика: каскаду отвечает чат, а у live Gemini лежит целиком, и ответить на неё нечем (шаблона нет).
    sound(cascade), sound(live, alive=False)
    assert cascade.text[:2] == ["ready", "error:VOICE_UNAVAILABLE"] and "assistant_start" not in cascade.text
    same(cascade.text, live.text[: len(cascade.text)], "кадры при отказе распознавания")
    for run in (cascade, live):
        assert "transcript:final" not in run.text and run.history[0]["text"] == "барьер", run.kind


@known_gap(
    "P6 второй отказ Gemini подряд молчит: ни error, ни транскрипта (флаг _unavailable_sent на всё соединение); "
    "у каскада каждый отказ распознавания даёт error, а клиент ждёт ответ 20 с"
)
def test_every_failed_voice_turn_is_reported() -> None:
    cascade, live = both(lambda r: sc_voice_down(r, 2), stt_fail=True, connector_fail=True)
    assert cascade.errors == ["VOICE_UNAVAILABLE"] * 2
    gap(live.errors == ["VOICE_UNAVAILABLE"] * 2, f"live сообщил об отказах: {live.errors} (кадры: {live.conn.dump()})")


@known_gap(
    "P14 при полностью недоступном Gemini приходят два error VOICE_UNAVAILABLE подряд (флаги _unavailable_sent в live и "
    "_voice_error_sent в базовой сессии независимы: отказ озвучки приветствия и отказ сессии): клиент дважды гасит микрофон "
    "и показывает уведомление"
)
def test_model_down_with_the_real_live_voice_reports_one_error() -> None:
    """Gemini лёг целиком, голос тоже Gemini (GeminiLiveTts): отказывают и озвучка, и разговор. Каскад сообщает об отказе
    озвучки одним VOICE_UNAVAILABLE (и об отказе чата своим кодом), ответов нет ни там, ни там (шаблона нет)."""
    cascade = one("cascade", sc_text_down, chat_fail=True, tts="fail")
    real = one("live", sc_text_down, connector_fail=True, real_tts=True, voiced=False)
    sound(cascade), sound(real)
    assert cascade.errors.count("VOICE_UNAVAILABLE") == 1 and "AGENT_LLM_UNAVAILABLE" in cascade.errors, cascade.errors
    assert real.replies == cascade.replies == []
    gap(real.errors.count("VOICE_UNAVAILABLE") == 1, f"live с настоящей озвучкой прислал {real.errors}, каскад {cascade.errors}")


def plan_dies_mid_reply(link: ScriptedLink, heard: str | None, reply: str) -> list[LiveEvent | float]:
    first = re_split(reply)[:3]  # «Понимаю, это непросто.»: первое предложение и обрыв
    return [LiveEvent("output_text", text=p) for p in first] + [LiveEvent("closed", text="соединение закрыто Google")]


def test_a_connection_dying_mid_reply_keeps_what_was_said() -> None:
    with rig("cascade", chat_dies_after=3) as r:
        cascade = sc_text(r)
    with rig("live", plan=plan_dies_mid_reply, voiced=False) as r:  # звук не успел начаться
        live = sc_text(r)
    sound(cascade), sound(live)
    assert cascade.replies == ["Понимаю, это непросто."] and cascade.errors == []
    assert live.replies and live.replies[0].startswith("Понимаю") and "assistant_start" in live.text
    # допустимое различие №7: единственный бэкенд оборвался, live вправе сообщить об этом одним error
    assert set(live.errors) <= {"VOICE_UNAVAILABLE"} and len(live.errors) <= 1, live.errors
    assert len(live.rig.connector.links) == 2, "следующая реплика (барьер) должна открыть соединение заново"  # различие №8
    assert [m["text"] for m in live.history if m["role"] == "assistant"][0] == live.replies[0]  # в истории то, что показано
    assert REPLIES[0] not in live.replies  # шаблон поверх начатого ответа не добавляется


# ─── Отказ озвучки ───────────────────────────────────────────────────────────────────────────────────────────────


def test_failing_tts_leaves_the_text_and_reports_one_error() -> None:
    cascade, live = both(sc_voice, tts="fail")
    sound(cascade), sound(live)
    assert cascade.errors == ["VOICE_UNAVAILABLE"] and not [t for t in cascade.voice if t.startswith("tts_start(#")]
    assert live.errors == ["VOICE_UNAVAILABLE"]  # приветствие не озвучилось и в live
    same(cascade.replies, live.replies, "текст ответа при отказе озвучки")
    same(cascade.text, live.text, "кадры при отказе озвучки")
    # допустимое различие №6: ответы в live звучат голосом Gemini, TTS им не нужен
    assert any(t.startswith("tts_start(#") for t in live.voice)


def test_a_reply_without_sound_is_reported_like_a_failed_voice() -> None:
    """P10 (закрыт): Gemini прислал текст ответа без звука. Агент пробует озвучить его сам; озвучки нет, и клиент получает
    error VOICE_UNAVAILABLE, как у каскада, а не молча остаётся с текстом."""
    cascade, live = both(sc_voice, audio=False, tts=SelectiveTts, voiced=False)
    sound(cascade), sound(live)
    assert cascade.errors == ["VOICE_UNAVAILABLE"] and "tts_start(#1)" not in cascade.voice
    same(cascade.replies, live.replies, "текст без звука")
    assert "tts_start(#1)" not in live.voice
    gap(live.errors == cascade.errors, f"live не сообщил о том, что ответ не озвучен: {live.errors}")


@known_gap(
    "P11 dev-переключатель озвучки POST /dev/tts {mode: none} не выключает звук ответов в live (_start_live_speech не смотрит на "
    "tts_source); e2e приложения полагаются на него (dev, не пользовательское)"
)
def test_switching_speech_off_applies_to_a_live_socket() -> None:
    def scenario(r: Rig) -> Run:
        dialog = r.start()
        with r.socket(dialog) as c:
            c.wait_greeting()
            r.client.post("/dev/tts", json={"mode": "none"}, headers=AUTH)
            m = c.mark()
            c.say("раз", "c-1")
            c.wait("ответ без звука", lambda fs: reply_done(fs, False), m)
            return r.done(c, dialog, voiced=False)

    cascade, live = both(scenario)
    assert not [t for t in cascade.voice if t.startswith("tts_start(#")], "каскад без озвучки не должен озвучивать"
    gap(not [t for t in live.voice if t.startswith("tts_start(#")], f"live озвучил ответ при выключенной озвучке: {live.voice}")


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
    cascade, live = both(lambda r: sc_crisis_then_followup(r, voice=False), replies=["Я рядом. Расскажи, что случилось."])
    sound(cascade, closed_ends=True)
    assert "не хочу жить" in cascade.extra["context"] and "Я слышу, что тебе очень тяжело" in cascade.extra["context"]
    gap("не хочу жить" in live.extra["context"], "модель не видела кризисной реплики человека")
    gap("Я слышу, что тебе очень тяжело" in live.extra["context"], "модель не знает, что агент ответил кризисным текстом")


# P8 закрыт: новая сессия не помнит выброшенного ответа модели, в её истории то, что человек услышал на самом деле.
def test_the_model_knows_what_the_agent_said_after_a_voice_crisis() -> None:
    cascade, live = both(
        lambda r: sc_crisis_then_followup(r, voice=True),
        heard=["я больше не хочу жить", "не знаю, мне просто плохо"],
        replies=["МОЙ-ВЫБРОШЕННЫЙ-ОТВЕТ.", "Я рядом."],
    )
    sound(cascade, closed_ends=True)
    assert "не хочу жить" in live.extra["context"]  # слова человека модель слышала сама
    assert "Я слышу, что тебе очень тяжело" in cascade.extra["context"]
    gap("Я слышу, что тебе очень тяжело" in live.extra["context"], "в контексте модели нет кризисного ответа агента")
    gap("МОЙ-ВЫБРОШЕННЫЙ-ОТВЕТ" not in live.extra["context"], "в контексте модели лежит ответ, которого человек не слышал")


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
    cascade = one("cascade", sc_text)
    live = one("live", sc_text, plan=chunked_plan(CHUNKINGS[chunking]))
    sound(cascade), sound(live)
    assert cascade.replies == [REPLY]
    # перенос строки внутри куска сохраняется как есть (клиенту это один абзац текста), остальное совпадает дословно
    expected = REPLY.replace("Понимаю, ", "Понимаю,\n", 1) if chunking == "newline-chunk" else REPLY
    assert live.replies == [expected], f"{chunking}: {live.replies!r}"
    assert live.history[1]["text"] == expected  # в истории ровно то, что показано
    same(cascade.text, live.text, "кадры ответа")


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
    while r.connector and not all(link.closed for link in r.connector.links) and time.monotonic() < deadline:
        time.sleep(0.02)
    leaked = [link for link in r.connector.links if not link.closed] if r.connector else []
    with r.socket(dialog) as c:
        c.wait_type("ready", 0)
        m = c.mark()
        c.say("я тут", "c-1")
        c.wait_reply(m)
        return r.done(c, dialog, after_drop=after_drop, leaked=len(leaked))


def test_a_voice_turn_without_audio_end_is_dropped_and_leaves_nothing_open() -> None:
    cascade, live = both(sc_dropped_turn)
    sound(cascade), sound(live)
    for run in (cascade, live):
        assert run.extra["after_drop"] == [], f"{run.kind}: недоговорённая реплика попала в историю"
        assert run.roles()[:2] == ["user", "assistant"] and run.history[0]["text"] == "я тут", run.kind
        assert run.extra["leaked"] == 0, f"{run.kind}: после обрыва остались открытые соединения Gemini"
    same(cascade.text, live.text, "кадры на новом сокете")


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
    cascade, live = both(sc_drop_midreply, replies=[full, "Я рядом."], piece_delay=0.08)
    sound(cascade), sound(live)
    for run in (cascade, live):
        dropped = run.extra["after_drop"]
        assert [m["role"] for m in dropped] == ["user", "assistant"], f"{run.kind}: {dropped}"
        assert dropped[1]["text"] and full.startswith(dropped[1]["text"]), f"{run.kind}: {dropped[1]['text']!r}"
        assert run.replies == ["Я рядом."], run.kind  # после обрыва агент ничего не досылает на новый сокет
    same(cascade.text, live.text, "кадры нового сокета после обрыва")


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
    cascade, live = both(sc_end_midreply)
    sound(cascade, closed_ends=False), sound(live, closed_ends=False)
    for run in (cascade, live):
        assert run.text[-2:] == ["ended", "close:1000"] and run.text.count("ended") == 1, run.kind
    same(cascade.bodies("ended")[0]["summary"]["themes"], live.bodies("ended")[0]["summary"]["themes"], "сводка")


def sc_voice_at_start(r: Rig) -> Run:
    dialog = r.start(voice="female")
    assert dialog["voice"] == "female"
    with r.socket(dialog) as c:
        c.wait_greeting()
        m = c.mark()
        c.say("Привет", "c-1")
        c.wait_reply(m)
        voices = set(r.tts.voices) if r.chat is not None else set(r.tts.voices) | {link.voice for link in r.connector.links}
        return r.done(c, dialog, voices=voices)


def test_voice_chosen_at_start_is_used_for_the_greeting_and_the_reply() -> None:
    cascade, live = both(sc_voice_at_start)
    sound(cascade), sound(live)
    assert cascade.extra["voices"] == live.extra["voices"] == {"female"}
    same(cascade.voice, live.voice, "озвучка")


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
    cascade, live = both(sc_leading_silence)
    sound(cascade), sound(live)
    same(cascade.text, live.text, "кадры реплики с тишиной впереди")
    same(cascade.bodies("transcript")[0]["text"], live.bodies("transcript")[0]["text"], "транскрипт")
    frame = 3200
    assert cascade.extra["audio"] == 15 * frame  # whisper получает запись целиком
    assert live.extra["audio"] == (PRE_ROLL_FRAMES + 4 + 3) * frame  # допустимое различие №4: до речи Gemini видит 500 мс запаса


def sc_second_socket(r: Rig) -> Run:
    dialog = r.start()
    with r.socket(dialog) as c:
        c.wait_greeting()
        opened = len(r.connector.open_calls) if r.connector else 0
        status = None
        try:
            with r.client.websocket_connect(ws_url(r.user_id, dialog["dialogId"]), headers=AUTH):
                pass
        except WebSocketDenialResponse as denied:
            status = denied.status_code
        m = c.mark()
        c.say("я тут", "c-1")
        c.wait_reply(m)
        return r.done(c, dialog, status=status, opened=(len(r.connector.open_calls) - opened) if r.connector else 0)


def test_a_second_socket_is_refused_and_the_first_keeps_working() -> None:
    cascade, live = both(sc_second_socket)
    sound(cascade), sound(live)
    assert cascade.extra["status"] == live.extra["status"] == 409
    assert live.extra["opened"] == 0  # отказ не трогает Gemini: ни нового соединения, ни закрытия живого
    same(cascade.text, live.text, "кадры первого сокета")


def hang_plan(link: ScriptedLink, heard: str | None, reply: str) -> list[LiveEvent | float]:
    return []  # модель молчит: ни расшифровки, ни ответа, ни generation_complete


def test_a_hung_model_gets_one_error_for_a_typed_message(monkeypatch: pytest.MonkeyPatch) -> None:
    """Модель зависла (ни одного события): каскад по таймауту чата шлёт error; live по GEMINI_IDLE_TIMEOUT_SECONDS просит
    модель ответить ещё раз в свежей сессии, та тоже висит — error. Шаблона нет."""
    monkeypatch.setattr(APP_CONFIG.gemini, "idle_timeout_seconds", 1)  # в бою 15 с, как LLM_TIMEOUT_SECONDS каскада
    cascade = one("cascade", sc_text_down, latency=5.0)  # дольше LLM_TIMEOUT_SECONDS=1 в тестах
    live = one("live", sc_text_down, plan=hang_plan)
    sound(cascade), sound(live)
    assert cascade.text == ["ready", "ack", "error:AGENT_LLM_UNAVAILABLE"]
    assert live.text == ["ready", "ack", "error:VOICE_UNAVAILABLE"], live.text  # различие №7
    assert len(live.rig.connector.links) == 2  # повторная просьба ушла в свежую сессию
    for run in (cascade, live):
        assert run.replies == [], run.kind


def test_a_hung_model_does_not_leave_a_voice_turn_unreported(monkeypatch: pytest.MonkeyPatch) -> None:
    """P15 закрыт: модель промолчала после голосовой реплики (ни расшифровки, ни ответа). Раньше через
    GEMINI_IDLE_TIMEOUT_SECONDS приходил пустой transcript и больше ничего; теперь зависание — отказ: error VOICE_UNAVAILABLE.
    Каскад сообщает о зависшем чате своим error. Шаблона нет."""
    monkeypatch.setattr(APP_CONFIG.gemini, "idle_timeout_seconds", 1)

    def voice_down(r: Rig) -> Run:
        dialog = r.start()
        with r.socket(dialog) as c:
            c.wait_greeting()
            m = c.mark()
            c.speak(4)
            c.wait("error", lambda fs: has(fs, "error"), m)
            return r.done(c, dialog, barrier=False)

    cascade = one("cascade", voice_down, latency=5.0)
    live = one("live", voice_down, plan=hang_plan)
    assert "transcript:final" in cascade.text and cascade.errors == ["AGENT_LLM_UNAVAILABLE"]
    assert live.errors == ["VOICE_UNAVAILABLE"], live.text
    for run in (cascade, live):
        assert run.replies == [], run.kind


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
    cascade = one("cascade", sc_text)
    live = one("live", lambda r: sc_text_wait(r, 2.0), plan=audio_only_plan)
    sound(cascade)
    problems = contract(live.conn.frames)
    gap(not problems, f"контракт нарушен: {problems}; кадры: {live.conn.dump()}")


def test_a_crisis_transcription_that_arrives_a_moment_after_the_first_sound_is_still_caught() -> None:
    """Расшифровка приходит позже первого звука ответа, но в пределах GEMINI_TRANSCRIPT_WAIT_MS: ответ ждёт, кризис ловится."""
    said = "я больше не хочу жить"
    cascade, live = both(sc_voice, heard=[said], replies=["ОТВЕТ-МОДЕЛИ, который человек слышать не должен."], plan=late_transcript_plan(0.3))
    sound(cascade), sound(live)
    same(cascade.text, live.text, "кадры кризиса с опоздавшей расшифровкой")
    assert live.replies == [CRISIS_REPLY] and live.bodies("transcript")[0]["text"] == said
    assert "ОТВЕТ-МОДЕЛИ" not in json.dumps([b for k, b in live.frames if k == "json"], ensure_ascii=False)


# ─── Настоящая обвязка live: приветствие и кризис через GeminiLiveTts + CachedTts ─────────────────────────────────


def wait_warm(r: Rig, items: int = 12) -> None:
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline and len(r.client.app.state.tts._items) < items:
        time.sleep(0.02)


def sc_real_wiring(r: Rig) -> Run:
    if r.kind == "live":
        wait_warm(r)
    opened = len(r.connector.open_calls) if r.connector else 0
    dialog = r.start()
    with r.socket(dialog) as c:
        c.wait_greeting()
        m = c.mark()
        c.say("я больше не хочу жить", "c-1")
        c.wait_reply(m)
        extra = {"opened": (len(r.connector.open_calls) - opened) if r.connector else 0}
        return r.done(c, dialog, **extra)


def test_greeting_and_crisis_reply_through_the_real_live_voice_are_served_from_the_cache() -> None:
    cascade = one("cascade", sc_real_wiring)
    real = one("live", sc_real_wiring, real_tts=True)
    sound(cascade), sound(real)
    same(cascade.text, real.text, "кадры приветствия и кризиса")
    same(cascade.voice, real.voice, "озвучка приветствия и кризиса")
    # на диалог открыто ровно одно новое соединение Gemini (для самих реплик): фразы взяты из прогретой памяти
    assert real.extra["opened"] == 1, f"приветствие или кризисный ответ открыли лишние соединения Gemini: {real.extra['opened']}"
