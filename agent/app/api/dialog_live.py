"""WebSocket диалога в режиме `VOICE_PIPELINE=gemini_live`: речь в речь через Gemini Live.

Тот же протокол с клиентом, что у каскада (app/api/dialog_ws.py), но голос человека уходит прямо в Gemini Live, а ответ
(текст и звук) приходит от него же. Распознавания и чат-модели здесь нет. Остаётся общим: приветствие и кризисный ответ
(фиксированные фразы озвучивает тот же голос Gemini, дословно), перебивание, выбор голоса, сохранение диалога.

Границы реплики задаёт клиент (`audio_start`/`audio_end`): агент передаёт их модели как начало и конец активности.
Кризис проверяется на расшифровке реплики до того, как человек услышит или увидит хоть слово ответа: пока расшифровки
нет, ответ модели ждёт (`GEMINI_TRANSCRIPT_WAIT_MS`); при кризисе ответ модели выбрасывается, говорит фиксированный текст.

Нагрузка на Gemini (`GEMINI_TPM_*`, app/services/gemini_budget.py): ход ставит резерв в окно токенов перед тем, как модель
начнёт отвечать, usage хода заменяет его фактом; после отказа Google по квоте (1011) новые сессии не открываются, смена сессии
откладывается. При `GEMINI_TPM_ENFORCE` новый разговор при исчерпанном бюджете идёт в каскад (`admit_session`), а ход, которому
не хватило бюджета, — шаблон, озвученный без Gemini (`FallbackTurn`).
"""

import asyncio
import logging
import time
import uuid
from collections import deque
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from typing import Any, Literal

from fastapi import WebSocket

from app.api.deps import active_tts
from app.api.dialog_ws import (
    AUDIO_FRAME_SECONDS,
    FRAME_KIND_AUDIO_IN,
    MAX_AUDIO_BYTES,
    MAX_USER_TEXT,
    DialogSession,
    SpeechFeed,
    Turn,
    is_silence,
)
from app.clients.gemini_live import (
    LiveConnector,
    LiveEvent,
    LiveHistory,
    LiveLink,
    is_explicit_quota_error,
    is_quota_error,
    record_usage,
    session_closed,
    session_opened,
)
from app.clients.speech import CachedTts, TextToSpeech, TtsError, Voice, pcm_stream
from app.core.config import APP_CONFIG
from app.core.metrics import (
    GEMINI_ADMISSION_TOTAL,
    GEMINI_CONTEXT_REFRESH_SECONDS,
    GEMINI_CONTEXT_REFRESH_TOTAL,
    GEMINI_OPENS_TOTAL,
    GEMINI_TURNS_DEGRADED_TOTAL,
    VOICE_TURN_END_DELAY_SECONDS,
    VOICE_TURNS_TRUNCATED_TOTAL,
)
from app.services import usage as model_usage
from app.core.tracing import Observation, Tracer
from app.services.dialog_store import Dialog, DialogStore, Message
from app.services.gemini_budget import (
    ADMIT_OFF_LEVELS,
    DEFAULT_TURN_TOKENS,
    PCM_BYTES_PER_SECOND,
    CascadeFallback,
    TokenBudget,
    estimate_turn,
)
from app.services.replies import CRISIS_SAFETY_TEXT, SYSTEM_PROMPT, is_crisis, memory_block

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
    safety_counted: bool = False  # проверка безопасности этого хода уже засчитана как обращение
    user_saved: bool = False
    ended: bool = False  # реплика человека закончена (audio_end): с этого момента ждём ответ модели и считаем её молчание
    audio_seconds: float | None = None  # длительность голосовой реплики (от audio_start до audio_end)
    usage: list[model_usage.Usage] = field(default_factory=list)  # расход, пришедший раньше конца ответа (см. `_count_usage`)
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
    # Бюджет токенов Gemini (GEMINI_TPM_*):
    spoken: bool = False  # человек договорил (audio_end): с этого момента ход ждёт бюджет не дольше GEMINI_TPM_WAIT_MS
    sent_audio: int = 0  # байт звука реплики, ушедших модели (по ним оценка токенов хода)
    recording: bytearray | None = None  # звук реплики на случай, если её придётся разобрать каскадом (GEMINI_TPM_ENFORCE)
    offline: bool = False  # в начале реплики сессию открыть не дали (пауза после 1011): её разберёт каскад
    degraded: bool = False  # ход отдан шаблону без Gemini
    # Текст реплики человека для текстового хода (для голосового текст появляется в `heard`).
    input_text: str = ""
    # Трасса хода в Langfuse (app/core/tracing.py) и расход токенов для неё (приходит с turn_complete, позже конца генерации).
    # Не путать с `usage` выше: то расход для базы диалогов и метрик, это числа для трассы.
    trace: Observation | None = None
    trace_usage: dict[str, int] | None = None
    trace_ended: bool = False

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
        session_closed(link)
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


@dataclass
class FallbackTurn(Turn):
    """Ход, на который отвечает шаблон, озвученный без новой сессии Gemini (`_FallbackTts`): бюджет исчерпан или Gemini
    отказал при `GEMINI_TPM_ENFORCE`."""


class _FallbackTts:
    """Озвучка без Gemini: фраза из памяти основной озвучки (прогретые шаблоны и кризисный ответ тем же голосом Gemini), иначе
    запасной провайдер каскада (Qwen TTS)."""

    name = "fallback"

    def __init__(self, cached: CachedTts | None, spare: TextToSpeech | None) -> None:
        self._cached = cached
        self._spare = spare

    async def stream(self, text: str, voice: Voice) -> AsyncIterator[bytes]:
        pcm = self._cached.remembered(text, voice) if self._cached is not None else None
        if pcm is not None:
            yield pcm
            return
        if self._spare is None:
            raise TtsError("фразы нет в памяти, а озвучить её без Gemini нечем")
        async for piece in pcm_stream(self._spare, text, voice):
            yield piece

    async def synthesize(self, text: str, voice: Voice) -> bytes:
        return b"".join([piece async for piece in self.stream(text, voice)])

    async def aclose(self) -> None:
        return None


