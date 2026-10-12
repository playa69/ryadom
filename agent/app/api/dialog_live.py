"""WebSocket диалога в режиме `VOICE_PIPELINE=gemini_live`: речь в речь через Gemini Live.

Тот же протокол с клиентом, что у каскада (app/api/dialog_ws.py), но голос человека уходит прямо в Gemini Live, а ответ
(текст и звук) приходит от него же. Остаётся общим: приветствие и кризисный ответ (фиксированные фразы озвучивает тот же
голос Gemini, дословно), перебивание, выбор голоса, сохранение диалога.

Границы реплики задаёт клиент (`audio_start`/`audio_end`): агент передаёт их модели как начало и конец активности.
Кризис проверяется на расшифровке реплики до того, как человек услышит или увидит хоть слово ответа: пока расшифровки
нет, ответ модели ждёт (`GEMINI_TRANSCRIPT_WAIT_MS`); при кризисе ответ модели выбрасывается, говорит фиксированный текст.

Откат на каскад (`GEMINI_FALLBACK`). Gemini не открылся, оборвался до ответа, не ответил за `GEMINI_FIRST_OUTPUT_TIMEOUT_SECONDS`
или разомкнут размыкатель (app/services/breaker.py) — тогда именно эту реплику обрабатывает каскад: запись голоса (она
сохраняется на время реплики) распознаёт whisper, ответ пишет чат-модель, говорит Qwen; без настроенного каскада отвечает
шаблон. Человек этого не замечает, кроме смены голоса; ошибки он не получает. Если Gemini уже начал отвечать и оборвался
посреди ответа, ответ договаривается без повторов, и клиент получает один `error VOICE_UNAVAILABLE`.
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
from app.clients.gemini_live import LiveConnector, LiveEvent, LiveLink
from app.clients.llm import ChatModel, Recognizer
from app.clients.speech import TextToSpeech, Voice
from app.core.config import APP_CONFIG
from app.core.metrics import (
    GEMINI_EVENTS_TOTAL,
    GEMINI_RESUME_TOTAL,
    GEMINI_TOKENS_TOTAL,
    LIVE_STAGE_SECONDS,
    LIVE_TRANSCRIPT_RECOVERY_TOTAL,
    LIVE_TURNS_DROPPED_TOTAL,
    PIPELINE_FALLBACK_TOTAL,
    PIPELINE_REPLIES_TOTAL,
    VOICE_TURN_END_DELAY_SECONDS,
    VOICE_TURNS_TRUNCATED_TOTAL,
)
from app.services.breaker import CircuitBreaker
from app.services.dialog_store import Dialog, DialogStore, Message
from app.services.replies import CRISIS_SAFETY_TEXT, SYSTEM_PROMPT, is_crisis

logger = logging.getLogger("agent.live")

# Сколько мс тишины перед началом речи уходит модели вместе с ней (кадры по 100 мс): начало слова не обрезается.
PRE_ROLL_FRAMES = 5
# Хвост ответа прерванной модели, которая ещё может прислать события, считается чужим столько секунд.
STALE_SECONDS = 1.0
# Причины отката, которые считаются сбоем Gemini для размыкателя (breaker_open — следствие, не причина).
FAILURE_REASONS = frozenset({"connect_failed", "send_failed", "link_closed", "first_output_timeout"})

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
    discarded: bool = False  # эхо, тишина, кризис или откат на каскад: ответ модели выбрасывается
    generating: bool = True
    got_output: bool = False
    failed: bool = False
    user_saved: bool = False
    via_cascade: bool = False  # Gemini для этой реплики даже не пробуем (размыкатель разомкнут)
    fallback: bool = False  # реплика передана каскаду
    recovery: str = ""  # итог восстановления расшифровки каскадом: recovered | empty | failed | unavailable
    pcm: bytearray = field(default_factory=bytearray)  # запись голоса реплики: нужна каскаду при откате
    frames: int = 0
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
        chat: ChatModel | None = None,
        recognizer: Recognizer | None = None,
        cascade_tts_source=None,  # noqa: ANN001
        breaker: CircuitBreaker | None = None,
    ) -> None:
        # chat и recognizer — запасной каскад (если настроен): им отвечает базовый класс, когда Gemini не ответил.
        super().__init__(websocket, store, dialog, tts_source, chat, recognizer)
        self._connector = connector
        self._cfg = APP_CONFIG.gemini
        self._breaker = breaker
        self._cascade_tts_source = cascade_tts_source
        self._cascade_reply = False  # идёт ответ, написанный каскадом (чат или шаблон): говорит голос каскада
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
        self._open_voice: LiveTurn | None = None  # голосовая реплика, которую человек говорит прямо сейчас
        self._unavailable_sent = False
        # Handle последней сессии Gemini: по нему соединение возобновляется с тем же контекстом разговора.
        self._resume_handle: str | None = None
        # Google предупредил, что скоро закроет соединение: между репликами переоткрываем его заранее.
        self._refresh = False
        self._speech_turns: dict[str, LiveTurn] = {}
        self._usage_seen: dict[str, int] = {}

    # ─── метки конвейера для метрик и озвучка ────────────────────────────────

    def _reply_pipeline(self, crisis: bool) -> str:
        return "gemini_live" if crisis else "cascade"  # фиксированный кризисный текст говорит голос Gemini

    def _first_sound_pipeline(self, message_id: str) -> str:
        return "gemini_live" if message_id in self._speech_turns else "cascade"

    async def _reply(self, crisis: bool, turn: Turn | None = None) -> None:
        # Ответ, написанный не Gemini (чат каскада или шаблон), говорит голос каскада; кризисный текст остаётся голосом Gemini.
        self._cascade_reply = not crisis
        try:
            await super()._reply(crisis, turn)
        finally:
            self._cascade_reply = False

    def _start_speech(self, message_id: str, turn: Turn | None) -> SpeechFeed | None:
        tts: TextToSpeech | None = None
        if self._cascade_reply and self._cascade_tts_source is not None:
            tts = self._cascade_tts_source()
        tts = tts or self._tts_source()
        if tts is None:
            return None
        feed = SpeechFeed()
        task = asyncio.create_task(self._speak(tts, message_id, feed.chunks, self._dialog.voice, turn))
        self._speech_tasks.add(task)
        self._speeches[message_id] = task
        task.add_done_callback(self._speech_tasks.discard)
        task.add_done_callback(lambda done: self._forget_speech(message_id, done))
        return feed

    def _first_sound(self, message_id: str, turn: Turn | None) -> None:
        """Первый звук ответа ушёл клиенту: кроме общей задержки пишем, из каких этапов она сложилась."""
        super()._first_sound(message_id, turn)
        live_turn = self._speech_turns.pop(message_id, None)
        if live_turn is not None:
            live_turn.mark("tts_start")
            for stage in ("in_first", "out_first", "gate", "tts_start"):
                if stage in live_turn.marks:
                    LIVE_STAGE_SECONDS.labels(stage).observe(live_turn.marks[stage] - live_turn.started)
            logger.info("live timeline dialog=%s kind=%s ms: %s", self._dialog.id, live_turn.kind, live_turn.timeline())

    # ─── жизненный цикл ───────────────────────────────────────────────────────

    async def run(self) -> None:
        loop = asyncio.get_running_loop()
        self._loop = loop
        self._tasks = [
            asyncio.create_task(self._send_loop()),
            asyncio.create_task(self._pump()),
        ]
        if self._gemini_blocked():
            logger.info("gemini breaker is %s: connection not pre-opened dialog=%s", self._breaker.state if self._breaker else "-", self._dialog.id)
        else:
            self._tasks.append(asyncio.create_task(self._ensure_link()))  # соединение готово к первой реплике
        try:
            await super().run()
        finally:
            for task in self._tasks:
                task.cancel()
            await asyncio.gather(*self._tasks, return_exceptions=True)
            for turn in (self._turn, self._open_voice):
                if turn is not None:
                    self._disarm_all(turn)
            self._release_link()

    def _gemini_blocked(self) -> bool:
        """Размыкатель разомкнут: Gemini для новых реплик не пробуем, они идут в каскад (если откат разрешён)."""
        return self._cfg.fallback and self._breaker is not None and not self._breaker.allow()

    def _instructions(self, resumed: bool = False) -> str:
        """Промпт агента и, при новом соединении посреди диалога, последние сообщения: модель не начинает с чистого листа.

        Возобновлённая по handle сессия помнит разговор сама (в том числе сжатый Google): текст ей не дублируем.
        """
        history = list(self._dialog.messages)
        while history and history[-1].role == "user":  # это реплика, которую сейчас отправим
            history.pop()
        history = history[-self._cfg.history_messages :] if self._cfg.history_messages and not resumed else []
        text = SYSTEM_PROMPT + LIVE_ADDENDUM
        if history:
            lines = [("Человек" if m.role == "user" else "Ты") + ": " + m.text for m in history]
            text += "\n\nУже сказано в этом разговоре (продолжай, не здоровайся заново):\n" + "\n".join(lines)
        return text

    # ─── соединение ───────────────────────────────────────────────────────────

    async def _ensure_link(self) -> LiveLink | None:
        async with self._link_lock:
            link = self._link
            voice = self._dialog.voice
            # Сюда приходят в начале нового хода (прошлый ответ к этому моменту уже закрыт `_begin`).
            if link is not None and not link.closed and link.voice == voice and not self._refresh:
                return link
            voice_changed = link is not None and link.voice != voice
            await self._drop_link()
            self._refresh = False
            if voice_changed:
                self._resume_handle = None  # голос у сессии один на всё соединение: новый голос — новая сессия
            handle = self._resume_handle if self._cfg.session_resumption else None
            link = await self._open(voice, handle)
            if link is None and handle is not None:
                # Handle не принят (устарел, сессия закрыта): начинаем заново, а контекст даём последними сообщениями.
                self._resume_handle = None
                GEMINI_RESUME_TOTAL.labels("rejected").inc()
                link = await self._open(voice, None)
            elif link is not None:
                GEMINI_RESUME_TOTAL.labels("resumed" if handle is not None else "fresh").inc()
            if link is None:
                return None
            self._link = link
            self._reader = asyncio.create_task(self._read(link))
            return link

    async def _open(self, voice: Voice, handle: str | None) -> LiveLink | None:
        try:
            link = await self._connector.open(voice, self._instructions(resumed=handle is not None), handle)
        except Exception as error:  # noqa: BLE001
            logger.warning(
                "gemini live not available dialog=%s resume=%s reason=%s: %s",
                self._dialog.id,
                handle is not None,
                getattr(error, "reason", "other"),
                error,
            )
            return None
        if handle is not None:
            logger.info("gemini live session resumed dialog=%s", self._dialog.id)
        return link

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
            self._events.put_nowait((link, event))

    async def _send_loop(self) -> None:
        """Команды модели строго по порядку: начало активности, кадры звука, конец активности, текст."""
        while True:
            command = await self._out.get()
            kind = command[0]
            owner: LiveTurn | None = command[-1] if isinstance(command[-1], LiveTurn) else None
            try:
                if kind in ("start", "text"):
                    link = await self._ensure_link()
                    if link is None:
                        self._events.put_nowait(("fail", owner, "connect_failed"))
                        continue
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
                self._events.put_nowait(("fail", owner or self._turn, "send_failed"))

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
                    case "fail":
                        if item[1] is not None:
                            await self._fallback(item[1], item[2])
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
        self._open_voice = None

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
            self._open_voice = turn
            if self._gemini_blocked():
                turn.via_cascade = True  # размыкатель разомкнут: запись копится только для каскада
            else:
                self._events.put_nowait(("begin", turn))
                self._out.put_nowait(("start", turn))
            for piece in self._pre:
                self._forward(piece)
            self._pre = []
        self._forward(pcm)

    def _forward(self, pcm: bytes) -> None:
        turn = self._open_voice
        if self._sent_bytes >= MAX_AUDIO_BYTES:
            return
        self._sent_bytes += len(pcm)
        if self._sent_bytes >= MAX_AUDIO_BYTES:
            VOICE_TURNS_TRUNCATED_TOTAL.inc()
            logger.warning("voice turn reached the limit dialog=%s", self._dialog.id)
        if turn is not None:
            turn.pcm += pcm  # копия для каскада на случай отката (не длиннее предела реплики)
            turn.frames += 1
            if turn.via_cascade:
                return
        self._out.put_nowait(("audio", pcm))

    async def _on_audio_end(self) -> None:
        if not self._audio_open:
            return
        interrupts = self._turn_interrupts
        if self._last_voiced is not None:
            VOICE_TURN_END_DELAY_SECONDS.observe(time.monotonic() - self._last_voiced)
        turn = self._open_voice
        self._audio_open, self._audio_frames, self._audio = False, 0, bytearray()
        self._last_voiced, self._turn_interrupts = None, False
        self._open_voice, self._pre, self._act_started = None, [], False
        if turn is None:  # речи в записи не было
            self._count_false_interruption(interrupts)
            LIVE_TURNS_DROPPED_TOTAL.labels("silence").inc()
            await self._send({"type": "transcript", "text": "", "final": True})
            return
        turn.started = time.monotonic()
        if turn.via_cascade:
            await self._fallback(turn, "breaker_open")
            return
        self._events.put_nowait(("ended", turn))
        self._out.put_nowait(("end", turn))

    def _dispatch_text_turn(self, text: str, crisis: bool, turn: Turn) -> None:
        if crisis:  # кризис говорит фиксированный текст, модель в этот путь не входит
            super()._dispatch_text_turn(text, crisis, turn)
            return
        if self._gemini_blocked():  # размыкатель разомкнут: отвечает каскад (чат-модель или шаблон)
            PIPELINE_FALLBACK_TOTAL.labels("breaker_open").inc()
            logger.warning("fallback dialog=%s kind=text reason=breaker_open -> cascade", self._dialog.id)
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
        if turn.kind == "text":
            self._arm_first_output(turn)

    def _on_ended(self, turn: LiveTurn) -> None:
        self._stale_until = 0.0
        self._touch(turn)
        self._arm_first_output(turn)

    def _arm_first_output(self, turn: LiveTurn) -> None:
        """Gemini должен начать отвечать за GEMINI_FIRST_OUTPUT_TIMEOUT_SECONDS, иначе реплика уходит каскаду."""
        if self._cfg.fallback:
            self._arm(turn, "first", self._cfg.first_output_timeout_seconds)

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
                if turn.kind == "voice" and not turn.heard.strip():
                    await self._recover_transcript(turn)
                await self._open_gate(turn)
        elif name == "first":
            if not turn.got_output:
                await self._fallback(turn, "first_output_timeout")
        elif name == "idle":
            logger.warning("live turn timed out dialog=%s", self._dialog.id)
            await self._finish(turn)

    async def _recover_transcript(self, turn: LiveTurn) -> None:
        """Gemini уже отвечает, а расшифровки реплики нет: слова человека не должны пропасть. Запись распознаёт whisper каскада."""
        if self._recognizer is None or not turn.pcm or is_silence(bytes(turn.pcm)):
            turn.recovery = "unavailable" if self._recognizer is None else "empty"
        else:
            try:
                text = await asyncio.wait_for(
                    self._recognizer.transcribe(bytes(turn.pcm)), timeout=self._cfg.transcript_recovery_seconds
                )
            except Exception as error:  # noqa: BLE001
                logger.warning("transcript recovery failed dialog=%s: %s", self._dialog.id, error)
                turn.recovery = "failed"
            else:
                turn.heard = (text or "").strip()
                turn.recovery = "recovered" if turn.heard else "empty"
        LIVE_TRANSCRIPT_RECOVERY_TOTAL.labels(turn.recovery).inc()
        logger.info("transcript recovery dialog=%s result=%s", self._dialog.id, turn.recovery)

    async def _handle(self, event: LiveEvent) -> None:
        turn = self._turn
        kind = event.kind
        if kind == "closed":
            await self._on_closed(event.text)
            return
        if kind == "usage":
            self._count_usage(event.usage or {})
            return
        if kind == "resumption":
            self._resume_handle = event.text
            GEMINI_EVENTS_TOTAL.labels("resumption_handle").inc()
            return
        if kind == "go_away":
            logger.info("gemini live go_away dialog=%s time_left=%s", self._dialog.id, event.text)
            GEMINI_EVENTS_TOTAL.labels("go_away").inc()
            self._refresh = True  # переоткроем между репликами, с возобновлением сессии
            return
        if kind == "interrupted":
            GEMINI_EVENTS_TOTAL.labels("interrupted").inc()
            self._stale_until = 0.0
            if turn is not None and turn.got_output:
                await self._finish(turn)
            return
        if kind != "input_text" and time.monotonic() < self._stale_until:
            if kind in ("generation_complete", "turn_complete"):
                self._stale_until = 0.0
            return  # хвост прерванного ответа
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
            if not turn.got_output and self._breaker is not None:
                self._breaker.record_success()  # Gemini жив: он начал отвечать
            turn.got_output = True
            self._disarm(turn, "first")
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

    def _count_usage(self, usage: dict[str, int]) -> None:
        """Расход токенов по usage_metadata: итоги сессии приходят нарастающим счётом, в метрику идут приращения (приблизительно)."""
        for key, value in usage.items():
            delta = value - self._usage_seen.get(key, 0)
            if delta < 0:  # счётчик сессии обнулился (новое соединение)
                delta = value
            self._usage_seen[key] = value
            if delta <= 0:
                continue
            if key == "total":
                GEMINI_TOKENS_TOTAL.labels("total", "all").inc(delta)
            else:
                direction, _, modality = key.partition("_")
                GEMINI_TOKENS_TOTAL.labels(direction, modality).inc(delta)

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
                reason = "echo" if heard else ("transcript_missing" if turn.recovery in ("unavailable", "failed") else "silence")
                LIVE_TURNS_DROPPED_TOTAL.labels(reason).inc()
                logger.info("live turn dropped dialog=%s reason=%s", self._dialog.id, reason)
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

    async def _crisis(self, turn: LiveTurn) -> None:
        """Кризис: ответ модели не звучит и не показывается, вместо него фиксированный текст (как в каскаде)."""
        if turn.discarded:
            return
        turn.discarded = True
        turn.opened = True
        turn.held.clear()
        self._disarm(turn, "gate")
        self._disarm(turn, "first")
        if turn.assistant_started:
            self._cancel_speech(turn.message_id)  # ответ уже пошёл: обрываем звук, текст дописан не будет
        if turn.kind == "voice" and not turn.user_saved and turn.heard.strip():
            await self._save_voice(turn, turn.heard.strip())
        await self._send({"type": "safety", "text": CRISIS_SAFETY_TEXT})
        self._supersede_speech()
        reply_turn = Turn(started=turn.started)
        self._jobs.put_nowait(lambda: self._reply(True, reply_turn))

    # ─── откат на каскад ──────────────────────────────────────────────────────

    async def _fallback(self, turn: LiveTurn, reason: str) -> None:
        """Gemini не ответил на эту реплику: отвечает каскад (запись распознаёт whisper, ответ пишет чат-модель, говорит Qwen)."""
        if turn.fallback or turn.discarded or turn.got_output:
            return
        turn.fallback = True
        turn.discarded = True  # если Gemini всё же что-то пришлёт позже, это выбрасывается
        turn.generating = False
        turn.held.clear()
        self._disarm_all(turn)
        if self._turn is turn:
            self._turn = None
        if self._breaker is not None and reason in FAILURE_REASONS:
            self._breaker.record_failure(reason)
        if not self._cfg.fallback:
            await self._fail_without_fallback(turn, reason)
            return
        PIPELINE_FALLBACK_TOTAL.labels(reason).inc()
        logger.warning(
            "fallback dialog=%s kind=%s reason=%s -> %s",
            self._dialog.id,
            turn.kind,
            reason,
            "cascade" if self._chat is not None else "template",
        )
        if reason != "breaker_open":
            # Старое соединение может прислать ответ позже и испортить следующий ход: закрываем его, следующая реплика откроет новое
            # (контекст вернётся последними сообщениями диалога, они уже включают ответ каскада).
            self._resume_handle = None
            await self._drop_link()
        if turn.kind == "voice":
            pcm, frames = bytes(turn.pcm), turn.frames
            self._jobs.put_nowait(lambda: self._cascade_voice(turn, frames, pcm))
        else:
            reply_turn = Turn(started=turn.started)
            self._jobs.put_nowait(lambda: self._reply(False, reply_turn))

    async def _cascade_voice(self, turn: LiveTurn, frames: int, pcm: bytes) -> None:
        # Голосовая реплика каскадом: распознавание, проверка на кризис, удержание оборванной фразы и ответ, как без Gemini.
        await self._voice_turn(frames, pcm, turn.interrupts, Turn(started=turn.started))

    async def _fail_without_fallback(self, turn: LiveTurn, reason: str) -> None:
        """GEMINI_FALLBACK=false: каскад не используется, человеку сообщается об ошибке (как раньше)."""
        turn.failed = True
        logger.warning("gemini unavailable dialog=%s kind=%s reason=%s fallback=off", self._dialog.id, turn.kind, reason)
        if not self._unavailable_sent:
            self._unavailable_sent = True
            await self._send({"type": "error", "code": "VOICE_UNAVAILABLE", "message": "Голосовая модель недоступна"})
        if turn.kind == "text" or turn.heard.strip():
            if turn.kind == "voice":
                await self._save_voice(turn, turn.heard.strip())
            reply_turn = Turn(started=turn.started)
            self._jobs.put_nowait(lambda: self._reply(False, reply_turn))
        elif turn.kind == "voice":
            await self._send({"type": "transcript", "text": "", "final": True})

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
            PIPELINE_REPLIES_TOTAL.labels("gemini_live", "gemini").inc()
            logger.info(
                "reply dialog=%s pipeline=gemini_live source=gemini ms=%d chars=%d",
                self._dialog.id,
                (time.monotonic() - turn.started) * 1000,
                len(turn.sent_text),
            )
        if not turn.assistant_started and not turn.discarded and (turn.kind == "text" or turn.user_saved or turn.failed):
            # Модель промолчала или отказала: ответ каскада (чат-модель или шаблон), чтобы человек не остался без ответа.
            if not turn.failed or turn.kind == "text" or turn.user_saved:
                reply_turn = Turn(started=turn.started)
                self._jobs.put_nowait(lambda: self._reply(False, reply_turn))

    async def _on_closed(self, reason: str) -> None:
        logger.warning("gemini live closed dialog=%s: %s", self._dialog.id, reason)
        GEMINI_EVENTS_TOTAL.labels("closed").inc()
        link, self._link = self._link, None
        if link is not None:
            link.closed = True
        turn = self._turn
        if turn is None or not turn.generating:
            return  # соединение закрылось между репликами (в том числе по GoAway): к следующей реплике откроем заново
        if not turn.got_output and self._cfg.fallback:
            await self._fallback(turn, "link_closed")  # до ответа: реплику передаём каскаду, человек ошибки не увидит
            return
        turn.failed = True
        if self._breaker is not None:
            self._breaker.record_failure("link_closed")
        if not self._unavailable_sent:
            self._unavailable_sent = True
            await self._send({"type": "error", "code": "VOICE_UNAVAILABLE", "message": "Голосовая модель недоступна"})
        await self._finish(turn)
