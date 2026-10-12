"""WebSocket диалога в режиме `VOICE_PIPELINE=gemini_live`: речь в речь через Gemini Live.

Тот же протокол с клиентом, что у каскада (app/api/dialog_ws.py), но голос человека уходит прямо в Gemini Live, а ответ
(текст и звук) приходит от него же. Распознавания и чат-модели здесь нет. Остаётся общим: приветствие и кризисный ответ
(фиксированные фразы озвучивает тот же голос Gemini, дословно), перебивание, выбор голоса, сохранение диалога.

Границы реплики задаёт клиент (`audio_start`/`audio_end`): агент передаёт их модели как начало и конец активности.
Кризис проверяется на расшифровке реплики до того, как человек услышит или увидит хоть слово ответа: пока расшифровки
нет, ответ модели ждёт (`GEMINI_TRANSCRIPT_WAIT_MS`); при кризисе ответ модели выбрасывается, говорит фиксированный текст.
"""

import asyncio
import logging
import time
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any, Literal

from fastapi import WebSocket

from app.api.dialog_ws import (
    FRAME_KIND_AUDIO_IN,
    MAX_AUDIO_BYTES,
    MAX_USER_TEXT,
    DialogSession,
    SpeechFeed,
    Turn,
    is_silence,
)
from app.clients.gemini_live import LiveConnector, LiveEvent, LiveHistory, LiveLink
from app.clients.speech import Voice
from app.core.config import APP_CONFIG
from app.core.metrics import (
    GEMINI_CONTEXT_REFRESH_SECONDS,
    GEMINI_CONTEXT_REFRESH_TOTAL,
    GEMINI_TOKENS_TOTAL,
    VOICE_TURN_END_DELAY_SECONDS,
    VOICE_TURNS_TRUNCATED_TOTAL,
)
from app.services.dialog_store import Dialog, DialogStore, Message
from app.services.replies import CRISIS_SAFETY_TEXT, SYSTEM_PROMPT, is_crisis

logger = logging.getLogger("agent.live")

# Сколько мс тишины перед началом речи уходит модели вместе с ней (кадры по 100 мс): начало слова не обрезается.
PRE_ROLL_FRAMES = 5
# Хвост ответа прерванной модели, которая ещё может прислать события, считается чужим столько секунд.
STALE_SECONDS = 1.0

LIVE_ADDENDUM = (
    "\n- Ты говоришь вслух живым голосом, как в разговоре: коротко, без пересказа сказанного человеком."
    "\n- Если тебя просят произнести фразу дословно, произноси ровно её."
)


@dataclass(eq=False)
class LiveTurn:
    """Один ход: реплика человека и ответ модели на неё."""

    kind: Literal["voice", "text"]
    interrupts: bool = False  # голосовая реплика начата поверх озвучки (перебивание)
    started: float = field(default_factory=time.monotonic)  # конец реплики человека или его сообщение
    heard: str = ""  # расшифровка голоса от модели
    opened: bool = False  # ответ можно показывать: реплика проверена и сохранена
    discarded: bool = False  # эхо, тишина или кризис: ответ модели выбрасывается
    generating: bool = True
    got_output: bool = False
    failed: bool = False
    user_saved: bool = False
    held: list[LiveEvent] = field(default_factory=list)  # ответ, который ждёт расшифровки
    message_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    message: Message | None = None
    assistant_started: bool = False
    sent_text: str = ""
    pending_ws: str = ""
    audio: "asyncio.Queue[bytes | None] | None" = None
    timers: dict[str, asyncio.TimerHandle] = field(default_factory=dict)
    # Метки времени хода (monotonic) для журнала задержек: только имена этапов и миллисекунды, без текстов.
    marks: dict[str, float] = field(default_factory=dict)

    def mark(self, name: str, overwrite: bool = False) -> None:
        if overwrite or name not in self.marks:
            self.marks[name] = time.monotonic()

    def timeline(self) -> str:
        """Этапы хода в мс от конца реплики человека (или от его сообщения): где ушло время до первого звука."""
        return " ".join(f"{name}={(at - self.started) * 1000:.0f}" for name, at in sorted(self.marks.items(), key=lambda kv: kv[1]))


