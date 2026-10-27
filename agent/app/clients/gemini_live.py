"""Gemini Live: речь в речь по WebSocket (SDK google-genai). Режим `VOICE_PIPELINE=gemini_live`.

Одна модель слушает, отвечает и говорит. Агент управляет границами реплики сам (ручной режим активности): начало и
конец реплики ему сообщает клиент (`audio_start` / `audio_end`), поэтому серверный VAD Google выключен.

Две вещи поверх этого:
  GeminiLiveConnector  открывает соединение (`LiveLink`) под нужный голос и инструкции
  GeminiLiveTts        озвучивает готовый текст (приветствие, кризисный ответ) тем же голосом дословно: модель просят
                       произнести фразу, не добавляя своего
"""

import asyncio
import logging
import re
import time
import weakref
from collections.abc import AsyncIterator, Sequence
from contextlib import AsyncExitStack
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal, Protocol

from app.clients.speech import TtsError, Voice
from app.core.config import GeminiSettings
from app.core.voices import GEMINI_VOICE_NAMES
from app.core.metrics import GEMINI_OPENS_TOTAL, GEMINI_SESSIONS_OPEN
from app.services import usage as model_usage
from app.services.gemini_budget import estimate_turn

if TYPE_CHECKING:
    from app.services.gemini_budget import TokenBudget
from app.core.reclaim import forget_cancellation

logger = logging.getLogger("agent.gemini")

LIVE_IN_MIME = "audio/pcm;rate=16000"
# Сколько озвучка фразы ждёт в фоне usage_metadata (он приходит с turn_complete, когда фраза «доиграна» у Google), потом закрывает соединение.
PHRASE_USAGE_WAIT_SECONDS = 15.0

EventKind = Literal[
    "input_text",
    "output_text",
    "audio",
    "generation_complete",
    "turn_complete",
    "interrupted",
    "go_away",  # Google скоро закроет соединение: пора переоткрыть его между репликами
    "usage",  # usage — токены хода (usage_metadata, ключи `_usage`); приходит вместе с turn_complete
    "closed",
]

# Прошлые реплики разговора для новой сессии: (кто, текст). Роль модели у Gemini — "model".
LiveHistory = Sequence[tuple[Literal["user", "model"], str]]


class LiveError(Exception):
    """Gemini Live не отвечает, отказал в доступе или закрыл соединение."""


_HTTP_429 = re.compile(r"\b429\b")


def is_quota_error(text: str) -> bool:
    """Отказ Google по квоте: соединение закрыто кодом 1011 с «You exceeded your current quota» (при открытии и посреди хода),
    RESOURCE_EXHAUSTED или 429. Сам код 1011 квотой не считается: им же Google закрывает соединение и по «Internal error
    encountered», и пауза после такой ошибки только задерживала ответы и прогрев озвучки."""
    lower = text.lower()
    return "quota" in lower or "resource_exhausted" in lower or _HTTP_429.search(lower) is not None


_OPEN_SESSIONS: "weakref.WeakSet[object]" = weakref.WeakSet()


def session_opened(link: object) -> None:
    """Сессия Gemini открыта: в метрике открытых сессий (agent_gemini_sessions_open)."""
    if link not in _OPEN_SESSIONS:
        _OPEN_SESSIONS.add(link)
        GEMINI_SESSIONS_OPEN.inc()


def session_closed(link: object) -> None:
    """Сессия закрыта нами или Google; повторный вызов для той же сессии ничего не меняет."""
    if link in _OPEN_SESSIONS:
        _OPEN_SESSIONS.discard(link)
        GEMINI_SESSIONS_OPEN.dec()


@dataclass(slots=True)
class LiveEvent:
    kind: EventKind
    text: str = ""
    data: bytes = b""
    usage: dict[str, int] | None = None


class LiveLink(Protocol):
    """Живое соединение с моделью под один голос."""

    voice: Voice
    voice_name: str  # имя голоса Google, с которым открыта сессия (Charon, Kore…): для журнала, чтобы смену голоса можно было разобрать
    closed: bool

    async def activity_start(self) -> None: ...

    async def send_audio(self, pcm: bytes) -> None:
        """PCM16, 16 кГц, моно."""
        ...

    async def activity_end(self) -> None: ...

    async def send_text(self, text: str) -> None:
        """Реплика человека текстом: модель отвечает на неё как на сказанную."""
        ...

    async def nudge(self) -> None:
        """Ответить сейчас на то, что уже есть в сессии, без новой реплики. Последней в сессии должна быть реплика человека
        без ответа: после готового ответа модель дописала бы к нему обрывок."""
        ...

    def events(self) -> AsyncIterator[LiveEvent]:
        """События модели до закрытия соединения; последнее — `closed`."""
        ...

    async def aclose(self) -> None: ...


