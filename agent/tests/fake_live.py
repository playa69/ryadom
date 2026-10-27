"""Поддельный Gemini Live для тестов: соединение отвечает заданным текстом и звуком, без сети.

Весь агент в тестах говорит с моделью через `FakeConnector`: голосового каскада в агенте нет. Остальное (озвучка фиксированных
фраз, база диалогов, память) подменяется отдельными фабриками `create_app` (см. `tests/conftest.py`).
"""

import asyncio
import json
from collections.abc import AsyncIterator, Callable
from typing import Any

from app.clients.gemini_live import LiveError, LiveEvent, LiveHistory
from tests.conftest import FAKE_PCM, audio_in_frame, has

# Как Google отказывает по квоте (TPM): соединение закрыто кодом 1011, при открытии и посреди хода.
QUOTA_TEXT = "received 1011 (internal error) You exceeded your current quota, please check your plan and billing details."


class FakeLink:
    """Соединение с моделью: на конец реплики отвечает заранее заданным текстом и звуком."""

    def __init__(
        self,
        voice: str,
        reply: str | Callable[[], str],
        heard: str,
        instructions: str,
        history: LiveHistory | None = None,
    ) -> None:
        self.voice = voice
        self.voice_name = f"fake-{voice}"  # как у настоящего соединения: имя голоса Google, с которым открыта сессия
        self.closed = False
        self.instructions = instructions
        self.history = history  # прошлые реплики, загруженные в сессию при открытии
        self.turn_complete = False  # после ответа слать turn_complete, как настоящая модель, когда звук дозвучал
        self.usage: dict[str, int] | None = None  # токены хода, которые модель присылает вместе с turn_complete
        self.signal: str | None = None  # "go_away" | "drop": что Google делает после ответа
        self.quota_close = False  # на первом же ходу Google закрывает соединение 1011 «exceeded your current quota» вместо ответа
        self.commands: list[tuple[Any, ...]] = []
        self._reply = reply
        self._heard = heard
        self._queue: asyncio.Queue[LiveEvent] = asyncio.Queue()

    def _reply_text(self) -> str:
        return self._reply() if callable(self._reply) else self._reply

    def _respond(self, heard: str | None) -> None:
        if self.quota_close:
            self._queue.put_nowait(LiveEvent("closed", text=f"ConnectionClosedError: {QUOTA_TEXT}"))
            return
        if heard:
            self._queue.put_nowait(LiveEvent("input_text", text=heard))
        for piece in re_split(self._reply_text()):
            self._queue.put_nowait(LiveEvent("output_text", text=piece))
        self._queue.put_nowait(LiveEvent("audio", data=FAKE_PCM))
        self._queue.put_nowait(LiveEvent("audio", data=FAKE_PCM))
        self._queue.put_nowait(LiveEvent("generation_complete"))
        if self.usage:
            self._queue.put_nowait(LiveEvent("usage", usage=dict(self.usage)))
        if self.turn_complete:
            self._queue.put_nowait(LiveEvent("turn_complete"))
        if self.signal == "go_away":
            self._queue.put_nowait(LiveEvent("go_away", text="30s"))
        elif self.signal == "drop":
            self._queue.put_nowait(LiveEvent("closed", text="соединение закрыто Google"))

    def push(self, event: LiveEvent) -> None:
        """Событие от модели, которое тест присылает сам, когда ему надо (из потока теста: `ws.portal.call(link.push, event)`)."""
        self._queue.put_nowait(event)

    async def activity_start(self) -> None:
        self.commands.append(("start",))

    async def send_audio(self, pcm: bytes) -> None:
        self.commands.append(("audio", len(pcm)))

    async def activity_end(self) -> None:
        self.commands.append(("end",))
        self._respond(self._heard)

    async def send_text(self, text: str) -> None:
        self.commands.append(("text", text))
        self._respond(None)

    async def nudge(self) -> None:
        self.commands.append(("nudge",))
        self._respond(None)

    async def events(self) -> AsyncIterator[LiveEvent]:
        while True:
            event = await self._queue.get()
            yield event
            if event.kind == "closed":
                return

    async def aclose(self) -> None:
        self.closed = True