def admit_session(websocket: WebSocket, store: DialogStore, dialog: Dialog) -> DialogSession:
    """Сессия нового сокета в режиме gemini_live.

    При `GEMINI_TPM_ENFORCE` и бюджете на уровне admit_off и выше (или в паузе после 1011) весь разговор идёт в каскаде, если
    он собран целиком (чат, распознавание, озвучка): голос у человека не меняется посреди беседы, а идущие разговоры в Gemini
    не теряют бюджет. Каскада нет — разговор в Gemini, а ходы, которым не хватит бюджета, отдаются шаблону.
    """
    app = websocket.app
    budget: TokenBudget | None = app.state.budget
    fallback: CascadeFallback | None = app.state.fallback

    def spare_tts() -> TextToSpeech | None:
        return fallback.tts if fallback is not None and app.state.tts_mode == "auto" else None

    if budget is not None and budget.enabled:
        level = budget.level()
        if not budget.admits_live() and fallback is not None and fallback.can_converse:
            GEMINI_ADMISSION_TOTAL.labels("cascade").inc()
            logger.info("dialog admitted to cascade: gemini budget level=%s window=%d dialog=%s", level, budget.window_tokens(), dialog.id)
            return DialogSession(websocket, store, dialog, spare_tts, fallback.chat, fallback.recognizer, app.state.tracer)
        GEMINI_ADMISSION_TOTAL.labels("live").inc()
        if level in ADMIT_OFF_LEVELS:
            why = "no cascade fallback" if budget.enforcing else "measure only"
            logger.info("dialog admitted to gemini at budget level=%s (%s) dialog=%s", level, why, dialog.id)
    return LiveDialogSession(
        websocket,
        store,
        dialog,
        lambda: active_tts(app),
        app.state.live,
        budget=budget,
        fallback=fallback,
        spare_tts_source=spare_tts,
        tracer=app.state.tracer,
    )