class LiveConnector(Protocol):
    name: str
    model: str  # имя модели для учёта расхода

    async def open(self, voice: Voice, instructions: str, history: LiveHistory | None = None) -> LiveLink:
        """Новое соединение; с `history` — свежая сессия, в которую сразу загружены прошлые реплики текстом (модель на них
        не отвечает)."""
        ...

    async def aclose(self) -> None: ...


class GeminiLiveLink:
    def __init__(self, stack: AsyncExitStack, session, voice: Voice, voice_name: str = "") -> None:  # noqa: ANN001
        from google.genai import types

        self._types = types
        self._stack = stack
        self._session = session
        self.voice: Voice = voice
        self.voice_name = voice_name
        self.closed = False
        # Цикл в websockets (16.x): закрывая соединение, библиотека отменяет свою задачу keepalive и не забирает её
        # CancelledError. Задача держит исключение, его traceback — кадр keepalive() с self (соединением), а соединение —
        # задачу. Так каждое закрытое соединение с Gemini (TLS-буферы, заголовки, очереди) жило до полной сборки мусора, а
        # соединение здесь открывается на каждый ход. Забираем исключение сами; нет таких полей (SDK или websockets
        # устроены иначе) — ничего не делаем, остатки соберёт периодическая сборка (app/core/reclaim.py).
        keepalive = getattr(getattr(session, "_ws", None), "keepalive_task", None)
        if isinstance(keepalive, asyncio.Task):
            keepalive.add_done_callback(forget_cancellation)

    async def activity_start(self) -> None:
        await self._session.send_realtime_input(activity_start=self._types.ActivityStart())

    async def send_audio(self, pcm: bytes) -> None:
        await self._session.send_realtime_input(audio=self._types.Blob(data=pcm, mime_type=LIVE_IN_MIME))

    async def activity_end(self) -> None:
        await self._session.send_realtime_input(activity_end=self._types.ActivityEnd())

    async def send_text(self, text: str) -> None:
        turn = self._types.Content(role="user", parts=[self._types.Part(text=text)])
        await self._session.send_client_content(turns=turn, turn_complete=True)

    async def nudge(self) -> None:
        # client_content без реплик, но с turn_complete: «отвечай по накопленному». Проверено на gemini-3.8-live: сессия открыта
        # с историей, где последней идёт реплика человека, — модель отвечает на неё по сути (3 из 3). Сразу после голосовой
        # реплики так делать нельзя: модель теряет смысл сказанного.
        await self._session.send_client_content(turn_complete=True)

    async def events(self) -> AsyncIterator[LiveEvent]:
        try:
            while not self.closed:
                seen = False
                async for message in self._session.receive():
                    seen = True
                    for event in _translate(message):
                        yield event
                if not seen:  # receive() кончился, не принеся ни одного сообщения: соединение закрыто
                    break
        except asyncio.CancelledError:
            raise
        except Exception as error:  # noqa: BLE001
            self.closed = True
            yield LiveEvent("closed", text=f"{type(error).__name__}: {error}"[:200])
            return
        self.closed = True
        yield LiveEvent("closed", text="соединение закрыто")

    async def aclose(self) -> None:
        self.closed = True
        try:
            await self._stack.aclose()
        except Exception as error:  # noqa: BLE001
            logger.debug("закрытие Gemini Live: %s", error)