def re_split(text: str) -> list[str]:
    """Ответ кусками, как расшифровка модели: слова с пробелом на стыке."""
    words = text.split(" ")
    return [w + (" " if i < len(words) - 1 else "") for i, w in enumerate(words)]


class FakeConnector:
    name = "fake-live"
    model = "fake-live-model"

    def __init__(
        self,
        reply: str = "Понимаю, это непросто. Что сейчас тревожит больше всего?",
        heard: str = "мне сегодня тяжело",
        fail: bool = False,
        after_first_reply: str | None = None,
        turn_complete: bool = False,
        usage: dict[str, int] | None = None,
        replies: list[str] | None = None,
    ) -> None:
        self.reply = reply
        self.replies = list(replies) if replies else None  # ответы по очереди (по кругу), если нужны разные от хода к ходу
        self.heard = heard
        self.fail = fail
        self.after_first_reply = after_first_reply  # "go_away" | "drop": судьба первого соединения
        self.turn_complete = turn_complete  # модель шлёт turn_complete после каждого ответа
        self.usage = usage  # и usage (токены хода) перед ним
        self.fail_from: int | None = None  # с какого по счёту открытия (с 1) соединение не открывается
        # Квота Google (TPM): открытия с номера quota_from (с 1) отвечают «1011 … exceeded your current quota», столько
        # открытий подряд (None — все); соединения с номерами из quota_close_links закрываются так же посреди первого хода.
        self.quota_from: int | None = None
        self.quota_count: int | None = None
        self.quota_close_links: set[int] = set()
        self.open_delay = 0.0  # сколько открытие длится (в бою около секунды)
        self.links: list[FakeLink] = []
        self.open_calls: list[str] = []  # голос каждого вызова open, в том числе неудачного
        self.history_calls: list[LiveHistory | None] = []  # history каждого вызова open, в том числе неудачного
        self._replied = 0

    def next_reply(self) -> str:
        if not self.replies:
            return self.reply
        text = self.replies[self._replied % len(self.replies)]
        self._replied += 1
        return text

    async def open(self, voice: str, instructions: str, history: LiveHistory | None = None) -> FakeLink:
        self.open_calls.append(voice)
        self.history_calls.append(history)
        if self.open_delay:
            await asyncio.sleep(self.open_delay)
        number = len(self.open_calls)
        if self.quota_from is not None and number >= self.quota_from:
            if self.quota_count is None or number < self.quota_from + self.quota_count:
                raise LiveError(f"Gemini Live не открылся: ConnectionClosedError: {QUOTA_TEXT}")
        if self.fail:
            raise LiveError("Gemini Live не открылся в тесте")
        if self.fail_from is not None and len(self.open_calls) >= self.fail_from:
            raise LiveError("Gemini Live не открылся в тесте")
        link = FakeLink(voice, self.next_reply if self.replies else self.reply, self.heard, instructions, history)
        link.turn_complete = self.turn_complete
        link.usage = self.usage
        link.quota_close = number in self.quota_close_links
        if not self.links:
            link.signal = self.after_first_reply
        self.links.append(link)
        return link

    async def aclose(self) -> None:
        return None


# ─── Общие помощники сценариев ────────────────────────────────────────────────


def deltas_text(frames: list[Any], message_id: str) -> str:
    return "".join(f[1]["text"] for f in frames if f[0] == "json" and f[1]["type"] == "assistant_delta" and f[1]["messageId"] == message_id)


def reply_done(frames: list[Any]) -> bool:
    """Ответ дошёл до конца: assistant_end и tts_end именно этого сообщения (не приветствия)."""
    ends = [f[1] for f in frames if f[0] == "json" and f[1]["type"] == "assistant_end"]
    return bool(ends) and has(frames, "tts_end", messageId=ends[-1]["messageId"])


def speak_turn(ws: Any, loud: int = 4) -> None:
    ws.send_text(json.dumps({"type": "audio_start"}))
    for i in range(loud):
        ws.send_bytes(audio_in_frame(i, loud=True))
    ws.send_text(json.dumps({"type": "audio_end"}))