_CLOSING: set["asyncio.Task[None]"] = set()  # фоновые закрытия соединений: ссылка нужна, чтобы задачу не собрал GC


async def _close_link(reader: "asyncio.Task[None] | None", link: LiveLink | None) -> None:
    if reader is not None:
        reader.cancel()
        await asyncio.gather(reader, return_exceptions=True)
    if link is not None:
        await link.aclose()


class _QueueTts:
    """Источник звука для `DialogSession._speak`: куски PCM, которые кладёт в очередь Gemini Live."""

    name = "gemini-live"

    def __init__(self, pieces: "asyncio.Queue[bytes | None]") -> None:
        self._pieces = pieces

    async def stream(self, text: str, voice: Voice) -> AsyncIterator[bytes]:
        while (piece := await self._pieces.get()) is not None:
            yield piece

    async def synthesize(self, text: str, voice: Voice) -> bytes:  # pragma: no cover - не используется
        raise NotImplementedError

    async def aclose(self) -> None:
        return None


class LiveDialogSession(DialogSession):
    def __init__(
        self,
        websocket: WebSocket,
        store: DialogStore,
        dialog: Dialog,
        tts_source,  # noqa: ANN001
        connector: LiveConnector,
    ) -> None:
        super().__init__(websocket, store, dialog, tts_source, None, None)
        self._connector = connector
        self._cfg = APP_CONFIG.gemini
        self._link: LiveLink | None = None
        self._link_lock = asyncio.Lock()
        self._reader: asyncio.Task[None] | None = None
        self._out: asyncio.Queue[tuple[Any, ...]] = asyncio.Queue()
        self._events: asyncio.Queue[tuple[Any, ...]] = asyncio.Queue()
        self._tasks: list[asyncio.Task[Any]] = []
        self._turn: LiveTurn | None = None
        self._stale_until = 0.0
        self._act_started = False
        self._pre: list[bytes] = []
        self._sent_bytes = 0
        self._voice_turn: LiveTurn | None = None
        self._unavailable_sent = False
        # Handle последней сессии Gemini: по нему соединение возобновляется с тем же контекстом разговора.
        self._resume_handle: str | None = None
        # Google предупредил, что скоро закроет соединение: между репликами переоткрываем его заранее.
        self._refresh = False
        self._rotation: asyncio.Task[None] | None = None  # смена сессии после ответа (GEMINI_TEXT_CONTEXT)
        self._link_used = False  # на текущем соединении уже начат ход (иначе в нём нет аудио, которое стоило бы убрать)
        self._speech_turns: dict[str, LiveTurn] = {}

    def _first_sound(self, message_id: str, turn: Turn | None) -> None:
        """Первый звук ответа ушёл клиенту: кроме общей задержки пишем, из каких этапов она сложилась."""
        super()._first_sound(message_id, turn)
        live_turn = self._speech_turns.pop(message_id, None)
        if live_turn is not None:
            live_turn.mark("tts_start")
            logger.info("live timeline dialog=%s kind=%s ms: %s", self._dialog.id, live_turn.kind, live_turn.timeline())

    # ─── жизненный цикл ───────────────────────────────────────────────────────

    async def run(self) -> None:
        loop = asyncio.get_running_loop()
        self._loop = loop
        self._tasks = [
            asyncio.create_task(self._send_loop()),
            asyncio.create_task(self._pump()),
            asyncio.create_task(self._ensure_link()),  # соединение готово к первой реплике
        ]
        try:
            await super().run()
        finally:
            if self._rotation is not None:
                self._tasks.append(self._rotation)
            for task in self._tasks:
                task.cancel()
            await asyncio.gather(*self._tasks, return_exceptions=True)
            for turn in (self._turn, self._voice_turn):
                if turn is not None:
                    self._disarm_all(turn)
            self._release_link()

    def _history(self) -> list[tuple[Literal["user", "model"], str]]:
        """Последние сообщения диалога для новой сессии: (кто, текст). История начинается с реплики человека, подряд
        идущие реплики одного автора склеены (так модель принимает её без ошибок)."""
        messages = list(self._dialog.messages)
        while messages and messages[-1].role == "user":  # это реплика, которую сейчас отправим
            messages.pop()
        if self._cfg.history_messages:
            messages = messages[-self._cfg.history_messages :]
        history: list[tuple[Literal["user", "model"], str]] = []
        for message in messages:
            role: Literal["user", "model"] = "user" if message.role == "user" else "model"
            if not history and role == "model":
                continue
            if history and history[-1][0] == role:
                history[-1] = (role, history[-1][1] + "\n" + message.text)
            else:
                history.append((role, message.text))
        return history

    def _instructions(self, resumed: bool = False) -> str:
        """Промпт агента и, если история не уходит отдельными репликами, последние сообщения текстом: модель не начинает
        с чистого листа.

        Возобновлённая по handle сессия помнит разговор сама (в том числе сжатый Google): текст ей не дублируем.
        При GEMINI_TEXT_CONTEXT история загружается в сессию настоящими репликами (`_history`), в промпт её не кладём.
        """
        history = [] if resumed or self._cfg.text_context else self._history()
        text = SYSTEM_PROMPT + LIVE_ADDENDUM
        if history:
            lines = [("Человек" if role == "user" else "Ты") + ": " + message for role, message in history]
            text += "\n\nУже сказано в этом разговоре (продолжай, не здоровайся заново):\n" + "\n".join(lines)
        return text

    # ─── соединение ───────────────────────────────────────────────────────────

    async def _ensure_link(self, rotate: bool = False) -> LiveLink | None:
        """Живое соединение с моделью. `rotate`: сменить его на свежее с текстовой историей, если человек ещё не заговорил."""
        async with self._link_lock:
            link = self._link
            voice = self._dialog.voice
            if rotate:
                if self._turn is not None or self._voice_turn is not None:
                    return link  # новый ход уже начался: сессию сменим после его ответа
                if not self._link_used:
                    return link  # на этой сессии ход ещё не вёлся: менять нечего (и цепочка смен невозможна)
                self._refresh = True
            # Сюда приходят в начале нового хода (прошлый ответ к этому моменту уже закрыт `_begin`).
            if link is not None and not link.closed and link.voice == voice and not self._refresh:
                return link
            voice_changed = link is not None and link.voice != voice
            await self._drop_link()
            self._refresh = False
            if voice_changed:
                self._resume_handle = None  # голос у сессии один на всё соединение: новый голос — новая сессия
            # При text_context контекст приходит текстом, возобновлять сессию по handle (вместе с её аудио) не нужно.
            handle = self._resume_handle if self._cfg.session_resumption and not self._cfg.text_context else None
            link = await self._open(voice, handle)
            if link is None and handle is not None:
                # Handle не принят (устарел, сессия закрыта): начинаем заново, а контекст даём последними сообщениями.
                self._resume_handle = None
                link = await self._open(voice, None)
            if link is None:
                return None
            self._link = link
            self._link_used = False
            self._reader = asyncio.create_task(self._read(link))
            return link

    async def _open(self, voice: Voice, handle: str | None) -> LiveLink | None:
        history: LiveHistory | None = self._history() if self._cfg.text_context and handle is None else None
        try:
            link = await self._connector.open(voice, self._instructions(resumed=handle is not None), handle, history or None)
        except Exception as error:  # noqa: BLE001
            logger.warning("gemini live not available dialog=%s resume=%s: %s", self._dialog.id, handle is not None, error)
            return None
        if handle is not None:
            logger.info("gemini live session resumed dialog=%s", self._dialog.id)
        return link

    def _schedule_rotation(self) -> None:
        if self._rotation is None or self._rotation.done():
            self._rotation = asyncio.create_task(self._rotate())

    async def _rotate(self) -> None:
        """Ответ договорён и озвучен (turn_complete): меняем сессию на свежую, где прошлые реплики лежат текстом, а не
        аудио. Идёт в фоне, пока человек думает; если он заговорил раньше, смена откладывается до следующего ответа."""
        before, started = self._link, time.monotonic()
        link = await self._ensure_link(rotate=True)
        if link is before:
            return
        seconds = time.monotonic() - started
        if link is None:
            GEMINI_CONTEXT_REFRESH_TOTAL.labels("failed").inc()
            logger.warning("live context refresh failed dialog=%s ms=%d", self._dialog.id, seconds * 1000)
            return
        GEMINI_CONTEXT_REFRESH_TOTAL.labels("ok").inc()
        GEMINI_CONTEXT_REFRESH_SECONDS.observe(seconds)
        logger.info(
            "live context refreshed dialog=%s history_messages=%d ms=%d", self._dialog.id, len(self._history()), seconds * 1000
        )

    def _count_usage(self, usage: dict[str, int]) -> None:
        """Токены хода из usage_metadata: prompt — весь контекст хода (оплачивается заново каждый ход), response — ответ."""
        for key, value in usage.items():
            direction, _, modality = key.partition("_")
            GEMINI_TOKENS_TOTAL.labels(direction, modality).inc(value)
        logger.info(
            "live usage dialog=%s prompt=%d(text=%d audio=%d) response=%d(audio=%d)",
            self._dialog.id,
            usage.get("prompt_all", 0),
            usage.get("prompt_text", 0),
            usage.get("prompt_audio", 0),
            usage.get("response_all", 0),
            usage.get("response_audio", 0),
        )

    async def _drop_link(self) -> None:
        reader, link = self._reader, self._link
        self._reader, self._link = None, None
        await _close_link(reader, link)

    def _release_link(self) -> None:
        """Конец сеанса: закрытие соединения с Google (около 0,1 с по сети) идёт в фоне. Пока сокет диалога его ждал,
        повторное подключение клиента (вторая вкладка, переподключение шлюза) получало 409: диалог ещё «занят»."""
        reader, link = self._reader, self._link
        self._reader, self._link = None, None
        task = asyncio.create_task(_close_link(reader, link))
        _CLOSING.add(task)
        task.add_done_callback(_CLOSING.discard)

    async def _read(self, link: LiveLink) -> None:
        async for event in link.events():
            if event.kind == "usage":  # учёт токенов не зависит от состояния хода
                self._count_usage(event.usage or {})
                continue
            self._events.put_nowait((link, event))

    async def _send_loop(self) -> None:
        """Команды модели строго по порядку: начало активности, кадры звука, конец активности, текст."""
        while True:
            command = await self._out.get()
            kind = command[0]
            try:
                if kind in ("start", "text"):
                    link = await self._ensure_link()
                    if link is None:
                        self._events.put_nowait((None, LiveEvent("closed", text="не удалось открыть Gemini Live")))
                        continue
                    self._link_used = True  # с этого момента на соединении есть ход
                    if kind == "start":
                        await link.activity_start()
                    else:
                        await link.send_text(command[1])
                        command[2].mark("sent")
                else:
                    link = self._link
                    if link is None or link.closed:
                        continue
                    if kind == "audio":
                        await link.send_audio(command[1])
                    elif kind == "end":
                        await link.activity_end()
                        command[1].mark("sent")
            except asyncio.CancelledError:
                raise
            except Exception as error:  # noqa: BLE001
                logger.warning("gemini live send failed dialog=%s: %s", self._dialog.id, error)
                self._events.put_nowait((self._link, LiveEvent("closed", text=str(error)[:200])))

    async def _pump(self) -> None:
        """Единственный, кто разбирает события модели и таймеры: состояние хода меняется только здесь."""
        while True:
            item = await self._events.get()
            try:
                match item[0]:
                    case "begin":
                        await self._begin(item[1])
                    case "ended":
                        self._on_ended(item[1])
                    case "timer":
                        await self._on_timer(item[1], item[2])
                    case link:
                        if link is self._link:
                            await self._handle(item[1])
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("live event failed dialog=%s", self._dialog.id)

    # ─── вход: голос и текст человека ─────────────────────────────────────────

    def _audio_started(self) -> None:
        self._act_started = False
        self._pre = []
        self._sent_bytes = 0
        self._voice_turn = None

    def _on_audio_frame(self, data: bytes) -> None:
        if not (self._audio_open and len(data) > 5 and data[0] == FRAME_KIND_AUDIO_IN):
            return
        pcm = data[5:]
        self._audio_frames += 1
        voiced = not is_silence(pcm)
        if voiced:
            self._last_voiced = time.monotonic()
        if not self._act_started:
            if not voiced:
                self._pre = (self._pre + [pcm])[-PRE_ROLL_FRAMES:]  # тишину до речи модель не получает, кроме запаса
                return
            self._act_started = True
            turn = LiveTurn(kind="voice", interrupts=self._turn_interrupts)
            self._voice_turn = turn
            self._events.put_nowait(("begin", turn))
            self._out.put_nowait(("start",))
            for piece in self._pre:
                self._forward(piece)
            self._pre = []
        self._forward(pcm)

    def _forward(self, pcm: bytes) -> None:
        if self._sent_bytes >= MAX_AUDIO_BYTES:
            return
        self._sent_bytes += len(pcm)
        if self._sent_bytes >= MAX_AUDIO_BYTES:
            VOICE_TURNS_TRUNCATED_TOTAL.inc()
            logger.warning("voice turn reached the limit dialog=%s", self._dialog.id)
        self._out.put_nowait(("audio", pcm))

    async def _on_audio_end(self) -> None:
        if not self._audio_open:
            return
        interrupts = self._turn_interrupts
        if self._last_voiced is not None:
            VOICE_TURN_END_DELAY_SECONDS.observe(time.monotonic() - self._last_voiced)
        turn = self._voice_turn
        self._audio_open, self._audio_frames, self._audio = False, 0, bytearray()
        self._last_voiced, self._turn_interrupts = None, False
        self._voice_turn, self._pre, self._act_started = None, [], False
        if turn is None:  # речи в записи не было
            self._count_false_interruption(interrupts)
            await self._send({"type": "transcript", "text": "", "final": True})
            return
        turn.started = time.monotonic()
        self._events.put_nowait(("ended", turn))
        self._out.put_nowait(("end", turn))

    def _dispatch_text_turn(self, text: str, crisis: bool, turn: Turn) -> None:
        if crisis:  # кризис говорит фиксированный текст, модель в этот путь не входит
            self._refresh_after_crisis()
            super()._dispatch_text_turn(text, crisis, turn)
            return
        live_turn = LiveTurn(kind="text", opened=True, started=turn.started)
        live_turn.user_saved = True
        self._events.put_nowait(("begin", live_turn))
        self._out.put_nowait(("text", text, live_turn))

    # ─── ход ──────────────────────────────────────────────────────────────────

    async def _begin(self, turn: LiveTurn) -> None:
        prev = self._turn
        if prev is not None and prev is not turn and prev.generating:
            # Новая реплика перебивает идущий ответ; его хвост, ещё летящий от модели, не наш.
            self._stale_until = time.monotonic() + STALE_SECONDS
            await self._finish(prev)
        self._turn = turn
        self._touch(turn)

    def _on_ended(self, turn: LiveTurn) -> None:
        self._stale_until = 0.0
        self._touch(turn)

    def _arm(self, turn: LiveTurn, name: str, delay: float) -> None:
        self._disarm(turn, name)
        turn.timers[name] = self._loop.call_later(delay, lambda: self._events.put_nowait(("timer", turn, name)))

    @staticmethod
    def _disarm(turn: LiveTurn, name: str) -> None:
        handle = turn.timers.pop(name, None)
        if handle is not None:
            handle.cancel()

    def _disarm_all(self, turn: LiveTurn) -> None:
        for name in list(turn.timers):
            self._disarm(turn, name)

    def _touch(self, turn: LiveTurn) -> None:
        """Ход жив, пока от модели что-то приходит: иначе через GEMINI_IDLE_TIMEOUT_SECONDS он закрывается."""
        self._arm(turn, "idle", self._cfg.idle_timeout_seconds)

    async def _on_timer(self, turn: LiveTurn, name: str) -> None:
        if not turn.generating:
            return
        if name == "gate":
            if not turn.opened and not turn.discarded:
                await self._open_gate(turn)
        elif name == "idle":
            logger.warning("live turn timed out dialog=%s", self._dialog.id)
            await self._finish(turn)

    async def _handle(self, event: LiveEvent) -> None:
        turn = self._turn
        kind = event.kind
        if kind == "closed":
            await self._on_closed(event.text)
            return
        if kind == "resumption":
            self._resume_handle = event.text
            return
        if kind == "go_away":
            logger.info("gemini live go_away dialog=%s time_left=%s", self._dialog.id, event.text)
            self._refresh = True  # переоткроем между репликами, с возобновлением сессии
            return
        if kind == "interrupted":
            self._stale_until = 0.0
            if turn is not None and turn.got_output:
                await self._finish(turn)
            return
        if kind != "input_text" and time.monotonic() < self._stale_until:
            if kind in ("generation_complete", "turn_complete"):
                self._stale_until = 0.0
            return  # хвост прерванного ответа
        if kind == "turn_complete" and turn is None and self._cfg.text_context:
            self._schedule_rotation()  # ответ дозвучал, человек ещё молчит: самое время сменить сессию
            return
        if turn is None:
            return
        self._touch(turn)
        if kind == "input_text":
            turn.mark("in_first")
            turn.mark("in_last", True)
            turn.heard += event.text
            if not turn.discarded and is_crisis(turn.heard):
                await self._crisis(turn)
            elif turn.held and not turn.opened and turn.heard.strip():
                await self._open_gate(turn)
            return
        if kind in ("audio", "output_text"):
            turn.got_output = True
            turn.mark("out_first")
            if turn.discarded:
                return
            if turn.opened:
                await self._emit(turn, event)
                return
            turn.held.append(event)
            if turn.heard.strip():
                await self._open_gate(turn)
            elif "gate" not in turn.timers:
                self._arm(turn, "gate", self._cfg.transcript_wait_ms / 1000)
            return
        if kind == "generation_complete":
            await self._finish(turn)
        # turn_complete приходит позже generation_complete (когда звук отыгран) и может попасть на следующий ход: не нужен.

    async def _open_gate(self, turn: LiveTurn) -> None:
        """Расшифровка реплики есть: проверить её и только тогда показать и озвучить ответ модели."""
        self._disarm(turn, "gate")
        turn.opened = True
        turn.mark("gate")
        heard = turn.heard.strip()
        if turn.kind == "voice":
            if not heard or (turn.interrupts and self._is_echo(heard)):
                turn.discarded = True
                turn.held.clear()
                self._count_false_interruption(turn.interrupts)
                await self._send({"type": "transcript", "text": "", "final": True})
                return
            if is_crisis(heard):
                await self._crisis(turn)
                return
            self._drop_hold()
            self._supersede_speech()
            await self._save_voice(turn, heard)
        held, turn.held = turn.held, []
        for event in held:
            await self._emit(turn, event)

    async def _save_voice(self, turn: LiveTurn, heard: str) -> None:
        message = self._store.add_message(self._dialog, "user", heard[:MAX_USER_TEXT])
        turn.user_saved = True
        await self._send({"type": "transcript", "text": message.text, "final": True, "messageId": message.id})

    def _refresh_after_crisis(self) -> None:
        """Кризисный обмен идёт без модели (или с выброшенным ответом): к следующему ходу сессия открывается заново, и в её
        истории лежит то, что человек услышал на самом деле, то есть кризисный ответ агента, а не ответ модели."""
        if self._cfg.text_context:
            self._refresh = True

    async def _crisis(self, turn: LiveTurn) -> None:
        """Кризис: ответ модели не звучит и не показывается, вместо него фиксированный текст (как в каскаде)."""
        if turn.discarded:
            return
        self._refresh_after_crisis()
        turn.discarded = True
        turn.opened = True
        turn.held.clear()
        self._disarm(turn, "gate")
        if turn.assistant_started:
            self._cancel_speech(turn.message_id)  # ответ уже пошёл: обрываем звук, текст дописан не будет
        if turn.kind == "voice" and not turn.user_saved and turn.heard.strip():
            await self._save_voice(turn, turn.heard.strip())
        await self._send({"type": "safety", "text": CRISIS_SAFETY_TEXT})
        self._supersede_speech()
        reply_turn = Turn(started=turn.started)
        self._jobs.put_nowait(lambda: self._reply(True, reply_turn))

    # ─── выход: ответ модели человеку ─────────────────────────────────────────

    async def _emit(self, turn: LiveTurn, event: LiveEvent) -> None:
        if not turn.assistant_started:
            turn.assistant_started = True
            await self._send({"type": "assistant_start", "messageId": turn.message_id})
        if event.kind == "audio":
            if turn.message_id in self._cancelled:
                return
            if turn.audio is None:
                turn.mark("audio_first")
                self._start_live_speech(turn)
            assert turn.audio is not None
            turn.audio.put_nowait(event.data)
            return
        # Дельты в сумме дают ровно текст ответа: пробелы на стыке ждут следующего куска, в начале и конце их нет.
        text = turn.pending_ws + event.text
        if not turn.sent_text:
            text = text.lstrip()
        core = text.rstrip()
        turn.pending_ws = text[len(core) :]
        if not core:
            return
        turn.sent_text += core
        if turn.message is None:
            turn.message = self._store.add_message(self._dialog, "assistant", turn.sent_text, turn.message_id)
        else:
            turn.message.text = turn.sent_text
        await self._send({"type": "assistant_delta", "messageId": turn.message_id, "text": core})

    def _start_live_speech(self, turn: LiveTurn) -> None:
        """Звук ответа: тот же конвейер кадров, что у каскада (темп, перебивание, tts_start/tts_end), источник — Gemini."""
        turn.audio = asyncio.Queue()
        feed = SpeechFeed()
        feed.add("gemini-live")
        feed.close()
        message_id = turn.message_id
        self._speech_turns[message_id] = turn
        task = asyncio.create_task(
            self._speak(_QueueTts(turn.audio), message_id, feed.chunks, self._dialog.voice, Turn(started=turn.started))  # type: ignore[arg-type]
        )
        self._speech_tasks.add(task)
        self._speeches[message_id] = task
        task.add_done_callback(self._speech_tasks.discard)
        task.add_done_callback(lambda done: self._forget_speech(message_id, done))

    async def _finish(self, turn: LiveTurn) -> None:
        if not turn.generating:
            return
        turn.generating = False
        self._disarm_all(turn)
        if self._turn is turn:
            self._turn = None
        if not turn.opened and not turn.discarded:
            # Ответа от модели не было: реплику всё равно надо сохранить, а человеку ответить.
            heard = turn.heard.strip()
            if turn.kind == "voice":
                if heard and not turn.failed:
                    await self._save_voice(turn, heard)
                elif not turn.failed:
                    await self._send({"type": "transcript", "text": "", "final": True})
        if turn.audio is not None:
            turn.audio.put_nowait(None)
        if turn.assistant_started and turn.sent_text and not self._closed:
            await self._send({"type": "assistant_end", "messageId": turn.message_id, "text": turn.sent_text})
        if not turn.assistant_started and not turn.discarded and (turn.kind == "text" or turn.user_saved or turn.failed):
            # Модель промолчала или отказала: шаблонный ответ, как у каскада, чтобы человек не остался без ответа.
            if not turn.failed or turn.kind == "text" or turn.user_saved:
                reply_turn = Turn(started=turn.started)
                self._jobs.put_nowait(lambda: self._reply(False, reply_turn))

    async def _on_closed(self, reason: str) -> None:
        logger.warning("gemini live closed dialog=%s: %s", self._dialog.id, reason)
        link, self._link = self._link, None
        if link is not None:
            link.closed = True
        turn = self._turn
        if turn is None or not turn.generating:
            return  # соединение закрылось между репликами (в том числе по GoAway): к следующей реплике откроем заново
        turn.failed = True
        if not self._unavailable_sent:
            self._unavailable_sent = True
            await self._send({"type": "error", "code": "VOICE_UNAVAILABLE", "message": "Голосовая модель недоступна"})
        await self._finish(turn)