def live_config(
    settings: GeminiSettings,
    voice_name: str,
    instructions: str,
    history: bool = False,
    language_hint: bool = True,
):  # noqa: ANN201
    """Настройки сессии Gemini Live: голос, промпт, расшифровки, ручные границы реплик, сжатие контекста.

    `language_hint`: подсказка языка расшифровки речи человека (`GEMINI_INPUT_LANGUAGES`); короткое слово без неё
    расшифровывается чужим языком. Отключается только повтором открытия, если Google отверг само поле.

    `history`: сессия начинается с загрузки прошлых реплик текстом (client_content до первого ввода, без ответа модели).
    Сессия живёт несколько ходов, а контекст новой приходит текстом, поэтому возобновлять её по handle незачем: handle вернул
    бы накопленное аудио.
    """
    from google.genai import types as t

    languages = settings.input_language_codes if language_hint else []
    config = t.LiveConnectConfig(
        response_modalities=["AUDIO"],
        system_instruction=instructions,
        input_audio_transcription=t.AudioTranscriptionConfig(language_codes=languages or None),
        output_audio_transcription=t.AudioTranscriptionConfig(),
        speech_config=t.SpeechConfig(
            voice_config=t.VoiceConfig(prebuilt_voice_config=t.PrebuiltVoiceConfig(voice_name=voice_name))
        ),
        # Границы реплики задаёт клиент (audio_start/audio_end), а не VAD сервера.
        realtime_input_config=t.RealtimeInputConfig(
            automatic_activity_detection=t.AutomaticActivityDetection(disabled=True)
        ),
    )
    if settings.thinking_budget >= 0:
        config.thinking_config = t.ThinkingConfig(thinking_budget=settings.thinking_budget)
    config.context_window_compression = t.ContextWindowCompressionConfig(
        trigger_tokens=settings.compression_trigger_tokens or None,
        sliding_window=t.SlidingWindow(target_tokens=settings.compression_target_tokens or None),
    )
    if history:
        config.history_config = t.HistoryConfig(initial_history_in_client_content=True)
    return config


def _usage(meta) -> dict[str, int]:  # noqa: ANN001
    """Токены одного хода из usage_metadata: `{направление}_{модальность}` → токены.

    input — весь контекст хода (prompt, оплачивается заново каждый ход), output — ответ (response) и размышление (thoughts,
    оплачивается как выход). Модальности как у Google в нижнем регистре (text, audio); часть итога без разбивки — `other`,
    так что сумма по модальностям всегда равна итогу. Кэшированная часть входа (cached_content) входит в prompt и отдельно не
    считается.
    """
    usage: dict[str, int] = {}
    for direction, total, details in (
        ("input", meta.prompt_token_count, meta.prompt_tokens_details),
        ("output", meta.response_token_count, meta.response_tokens_details),
    ):
        counted = 0
        for item in details or []:
            modality = str(getattr(item.modality, "name", item.modality)).lower()
            if item.token_count:
                usage[f"{direction}_{modality}"] = usage.get(f"{direction}_{modality}", 0) + int(item.token_count)
                counted += int(item.token_count)
        if total and int(total) > counted:
            usage[f"{direction}_other"] = int(total) - counted
    if meta.thoughts_token_count:
        usage["output_thinking"] = int(meta.thoughts_token_count)
    return usage


def input_tokens(usage: dict[str, int]) -> int:
    """Весь контекст хода (input) из usage: сумма модальностей, как её считает Google в лимите токенов в минуту."""
    return sum(tokens for key, tokens in usage.items() if key.startswith("input_"))


def record_usage(model: str, task: str, usage: dict[str, int]) -> None:
    """Токены хода (ключи `_usage`) в учёт расхода (app/services/usage.py)."""
    for key, tokens in usage.items():
        direction, _, modality = key.partition("_")
        model_usage.record(model, task, direction, modality, "tokens", tokens)


def _translate(message) -> list[LiveEvent]:  # noqa: ANN001
    events: list[LiveEvent] = []
    if message.data:
        events.append(LiveEvent("audio", data=message.data))
    if message.usage_metadata is not None:
        usage = _usage(message.usage_metadata)
        if usage:
            events.append(LiveEvent("usage", usage=usage))
    if message.go_away is not None:
        events.append(LiveEvent("go_away", text=str(message.go_away.time_left or "")))
    content = message.server_content
    if content is None:
        return events
    if content.input_transcription and content.input_transcription.text:
        events.append(LiveEvent("input_text", text=content.input_transcription.text))
    if content.output_transcription and content.output_transcription.text:
        events.append(LiveEvent("output_text", text=content.output_transcription.text))
    if content.interrupted:
        events.append(LiveEvent("interrupted"))
    if content.generation_complete:
        events.append(LiveEvent("generation_complete"))
    if content.turn_complete:
        events.append(LiveEvent("turn_complete"))
    return events