class LiveDialogSession(DialogSession):
    def __init__(
        self,
        websocket: WebSocket,
        store: DialogStore,
        dialog: Dialog,
        tts_source,  # noqa: ANN001
        connector: LiveConnector,
        budget: TokenBudget | None = None,
        fallback: CascadeFallback | None = None,
        spare_tts_source: Callable[[], TextToSpeech | None] | None = None,
        tracer: Tracer | None = None,
    ) -> None:
        super().__init__(websocket, store, dialog, tts_source, None, None, tracer)
        self._pipeline = "gemini_live"
        self._connector = connector
        self._cfg = APP_CONFIG.gemini
        # Бюджет токенов Gemini (выключен, если сессию создали без приложения или GEMINI_TPM_LIMIT=0).
        self._budget = budget or TokenBudget.disabled()
        # Каскад как запасной путь (GEMINI_TPM_ENFORCE): распознаёт реплику, отданную шаблону; озвучка — для шаблонов без Gemini.
        self._recognizer = fallback.recognizer if fallback is not None else None
        self._spare_tts_source = spare_tts_source or (lambda: None)
        # Смена сессии ждёт следующего хода: ленивое открытие (GEMINI_LAZY_OPEN), пауза после 1011, нет места в бюджете или
        # новая сессия не открылась.
        self._rotate_pending = False
        self._preparing: asyncio.Task[Any] | None = None  # открытие, начатое, как только человек заговорил
        self._opened = 0  # сессий открыто за этот сокет: первая — purpose=start в метрике
        self._open_failures = 0
        self._usage_waiting: deque[tuple[LiveLink, int | None]] = deque()  # ходы, ушедшие модели и ждущие usage: (сессия, резерв)
        self._last_response = 0  # токенов в ответе прошлого хода: на той же сессии они лягут в контекст следующего
        self._last_prompt = 0  # input прошлого хода: резерв хода, когда открытие сессии не считается (OPEN_FACTOR=0)
        self._link_turns = 0  # ходов, уже отправленных на текущей сессии
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
        # Последний ход, отправленный модели целиком (конец реплики или текст): на его ответ пишется пришедший usage.
        self._usage_turn: LiveTurn | None = None
        # Сводка памяти, с которой открыта текущая сессия: изменилась (человек что-то забыл, выключил память, извлечение
        # добавило факт) — к следующему ходу сессия открывается заново с новой (MEM-8.4, MEM-13.3).
        self._brief_used = ""
        # Ход, чья трасса ждёт расход токенов (usage_metadata приходит с turn_complete, после конца генерации).
        self._awaiting_usage: LiveTurn | None = None

    # ─── трейсинг (Langfuse) ──────────────────────────────────────────────────

    def _end_turn_trace(self, turn: LiveTurn, *, wait_usage: bool = False) -> None:
        """Финализировать трассу хода: тексты, метаданные этапов, уровень. С `wait_usage` трасса остаётся
        открытой до прихода расхода токенов (или закроется следующим ходом / концом сессии)."""
        trace = turn.trace
        if trace is None or turn.trace_ended:
            return
        metadata: dict[str, Any] = {
            "kind": turn.kind,
            "interrupts": turn.interrupts,
            "discarded": turn.discarded,
            "failed": turn.failed,
            "audio_streamed": turn.audio is not None,
        }
        for name, at in turn.marks.items():
            metadata[f"ms_{name}"] = round((at - turn.started) * 1000)
        # Сами тексты в трассу не идут (LANGFUSE_TRACE_TEXT=false): остаются размеры реплик и длительность речи.
        said = turn.heard.strip() or turn.input_text
        metadata.update(
            user_chars=len(said), user_words=len(said.split()), reply_chars=len(turn.sent_text), reply_words=len(turn.sent_text.split())
        )
        if turn.audio_seconds is not None:
            metadata["audio_seconds"] = round(turn.audio_seconds, 2)
        level = "ERROR" if turn.failed else ("WARNING" if turn.discarded else None)
        status = None
        if turn.failed:
            status = "соединение с моделью оборвалось"
        elif turn.discarded:
            status = "ответ модели отброшен (тишина, эхо или кризис)"
        trace.update(
            input=turn.heard.strip() or turn.input_text or None,
            output=turn.sent_text or None,
            usage=turn.trace_usage,
            metadata=metadata,
            level=level,
            status=status,
        )
        if wait_usage and turn.trace_usage is None and not turn.failed and not turn.discarded:
            self._awaiting_usage = turn
            return
        trace.end()
        turn.trace_ended = True
        if self._awaiting_usage is turn:
            self._awaiting_usage = None

    def _attribute_usage(self, usage: dict[str, int]) -> None:
        """Расход токенов к ходу: действующему, а если генерация уже кончилась — ждущему закрытия."""
        target = self._turn if (self._turn is not None and self._turn.generating) else self._awaiting_usage
        if target is None:
            return
        target.trace_usage = {**(target.trace_usage or {}), **usage}
        if self._awaiting_usage is target:
            self._end_turn_trace(target)

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
        ]
        if not self._cfg.lazy_open:  # соединение готово к первой реплике (лениво — откроется по audio_start или сообщению)
            self._tasks.append(asyncio.create_task(self._ensure_link()))
        try:
            await super().run()
        finally:
            # Отменённая задача держит CancelledError, а его traceback — кадр с self: ссылка сеанса на свои задачи замыкается в цикл,
            # и сеанс со всем, что в нём (сокет, очереди звука, ходы), ждал бы полной сборки мусора. Поэтому ссылки на задачи
            # отпускаются до ожидания, а соединение с моделью закрывается даже если само ожидание отменят.
            tasks = [*self._tasks]
            for extra in (self._rotation, self._preparing):
                if extra is not None:
                    tasks.append(extra)
            self._tasks, self._rotation, self._preparing = [], None, None
            for task in tasks:
                task.cancel()
            try:
                await asyncio.gather(*tasks, return_exceptions=True)
            finally:
                for turn in (self._turn, self._voice_turn):
                    if turn is not None:
                        self._disarm_all(turn)
                for turn in (self._turn, self._voice_turn, self._usage_turn):
                    if turn is not None:
                        self._settle_usage(turn)  # ход не закончен, а расход уже есть: не терять
                for turn in (self._turn, self._voice_turn, self._awaiting_usage):
                    if turn is not None:
                        self._end_turn_trace(turn)  # сокет закрыт: трассы не остаются висеть открытыми
                self._awaiting_usage = None
                self._release_link()

    def _history(self) -> list[tuple[Literal["user", "model"], str]]:
        """Последние сообщения диалога для новой сессии: (кто, текст). История начинается с реплики человека, подряд
        идущие реплики одного автора склеены (так модель принимает её без ошибок)."""
        messages = list(self._dialog.messages)
        while messages and messages[-1].role == "user":  # это реплика, которую сейчас отправим
            messages.pop()
        limit = self._cfg.history_messages
        tight = self._cfg.history_messages_tight
        if tight and self._budget.trims_history():  # окно токенов подходит к лимиту: история короче
            limit = min(limit, tight) if limit else tight
        if limit:
            messages = messages[-limit:]
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
        # Память — из кэша процесса, без диска и сети (I3); пустая сводка — ни правил, ни блока.
        self._brief_used = self._store.memory_brief(self._dialog)
        text = SYSTEM_PROMPT + LIVE_ADDENDUM + memory_block(self._brief_used)
        if history:
            lines = [("Человек" if role == "user" else "Ты") + ": " + message for role, message in history]
            text += "\n\nУже сказано в этом разговоре (продолжай, не здоровайся заново):\n" + "\n".join(lines)
        return text

    # ─── соединение ───────────────────────────────────────────────────────────

    async def _ensure_link(self, rotate: bool = False) -> LiveLink | None:
        """Живое соединение с моделью. `rotate`: сменить его на свежее с текстовой историей, если человек ещё не заговорил.

        С бюджетом (`GEMINI_TPM_LIMIT`): в паузе после 1011 (и при ENFORCE без места в окне) смена откладывается до следующего
        хода, а живая прежняя сессия закрывается только после того, как открылась новая (не открылась — ход идёт на прежней,
        смена повторится позже). Отложенная или ленивая (`GEMINI_LAZY_OPEN`) смена делается здесь же, в начале хода.
        """
        async with self._link_lock:
            link = self._link
            voice = self._dialog.voice
            budget = self._budget
            if rotate:
                if self._turn is not None or self._voice_turn is not None:
                    return link  # новый ход уже начался: сессию сменим после его ответа
                if not self._link_used:
                    return link  # на этой сессии ход ещё не вёлся: менять нечего (и цепочка смен невозможна)
                if not self._may_open():
                    # Пауза после 1011 (или нет места в окне): новую сессию сейчас не открывать, смена ждёт следующего хода,
                    # а пока работает прежняя.
                    self._rotate_pending = True
                    GEMINI_CONTEXT_REFRESH_TOTAL.labels("deferred").inc()
                    logger.info("live context refresh deferred: level=%s dialog=%s", budget.level(), self._dialog.id)
                    return link
                self._refresh = True
            if self._store.memory_brief(self._dialog, count=False) != self._brief_used:
                self._refresh = True  # память изменилась: новая сессия с новой сводкой (или без неё)
            alive = link is not None and not link.closed and link.voice == voice
            if alive and self._rotate_pending and not self._refresh and self._may_open():
                self._refresh = True  # отложенная (или ленивая) смена сессии: теперь можно
            # Сюда приходят в начале нового хода (прошлый ответ к этому моменту уже закрыт `_begin`).
            if alive and not self._refresh:
                return link
            voice_changed = link is not None and link.voice != voice
            purpose = (
                "voice" if voice_changed else "rotate" if rotate or self._rotate_pending else "reconnect" if self._opened else "start"
            )
            keep = budget.enabled and alive  # с бюджетом прежнюю сессию закрываем, только когда откроется новая
            if not keep:
                await self._drop_link()
            self._refresh = False
            if voice_changed:
                self._resume_handle = None  # голос у сессии один на всё соединение: новый голос — новая сессия
            # При text_context контекст приходит текстом, возобновлять сессию по handle (вместе с её аудио) не нужно.
            handle = self._resume_handle if self._cfg.session_resumption and not self._cfg.text_context else None
            new = await self._open(voice, handle, purpose)
            if new is None and handle is not None:
                # Handle не принят (устарел, сессия закрыта): начинаем заново, а контекст даём последними сообщениями.
                self._resume_handle = None
                new = await self._open(voice, None, purpose)
            if new is None:
                if keep:
                    self._rotate_pending = True  # новая не открылась: ход идёт на прежней, смена повторится к следующему
                    return link
                return None
            if keep:
                await self._drop_link()
            self._rotate_pending = False
            self._link = new
            self._link_used = False
            self._link_turns = 0
            self._reader = asyncio.create_task(self._read(new))
            return new

    async def _open(self, voice: Voice, handle: str | None, purpose: str = "start") -> LiveLink | None:
        budget = self._budget
        history: LiveHistory | None = self._history() if self._cfg.text_context and handle is None else None
        instructions = self._instructions(resumed=handle is not None)
        cost = budget.open_estimate([instructions, *(text for _, text in history or ())])
        if not self._may_open(cost):
            # Пауза после 1011 (открытие заведомо получит тот же отказ) или, при ENFORCE, открытие не помещается в окно.
            logger.info(
                "gemini live open skipped dialog=%s purpose=%s level=%s cost=%d cooldown_ms=%d",
                self._dialog.id,
                purpose,
                budget.level(),
                cost,
                budget.cooldown_left() * 1000,
            )
            return None
        trace = self._tracer.start_turn(
            name="gemini_session_open",
            session_id=self._dialog.id,
            user_id=self._dialog.user_id,
            model=self._cfg.live_model,
            metadata={
                "resumed": handle is not None,
                "history_messages": len(history or []),
                "voice": voice,
                "purpose": purpose,
            },
            tags=[self._pipeline],
        )
        rid = budget.opening(cost)  # Google считает открытие сразу, по размеру контекста
        began = time.monotonic()
        try:
            link = await self._connector.open(voice, instructions, handle, history or None)
        except BaseException as error:
            budget.cancel(rid)
            if not isinstance(error, Exception):
                trace.update(level="WARNING", status="открытие отменено")
                trace.end()
                raise  # отмена (сокет закрылся посреди смены сессии)
            text = str(error)
            quota = is_quota_error(text)
            GEMINI_OPENS_TOTAL.labels(purpose, "quota" if quota else "failed").inc()
            self._open_failures += 1
            trace.update(level="ERROR", status=text[:200])
            trace.end()
            logger.warning(
                "gemini live not available dialog=%s purpose=%s voice=%s resume=%s: %s",
                self._dialog.id,
                purpose,
                voice,
                handle is not None,
                error,
            )
            if quota:
                budget.on_quota_error("open", self._dialog.id, calibrate=is_explicit_quota_error(text))
            return None
        trace.end()
        budget.opened(link, rid)
        GEMINI_OPENS_TOTAL.labels(purpose, "ok").inc()
        session_opened(link)
        self._opened += 1
        # Какой голос запрошен у Google в каждой сессии: если человеку показалось, что голос сменился, это видно здесь
        # (purpose: start, rotate, reconnect, voice). Тексты реплик в строку не попадают.
        logger.info(
            "gemini live opened dialog=%s purpose=%s voice=%s voice_name=%s model=%s resumed=%s history_messages=%d ms=%.0f",
            self._dialog.id,
            purpose,
            voice,
            getattr(link, "voice_name", ""),
            self._cfg.live_model,
            handle is not None,
            len(history or ()),
            (time.monotonic() - began) * 1000,
        )
        if handle is not None:
            logger.info("gemini live session resumed dialog=%s", self._dialog.id)
        return link

    def _schedule_rotation(self) -> None:
        if self._rotation is None or self._rotation.done():
            self._rotation = asyncio.create_task(self._rotate())

    def _defer_rotation(self) -> None:
        """Ленивое открытие (GEMINI_LAZY_OPEN): ответ дозвучал, но новую сессию не открываем сразу. Она нужна, только если человек
        заговорит или напишет, а открытие стоит квоты (Google считает его при подключении). Смена — по audio_start (за его речью)
        или по набранному сообщению (`_ensure_link` увидит `_rotate_pending`)."""
        if not self._link_used:
            return
        self._rotate_pending = True
        if self._audio_open and self._may_open():
            self._prepare_link()  # человек заговорил, пока дозвучивал прошлый ответ

    async def _rotate(self) -> None:
        """Ответ договорён и озвучен (turn_complete): меняем сессию на свежую, где прошлые реплики лежат текстом, а не
        аудио. Идёт в фоне, пока человек думает; если он заговорил раньше, смена откладывается до следующего ответа."""
        before, started, failures = self._link, time.monotonic(), self._open_failures
        link = await self._ensure_link(rotate=True)
        if link is before and (not self._budget.enabled or self._open_failures == failures):
            return  # менять было нечего или смена отложена
        seconds = time.monotonic() - started
        if link is None or link is before:  # с бюджетом прежняя сессия осталась: новая не открылась
            GEMINI_CONTEXT_REFRESH_TOTAL.labels("failed").inc()
            logger.warning("live context refresh failed dialog=%s ms=%d", self._dialog.id, seconds * 1000)
            return
        GEMINI_CONTEXT_REFRESH_TOTAL.labels("ok").inc()
        GEMINI_CONTEXT_REFRESH_SECONDS.observe(seconds)
        logger.info(
            "live context refreshed dialog=%s history_messages=%d ms=%d", self._dialog.id, len(self._history()), seconds * 1000
        )

    def _count_usage(self, usage: dict[str, int], link: LiveLink | None = None) -> None:
        """Токены хода из usage_metadata: input — весь контекст хода (оплачивается заново каждый ход), output — ответ.

        Пишутся на ответ модели последнего отправленного ей хода. Если ответа-сообщения нет (модель промолчала, расшифровки
        ответа нет) или usage пришёл не по ходу, — на диалог. Usage разбирается сразу при чтении, а события ответа ждут своей
        очереди (`_pump`), поэтому, пока ход не закончен, расход ждёт на самом ходе и пишется в `_finish`, когда ответ уже есть.

        С бюджетом ход засчитывается в окне по факту: max(его резерв, input − уже учтённый контекст этой сессии), см.
        app/services/gemini_budget.py.
        """
        turn = self._usage_turn
        with model_usage.collect() as spent:
            record_usage(self._connector.model, "live", usage)
        if turn is not None and turn.generating:
            turn.usage.extend(spent)
        else:
            self._store.add_usage(self._dialog, turn.message_id if turn is not None else None, spent)
        total = {direction: sum(v for k, v in usage.items() if k.startswith(direction + "_")) for direction in ("input", "output")}
        logger.info(
            "live usage dialog=%s input=%d(text=%d audio=%d) output=%d(audio=%d text=%d thinking=%d)",
            self._dialog.id,
            total["input"],
            usage.get("input_text", 0),
            usage.get("input_audio", 0),
            total["output"],
            usage.get("output_audio", 0),
            usage.get("output_text", 0),
            usage.get("output_thinking", 0),
        )
        if self._budget.enabled:
            self._budget.settle_turn(link, self._take_reservation(link), total["input"])
            # Ответ модели, который войдёт в контекст следующего хода на этой же сессии; размышление в контекст не попадает.
            self._last_response = total["output"] - usage.get("output_thinking", 0)
            self._last_prompt = total["input"]

    # ─── бюджет токенов ───────────────────────────────────────────────────────

    def _estimate(self, turn: LiveTurn | None = None, text: str | None = None, opening: bool = False) -> int:
        """Резерв хода. Открытие сессии считается отдельно, поэтому ход резервирует только приращение: надбавку Google, текст
        или звук реплики, а на сессии, где ход уже был, ещё и прошлый ответ модели. `opening`: ход откроет новую сессию.

        Открытие не считается (`GEMINI_TPM_OPEN_FACTOR=0`) — ход платит за весь контекст: input прошлого хода или 2 500.
        """
        seconds = turn.sent_audio / PCM_BYTES_PER_SECOND if turn is not None and turn.kind == "voice" else None
        if not self._budget.counts_open:
            return estimate_turn(text, seconds, self._last_prompt or DEFAULT_TURN_TOKENS)
        reused = self._link_turns > 0 and not opening
        return estimate_turn(text, seconds, self._last_response if reused else 0)

    def _open_estimate(self) -> int:
        """Сколько квоты съест новая сессия этого диалога сейчас: промпт и история, байты / 4 × GEMINI_TPM_OPEN_FACTOR."""
        if not self._budget.enabled:
            return 0
        brief = memory_block(self._store.memory_brief(self._dialog, count=False))  # сводка памяти тоже уходит в сессию
        return self._budget.open_estimate([SYSTEM_PROMPT + LIVE_ADDENDUM + brief, *(text for _, text in self._history())])

    def _may_open(self, cost: int | None = None) -> bool:
        """Новую сессию можно открывать: нет паузы после 1011 и, при ENFORCE, открытие помещается в окно."""
        budget = self._budget
        if not budget.enabled:
            return True
        if budget.cooling():
            return False
        return not budget.enforcing or budget.fits(self._open_estimate() if cost is None else cost)

    def _wait_left(self, turn: LiveTurn) -> float:
        """Сколько ещё ход может ждать бюджет: GEMINI_TPM_WAIT_MS от конца реплики или от набранного сообщения."""
        return max(0.0, turn.started + self._cfg.tpm_wait_ms / 1000 - time.monotonic())

    def _needs_open(self) -> bool:
        """Ходу не обойтись без новой сессии: живой нет или голос сменился."""
        link = self._link
        return link is None or link.closed or link.voice != self._dialog.voice

    def _will_open(self) -> bool:
        """Ход откроет новую сессию: без неё не обойтись или ждёт смена (GoAway, кризис, отложенная, ленивая), которую сейчас
        можно сделать (иначе ход пойдёт на прежней)."""
        return self._needs_open() or ((self._refresh or self._rotate_pending) and self._may_open())

    async def _wait_open(self, turn: LiveTurn) -> bool:
        """Ходу нужна новая сессия, а открывать её нельзя (пауза после 1011, при ENFORCE — нет места в окне): пока человек
        говорит, ждём (этого не слышно, сказанное копится в очереди), после конца реплики или набранного сообщения — ещё не
        дольше GEMINI_TPM_WAIT_MS. True — можно открывать."""
        while not self._may_open():
            if (turn.kind == "text" or turn.spoken) and self._wait_left(turn) <= 0:
                return False
            await asyncio.sleep(0.05)
        return True

    def _track(self, link: LiveLink, rid: int | None) -> None:
        """Ход ушёл модели по этой сессии: его резерв заменит usage, который придёт от неё же."""
        if self._budget.enabled:
            self._usage_waiting = deque(item for item in self._usage_waiting if not item[0].closed)
            self._usage_waiting.append((link, rid))

    def _take_reservation(self, link: LiveLink | None) -> int | None:
        for index, (owner, rid) in enumerate(self._usage_waiting):
            if owner is link:
                del self._usage_waiting[index]
                return rid
        return None

    def _reply_turn(self, started: float | None, degraded: bool = False) -> Turn:
        """Ход шаблонного (или кризисного) ответа: отданный шаблону и, при ENFORCE, любой без ответа модели звучит без Gemini."""
        if degraded or self._budget.enforcing:
            return FallbackTurn(started=started)
        return Turn(started=started)

    def _fallback_tts(self) -> TextToSpeech | None:
        main = self._tts_source()  # None, если озвучку выключили (dev-переключатель)
        cached = main if isinstance(main, CachedTts) else None
        spare = self._spare_tts_source()
        if cached is None and spare is None:
            return None
        return _FallbackTts(cached, spare)

    def _start_speech(self, message_id: str, turn: Turn | None) -> SpeechFeed | None:
        if isinstance(turn, FallbackTurn):
            tts = self._fallback_tts()
            return None if tts is None else self._speech_with(tts, message_id, turn)
        return super()._start_speech(message_id, turn)

    async def _degrade(self, turn: LiveTurn) -> None:
        """Ход отдаётся шаблону без Gemini (GEMINI_TPM_ENFORCE): окно у лимита или пауза после 1011, ждать дольше нельзя."""
        reason = "cooldown" if self._budget.cooling() else "hard"
        GEMINI_TURNS_DEGRADED_TOTAL.labels(reason).inc()
        logger.warning(
            "live turn degraded dialog=%s kind=%s reason=%s window=%d reserved=%d limit=%d",
            self._dialog.id,
            turn.kind,
            reason,
            self._budget.window_tokens(),
            self._budget.reserved_tokens(),
            self._budget.limit(),
        )
        if turn.kind == "voice" and not turn.offline:
            # В сессии осталась начатая реплика без конца: такая сессия не нужна, следующий ход откроет новую.
            async with self._link_lock:
                self._release_link()
        self._events.put_nowait(("degraded", turn))

    async def _on_degraded(self, turn: LiveTurn) -> None:
        """Ход без Gemini: набранному сообщению — шаблон; голосовую реплику разбирает каскад (распознавание, кризис, шаблон)."""
        if not turn.generating:
            return  # ход уже закрыт: его перебила новая реплика
        turn.degraded = True
        await self._finish(turn)
        if turn.kind == "voice":
            pcm = bytes(turn.recording or b"")
            frames = max(1, round(len(pcm) / PCM_BYTES_PER_SECOND / AUDIO_FRAME_SECONDS))
            reply_turn = self._reply_turn(turn.started, degraded=True)
            # Метод каскада, а не `self._voice_turn`: это имя здесь занято текущей голосовой репликой.
            self._jobs.put_nowait(lambda: DialogSession._voice_turn(self, frames, pcm, turn.interrupts, reply_turn))

    def _prepare_link(self) -> None:
        """Отложенная смена сессии начинается, как только человек заговорил: открытие прячется за его речью."""
        if self._preparing is None or self._preparing.done():
            self._preparing = asyncio.create_task(self._ensure_link())

    # ─── соединение: закрытие и чтение ────────────────────────────────────────

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
                self._count_usage(event.usage or {}, link)
            # В очередь уходит и usage: атрибуция к ходу в Langfuse идёт в `_handle` по порядку событий.
            self._events.put_nowait((link, event))

    async def _send_loop(self) -> None:
        """Команды модели строго по порядку: начало активности, кадры звука, конец активности, текст.

        С бюджетом (GEMINI_TPM_LIMIT) ход ставит резерв в окно токенов перед тем, как модель начнёт отвечать: набранное
        сообщение — перед отправкой, голос — перед концом реплики (пока человек говорит, модель не отвечает). При ENFORCE ход
        ждёт места в окне не дольше GEMINI_TPM_WAIT_MS, иначе отдаётся шаблону без Gemini.
        """
        while True:
            command = await self._out.get()
            kind = command[0]
            try:
                if kind == "text":
                    await self._send_text(command[1], command[2])
                elif kind == "start":
                    await self._start_activity(command[1])
                else:
                    link = self._link
                    if kind == "end" and command[1].offline:
                        await self._degrade(command[1])  # реплика так и не дошла до Gemini: её разберёт каскад
                        continue
                    if link is None or link.closed:
                        continue
                    if kind == "audio":
                        await link.send_audio(command[1])
                    elif kind == "end":
                        await self._end_activity(link, command[1])
            except asyncio.CancelledError:
                raise
            except Exception as error:  # noqa: BLE001
                logger.warning("gemini live send failed dialog=%s: %s", self._dialog.id, error)
                self._events.put_nowait((self._link, LiveEvent("closed", text=str(error)[:200])))

    async def _send_text(self, text: str, turn: LiveTurn) -> None:
        rid = None
        if self._budget.enabled:
            if not self._budget.enforcing and self._needs_open():
                await self._wait_open(turn)  # пауза после 1011: без сессии ход не обойдётся, ждём не дольше GEMINI_TPM_WAIT_MS
            opening = self._will_open()  # ход потянет за собой открытие сессии, и его квота тоже должна поместиться
            extra = self._open_estimate() if opening else 0
            rid = await self._budget.acquire(self._estimate(text=text, opening=opening), self._wait_left(turn), extra)
            if rid is None:  # только при ENFORCE: бюджета так и не нашлось
                await self._degrade(turn)
                return
        link = await self._ensure_link()
        if link is None:
            self._budget.cancel(rid)
            if self._budget.enforcing and not self._may_open():
                await self._degrade(turn)  # сессию открыть не дали (окно или пауза после 1011): шаблон без Gemini
                return
            self._events.put_nowait((None, LiveEvent("closed", text="не удалось открыть Gemini Live")))
            return
        self._link_used = True  # с этого момента на соединении есть ход
        self._usage_turn = turn  # на его ответ пишется пришедший usage
        try:
            await link.send_text(text)
        except Exception:
            self._budget.cancel(rid)
            raise
        self._link_turns += 1
        self._track(link, rid)
        turn.mark("sent")

    async def _start_activity(self, turn: LiveTurn) -> None:
        if self._budget.enabled and self._needs_open() and not self._may_open():
            await self._wait_open(turn)
        link = await self._ensure_link()
        if link is None:
            if self._budget.enforcing and not self._may_open():
                turn.offline = True  # сессию открыть не дали: на конце реплики её разберёт каскад
                return
            self._events.put_nowait((None, LiveEvent("closed", text="не удалось открыть Gemini Live")))
            return
        self._link_used = True  # с этого момента на соединении есть ход
        await link.activity_start()

    async def _end_activity(self, link: LiveLink, turn: LiveTurn) -> None:
        rid = None
        if self._budget.enabled:
            rid = await self._budget.acquire(self._estimate(turn), self._wait_left(turn))
            if rid is None:  # только при ENFORCE
                await self._degrade(turn)
                return
            if link is not self._link or link.closed:  # пока ход ждал, сессия закрылась: ход уже отказал (_on_closed)
                self._budget.cancel(rid)
                return
        self._usage_turn = turn  # на его ответ пишется пришедший usage
        try:
            await link.activity_end()
        except Exception:
            self._budget.cancel(rid)
            raise
        self._link_turns += 1
        self._track(link, rid)
        turn.mark("sent")

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
                    case "degraded":
                        await self._on_degraded(item[1])
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
        if self._cfg.lazy_open or self._budget.enabled:
            # Человек заговорил: отложенную (ленивую) смену сессии или первое открытие делаем сейчас, за его речью.
            wanted = self._rotate_pending or self._refresh or (self._cfg.lazy_open and self._needs_open())
            if wanted and self._may_open():
                self._prepare_link()

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
            if self._budget.enforcing:
                turn.recording = bytearray()  # реплику, возможно, придётся разобрать каскадом
            self._voice_turn = turn
            self._events.put_nowait(("begin", turn))
            self._out.put_nowait(("start", turn))
            for piece in self._pre:
                self._forward(piece)
            self._pre = []
        self._forward(pcm)

    def _forward(self, pcm: bytes) -> None:
        if self._sent_bytes >= MAX_AUDIO_BYTES:
            return
        self._sent_bytes += len(pcm)
        turn = self._voice_turn
        if turn is not None:
            turn.sent_audio += len(pcm)
            if turn.recording is not None:
                turn.recording += pcm
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
        if turn is not None:
            turn.audio_seconds = round(self._audio_frames * AUDIO_FRAME_SECONDS, 3)
        self._audio_open, self._audio_frames, self._audio = False, 0, bytearray()
        self._last_voiced, self._turn_interrupts = None, False
        self._voice_turn, self._pre, self._act_started = None, [], False
        if turn is None:  # речи в записи не было
            self._count_false_interruption(interrupts)
            await self._send({"type": "transcript", "text": "", "final": True})
            return
        turn.started = time.monotonic()
        turn.spoken = True
        self._events.put_nowait(("ended", turn))
        self._out.put_nowait(("end", turn))

    def _dispatch_text_turn(self, text: str, crisis: bool, turn: Turn) -> None:
        if crisis:  # кризис говорит фиксированный текст, модель в этот путь не входит
            self._refresh_after_crisis()
            super()._dispatch_text_turn(text, crisis, turn)
            return
        live_turn = LiveTurn(kind="text", opened=True, started=turn.started)
        live_turn.user_saved = True
        live_turn.input_text = text
        self._events.put_nowait(("begin", live_turn))
        self._out.put_nowait(("text", text, live_turn))

    # ─── ход ──────────────────────────────────────────────────────────────────

    async def _begin(self, turn: LiveTurn) -> None:
        prev = self._turn
        if prev is not None and prev is not turn and prev.generating:
            # Новая реплика перебивает идущий ответ; его хвост, ещё летящий от модели, не наш.
            self._stale_until = time.monotonic() + STALE_SECONDS
            await self._finish(prev)
        awaiting = self._awaiting_usage
        if awaiting is not None and awaiting is not turn:
            self._end_turn_trace(awaiting)  # расход токенов так и не пришёл: закрываем без него
        turn.trace = self._tracer.start_turn(
            name=f"live_turn_{turn.kind}",
            session_id=self._dialog.id,
            user_id=self._dialog.user_id,
            model=self._cfg.live_model,
            input=turn.input_text or None,
            metadata={"kind": turn.kind, "interrupts": turn.interrupts},
            tags=[self._pipeline, f"v{APP_CONFIG.app.version}"],
        )
        self._turn = turn
        self._touch(turn)

    def _on_ended(self, turn: LiveTurn) -> None:
        self._stale_until = 0.0
        turn.ended = True
        self._touch(turn)

    def _arm(self, turn: LiveTurn, name: str, delay: float) -> None:
        self._disarm(turn, name)

        def fire() -> None:
            # Сработавший таймер уже не взведён: убираем его из хода сразу. Иначе ручка таймера (через это замыкание она
            # ссылается на ход) осталась бы в turn.timers, и ход со звуком в нём держал бы сам себя циклом до полной сборки
            # мусора. Перевзвод всегда снимает прежний таймер, так что здесь в turn.timers лежит именно эта ручка.
            turn.timers.pop(name, None)
            self._events.put_nowait(("timer", turn, name))

        turn.timers[name] = self._loop.call_later(delay, fire)

    @staticmethod
    def _disarm(turn: LiveTurn, name: str) -> None:
        handle = turn.timers.pop(name, None)
        if handle is not None:
            handle.cancel()

    def _disarm_all(self, turn: LiveTurn) -> None:
        for name in list(turn.timers):
            self._disarm(turn, name)

    def _touch(self, turn: LiveTurn) -> None:
        """Ход жив, пока от модели что-то приходит: иначе через GEMINI_IDLE_TIMEOUT_SECONDS он закрывается.

        Пока человек говорит, модель молчит, и таймер не идёт: иначе реплика длиннее GEMINI_IDLE_TIMEOUT_SECONDS (15 с, а в рассказе
        «выговориться» это обычное дело) закрывалась бы посреди речи, и ответа на неё не было бы вовсе. Предел длины самой реплики
        держит VOICE_TURN_MAX_SECONDS, а оборванное соединение закрывает сокет.

        Законченному ходу (модель отказала раньше, чем человек договорил) таймер не нужен: `_on_timer` его всё равно не
        слушает, а взведённый таймер держал бы ход и сеанс после конца разговора.
        """
        if not turn.generating or (turn.kind == "voice" and not turn.ended):
            return
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
        if kind == "usage":
            self._attribute_usage(event.usage or {})
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
            if self._cfg.lazy_open:
                self._defer_rotation()  # ленивое открытие: новую сессию открываем, когда она понадобится
            else:
                self._schedule_rotation()  # ответ дозвучал, человек ещё молчит: самое время сменить сессию
            return
        if turn is None:
            return
        self._touch(turn)
        if kind == "input_text":
            turn.mark("in_first")
            turn.mark("in_last", True)
            turn.heard += event.text
            if not turn.discarded:
                self._count_safety(turn)
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
            self._count_safety(turn)
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
        message = self._store.add_message(self._dialog, "user", heard[:MAX_USER_TEXT], audio_seconds=turn.audio_seconds)
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
        self._store.mark_crisis(self._dialog)  # извлечение памяти из такого разговора пропускается (I13)
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
        reply_turn = self._reply_turn(turn.started)
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

    def _count_safety(self, turn: LiveTurn) -> None:
        """Реплику проверяют по мере расшифровки, много раз; обращением засчитывается проверка хода, один раз."""
        if not turn.safety_counted:
            turn.safety_counted = True
            model_usage.call("safety")

    async def _finish(self, turn: LiveTurn) -> None:
        if not turn.generating:
            return
        turn.generating = False
        # Ход ушёл модели и закончился: одно обращение (речь в речь, отдельных распознавания и озвучки здесь нет).
        model_usage.call("live", "error" if turn.failed else "ok")
        self._disarm_all(turn)
        if self._turn is turn:
            self._turn = None
        if not turn.opened and not turn.discarded and not turn.degraded:
            # Ответа от модели не было: реплику всё равно надо сохранить, а человеку ответить.
            # (Реплику, отданную каскаду, сохранит и покажет он сам: `_on_degraded`.)
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
                reply_turn = self._reply_turn(turn.started, degraded=turn.degraded)
                self._jobs.put_nowait(lambda: self._reply(False, reply_turn))
        self._settle_usage(turn)
        self._end_turn_trace(turn, wait_usage=True)

    def _settle_usage(self, turn: LiveTurn) -> None:
        """Расход, пришедший раньше конца хода, — на ответ модели (если он стал сообщением), иначе на диалог."""
        if turn.usage:
            spent, turn.usage = turn.usage, []
            self._store.add_usage(self._dialog, turn.message_id, spent)

    async def _on_closed(self, reason: str) -> None:
        logger.warning("gemini live closed dialog=%s: %s", self._dialog.id, reason)
        link, self._link = self._link, None
        if link is not None:
            link.closed = True
            session_closed(link)
        if is_quota_error(reason):
            self._budget.on_quota_error("session", self._dialog.id, calibrate=is_explicit_quota_error(reason))
        turn = self._turn
        if turn is None or not turn.generating:
            return  # соединение закрылось между репликами (в том числе по GoAway): к следующей реплике откроем заново
        turn.failed = True
        if not self._unavailable_sent:
            self._unavailable_sent = True
            await self._send({"type": "error", "code": "VOICE_UNAVAILABLE", "message": "Голосовая модель недоступна"})
        await self._finish(turn)