class GeminiLiveConnector:
    name = "gemini-live"

    def __init__(self, settings: GeminiSettings) -> None:
        from google import genai
        from google.genai import types

        if settings.api_key is None:
            raise RuntimeError("VOICE_PIPELINE=gemini_live, но GEMINI_API_KEY не задан")
        self._types = types
        self._settings = settings
        self._model = settings.live_model
        self.model = settings.live_model
        self._voices: dict[Voice, str] = {"male": settings.voice_male, "female": settings.voice_female}
        self._timeout = settings.connect_timeout_seconds
        options = None
        if settings.base_url:
            headers = {"X-Relay-Token": settings.relay_token.get_secret_value()} if settings.relay_token else None
            options = types.HttpOptions(base_url=settings.base_url, headers=headers)
        self._client = genai.Client(api_key=settings.api_key.get_secret_value(), http_options=options)
        self.name = f"gemini-live:{self._model}"
        # Google может не принять подсказку языка (поле новое): тогда сессия открывается без неё, и голос не пропадает.
        self._language_hint = bool(settings.input_language_codes)

    async def open(self, voice: Voice, instructions: str, history: LiveHistory | None = None) -> GeminiLiveLink:
        try:
            return await self._open(voice, instructions, history, self._language_hint)
        except LiveError as error:
            if not self._language_hint or "language" not in str(error).lower():
                raise
            logger.warning("Gemini Live отверг подсказку языка расшифровки, сессии открываются без неё: %s", error)
            self._language_hint = False
            return await self._open(voice, instructions, history, False)

    async def _open(
        self,
        voice: Voice,
        instructions: str,
        history: LiveHistory | None,
        language_hint: bool,
    ) -> GeminiLiveLink:
        # Голос задаётся в каждой сессии. Род берёт настроенный голос, выбранное человеком имя из списка (app/core/voices.py) идёт как
        # есть; всё остальное — ошибка, а не молчаливая подмена.
        voice_name = self._voices[voice] if voice in self._voices else voice
        if voice not in self._voices and voice not in GEMINI_VOICE_NAMES:
            raise KeyError(voice)  # не род и не голос из списка: к Google не идём
        config = live_config(self._settings, voice_name, instructions, bool(history), language_hint)
        stack = AsyncExitStack()
        try:
            session = await asyncio.wait_for(
                stack.enter_async_context(self._client.aio.live.connect(model=self._model, config=config)),
                timeout=self._timeout,
            )
            if history:
                # Прошлые реплики текстом, модель на них не отвечает; следующим пойдёт ввод человека.
                turns = [
                    self._types.Content(role=role, parts=[self._types.Part(text=text)]) for role, text in history
                ]
                await asyncio.wait_for(session.send_client_content(turns=turns, turn_complete=True), timeout=self._timeout)
        except asyncio.CancelledError:
            await stack.aclose()  # смену сессии отменили на полпути: наполовину открытое соединение не оставляем
            raise
        except Exception as error:
            await stack.aclose()
            raise LiveError(f"Gemini Live не открылся: {type(error).__name__}: {str(error)[:200]}") from error
        return GeminiLiveLink(stack, session, voice, voice_name)

    async def aclose(self) -> None:
        return None


# ─── Озвучка готового текста ──────────────────────────────────────────────────

VERBATIM_INSTRUCTIONS = (
    "Ты — голос приложения «Слышу Рядом». Тебе дают фразу, и ты произносишь её дословно, по-русски, спокойным тёплым "
    "голосом, без своих слов, без вступлений и без добавлений."
)


class GeminiLiveTts:
    """Фиксированные фразы агента (приветствие, кризисный ответ) тем же голосом, каким модель отвечает в диалоге.

    Расход фразы (задача `phrase`) приходит с turn_complete, то есть через секунды после generation_complete: звук отдаётся
    сразу, а usage дочитывается в фоне (`_drain`), после чего соединение закрывается.

    С бюджетом (`GEMINI_TPM_LIMIT`): во время паузы после отказа Google по квоте фраза не озвучивается сразу, без
    подключения (`TtsError`), отказ по квоте при открытии или посреди фразы начинает паузу, а открытие сессии и токены
    фразы идут в окно, как у разговора.
    """

    def __init__(self, connector: LiveConnector, timeout_seconds: int = 30, budget: "TokenBudget | None" = None) -> None:
        self._connector = connector
        self._timeout = timeout_seconds
        self._budget = budget
        self.name = connector.name
        self._model = connector.model
        self._drains: set[asyncio.Task[None]] = set()

    def _quota(self, text: str) -> None:
        if self._budget is not None and is_quota_error(text):
            self._budget.on_quota_error("tts")

    async def synthesize(self, text: str, voice: Voice) -> bytes:
        budget = self._budget
        if budget is not None and budget.cooling():
            raise TtsError("Gemini Live: пауза после превышения квоты, фраза не озвучена")
        opening = budget.opening(budget.open_estimate([VERBATIM_INSTRUCTIONS])) if budget is not None else None
        began = time.monotonic()
        try:
            link = await self._connector.open(voice, VERBATIM_INSTRUCTIONS)
        except BaseException as error:
            if budget is not None:
                budget.cancel(opening)
            if not isinstance(error, LiveError):
                raise
            GEMINI_OPENS_TOTAL.labels("tts", "quota" if is_quota_error(str(error)) else "failed").inc()
            self._quota(str(error))
            raise TtsError(str(error)) from error
        GEMINI_OPENS_TOTAL.labels("tts", "ok").inc()
        # Озвучка фразы открывает свою сессию: тот же голос, что у разговора, виден в журнале (текст фразы не пишем, только размер).
        logger.info(
            "gemini live opened purpose=tts voice=%s voice_name=%s model=%s phrase_chars=%d ms=%.0f",
            voice,
            getattr(link, "voice_name", ""),
            self._model,
            len(text),
            (time.monotonic() - began) * 1000,
        )
        session_opened(link)
        request = f"Произнеси дословно, без добавлений: «{text}»"
        reserved = None
        if budget is not None:
            budget.opened(link, opening)
            reserved = budget.reserve(estimate_turn(request))
        pcm = bytearray()
        events = link.events()
        drain = False
        try:
            await link.send_text(request)
            async with asyncio.timeout(self._timeout):
                async for event in events:
                    if event.kind == "audio":
                        pcm += event.data
                    elif event.kind == "usage":
                        record_usage(self._model, "phrase", event.usage or {})
                        if budget is not None:
                            budget.settle_turn(link, reserved, input_tokens(event.usage or {}))
                            reserved = None
                    elif event.kind == "generation_complete":
                        drain = True  # usage ещё впереди
                        break
                    elif event.kind in ("turn_complete", "closed"):
                        if event.kind == "closed":
                            self._quota(event.text)
                        break
        except TimeoutError as error:
            raise TtsError("Gemini Live не договорил фразу вовремя") from error
        except Exception as error:  # noqa: BLE001
            raise TtsError(f"Gemini Live: {type(error).__name__}: {str(error)[:160]}") from error
        finally:
            if drain:
                task = asyncio.create_task(self._drain(link, events, reserved, estimate_turn(request)))
                self._drains.add(task)
                task.add_done_callback(self._drains.discard)
            else:
                session_closed(link)
                await link.aclose()
                if budget is not None and reserved is not None:
                    budget.settle(reserved, estimate_turn(request))  # usage не пришёл: токены фразы всё равно ушли
        if not pcm:
            raise TtsError("Gemini Live вернул пустое аудио")
        return bytes(pcm[: len(pcm) // 2 * 2])

    async def _drain(
        self, link: LiveLink, events: AsyncIterator[LiveEvent], reserved: int | None = None, fallback: int = 0
    ) -> None:
        """Дочитать usage фразы и закрыть соединение. Задача наследует приёмник расхода того, кто озвучивал (диалог или никто).

        Резерв бюджета (`reserved`) закрывается по usage, а если он не пришёл, оценкой `fallback`: токены фразы ушли в любом случае.
        """
        budget = self._budget
        try:
            async with asyncio.timeout(PHRASE_USAGE_WAIT_SECONDS):
                async for event in events:
                    if event.kind == "usage":
                        record_usage(self._model, "phrase", event.usage or {})
                        if budget is not None:
                            budget.settle_turn(link, reserved, input_tokens(event.usage or {}))
                            reserved = None
                    if event.kind in ("usage", "turn_complete", "closed"):
                        break
        except Exception as error:  # noqa: BLE001 - расход не дочитан, фраза уже отдана
            logger.info("расход фразы не получен: %s", type(error).__name__)
        finally:
            session_closed(link)
            await link.aclose()
            if budget is not None and reserved is not None:
                budget.settle(reserved, fallback)

    async def drained(self) -> None:
        """Дождаться, пока фоновое дочитывание расхода фраз закончит и закроет соединения (тесты и остановка)."""
        await asyncio.gather(*self._drains, return_exceptions=True)

    async def aclose(self) -> None:
        for task in list(self._drains):
            task.cancel()
        await asyncio.gather(*self._drains, return_exceptions=True)
        await self._connector.aclose()


def build_live(settings: GeminiSettings) -> LiveConnector:
    return GeminiLiveConnector(settings)
