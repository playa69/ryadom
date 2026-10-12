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
import time
from collections.abc import AsyncIterator
from contextlib import AsyncExitStack
from dataclasses import dataclass
from typing import Literal, Protocol

from app.clients.speech import TtsError, Voice
from app.core.config import GeminiSettings
from app.core.metrics import GEMINI_ACTIVE_LINKS, GEMINI_CONNECT_FAILURES_TOTAL, GEMINI_CONNECT_SECONDS

logger = logging.getLogger("agent.gemini")

LIVE_IN_MIME = "audio/pcm;rate=16000"

EventKind = Literal[
    "input_text",
    "output_text",
    "audio",
    "generation_complete",
    "turn_complete",
    "interrupted",
    "resumption",  # text — handle, по которому сессию можно возобновить после обрыва
    "go_away",  # Google скоро закроет соединение: пора переоткрыть его между репликами
    "usage",  # итоги токенов сессии (usage_metadata), только для метрик расхода
    "closed",
]


class LiveError(Exception):
    """Gemini Live не отвечает, отказал в доступе или закрыл соединение. `reason` — для метрик и журнала (без деталей)."""

    def __init__(self, message: str, reason: str = "other") -> None:
        super().__init__(message)
        self.reason = reason


def classify_error(error: BaseException) -> str:
    """Причина отказа одним словом: location | auth | quota | timeout | network | other (в метрику идёт только оно)."""
    text = f"{type(error).__name__} {error}".lower()
    if "location is not supported" in text or "user location" in text:
        return "location"
    if "api key" in text or "permission" in text or "403" in text or "401" in text or "1007" in text or "unauthenticated" in text:
        return "auth"
    if "quota" in text or "429" in text or "resource_exhausted" in text or "rate" in text and "limit" in text:
        return "quota"
    if "timeout" in text or "timed out" in text:
        return "timeout"
    if any(w in text for w in ("connect", "dns", "name or service", "refused", "reset", "unreachable", "ssl", "closed", "eof")):
        return "network"
    return "other"


def scrub(text: str, *secrets: str | None) -> str:
    """Убрать из текста ошибки секреты (ключ, токен релея), прежде чем писать его в журнал."""
    for secret in secrets:
        if secret and len(secret) >= 8:
            text = text.replace(secret, "<скрыто>")
    return text


@dataclass(slots=True)
class LiveEvent:
    kind: EventKind
    text: str = ""
    data: bytes = b""
    usage: "dict[str, int] | None" = None  # для kind="usage": приращения токенов не считаем здесь, это текущие итоги сессии


class LiveLink(Protocol):
    """Живое соединение с моделью под один голос."""

    voice: Voice
    closed: bool

    async def activity_start(self) -> None: ...

    async def send_audio(self, pcm: bytes) -> None:
        """PCM16, 16 кГц, моно."""
        ...

    async def activity_end(self) -> None: ...

    async def send_text(self, text: str) -> None:
        """Реплика человека текстом: модель отвечает на неё как на сказанную."""
        ...

    def events(self) -> AsyncIterator[LiveEvent]:
        """События модели до закрытия соединения; последнее — `closed`."""
        ...

    async def aclose(self) -> None: ...


class LiveConnector(Protocol):
    name: str

    async def open(self, voice: Voice, instructions: str, resume_handle: str | None = None) -> LiveLink:
        """Новое соединение; с `resume_handle` — продолжение прежней сессии (контекст разговора остаётся у Google)."""
        ...

    async def aclose(self) -> None: ...


class GeminiLiveLink:
    def __init__(self, stack: AsyncExitStack, session, voice: Voice) -> None:  # noqa: ANN001
        from google.genai import types

        self._types = types
        self._stack = stack
        self._session = session
        self.voice: Voice = voice
        self.closed = False
        self._released = False
        GEMINI_ACTIVE_LINKS.inc()

    async def activity_start(self) -> None:
        await self._session.send_realtime_input(activity_start=self._types.ActivityStart())

    async def send_audio(self, pcm: bytes) -> None:
        await self._session.send_realtime_input(audio=self._types.Blob(data=pcm, mime_type=LIVE_IN_MIME))

    async def activity_end(self) -> None:
        await self._session.send_realtime_input(activity_end=self._types.ActivityEnd())

    async def send_text(self, text: str) -> None:
        turn = self._types.Content(role="user", parts=[self._types.Part(text=text)])
        await self._session.send_client_content(turns=turn, turn_complete=True)

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
        if not self._released:
            self._released = True
            GEMINI_ACTIVE_LINKS.dec()
        try:
            await self._stack.aclose()
        except Exception as error:  # noqa: BLE001
            logger.debug("закрытие Gemini Live: %s", error)


def live_config(settings: GeminiSettings, voice_name: str, instructions: str, resume_handle: str | None = None):  # noqa: ANN201
    """Настройки сессии Gemini Live: голос, промпт, расшифровки, ручные границы реплик, сжатие контекста, возобновление."""
    from google.genai import types as t

    config = t.LiveConnectConfig(
        response_modalities=["AUDIO"],
        system_instruction=instructions,
        input_audio_transcription=t.AudioTranscriptionConfig(),
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
    if settings.compression:
        config.context_window_compression = t.ContextWindowCompressionConfig(
            trigger_tokens=settings.compression_trigger_tokens or None,
            sliding_window=t.SlidingWindow(target_tokens=settings.compression_target_tokens or None),
        )
    if settings.session_resumption:
        config.session_resumption = t.SessionResumptionConfig(handle=resume_handle)
    return config


def _usage(meta) -> dict[str, int]:  # noqa: ANN001
    """Итоги токенов из usage_metadata: input/output по модальностям и total. Пусто, если метаданных нет."""
    if meta is None:
        return {}
    out: dict[str, int] = {}
    if meta.total_token_count:
        out["total"] = int(meta.total_token_count)
    for prefix, details in (("input", meta.prompt_tokens_details), ("output", meta.response_tokens_details)):
        for item in details or []:
            modality = str(getattr(item.modality, "value", item.modality) or "").lower()
            kind = "audio" if "audio" in modality else "text" if "text" in modality else "other"
            if item.token_count:
                out[f"{prefix}_{kind}"] = out.get(f"{prefix}_{kind}", 0) + int(item.token_count)
    return out


def _translate(message) -> list[LiveEvent]:  # noqa: ANN001
    events: list[LiveEvent] = []
    if message.data:
        events.append(LiveEvent("audio", data=message.data))
    update = message.session_resumption_update
    if update is not None and update.resumable and update.new_handle:
        events.append(LiveEvent("resumption", text=update.new_handle))
    if message.go_away is not None:
        events.append(LiveEvent("go_away", text=str(message.go_away.time_left or "")))
    usage = _usage(message.usage_metadata)
    if usage:
        events.append(LiveEvent("usage", usage=usage))
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
        self._voices: dict[Voice, str] = {"male": settings.voice_male, "female": settings.voice_female}
        self._timeout = settings.connect_timeout_seconds
        options = None
        if settings.base_url:
            headers = {"X-Relay-Token": settings.relay_token.get_secret_value()} if settings.relay_token else None
            options = types.HttpOptions(base_url=settings.base_url, headers=headers)
        self._client = genai.Client(api_key=settings.api_key.get_secret_value(), http_options=options)
        self.name = f"gemini-live:{self._model}"

    async def open(self, voice: Voice, instructions: str, resume_handle: str | None = None) -> GeminiLiveLink:
        config = live_config(self._settings, self._voices[voice], instructions, resume_handle)
        stack = AsyncExitStack()
        started = time.monotonic()
        try:
            session = await asyncio.wait_for(
                stack.enter_async_context(self._client.aio.live.connect(model=self._model, config=config)),
                timeout=self._timeout,
            )
        except Exception as error:
            await stack.aclose()
            reason = classify_error(error)
            GEMINI_CONNECT_FAILURES_TOTAL.labels(reason).inc()
            detail = scrub(
                f"{type(error).__name__}: {str(error)[:200]}",
                self._settings.api_key.get_secret_value() if self._settings.api_key else None,
                self._settings.relay_token.get_secret_value() if self._settings.relay_token else None,
            )
            raise LiveError(f"Gemini Live не открылся ({reason}): {detail}", reason) from error
        GEMINI_CONNECT_SECONDS.observe(time.monotonic() - started)
        return GeminiLiveLink(stack, session, voice)

    async def aclose(self) -> None:
        return None


# ─── Озвучка готового текста ──────────────────────────────────────────────────

VERBATIM_INSTRUCTIONS = (
    "Ты — голос приложения «Слышу Рядом». Тебе дают фразу, и ты произносишь её дословно, по-русски, спокойным тёплым "
    "голосом, без своих слов, без вступлений и без добавлений."
)


class GeminiLiveTts:
    """Фиксированные фразы агента (приветствие, кризисный ответ) тем же голосом, каким модель отвечает в диалоге."""

    def __init__(self, connector: LiveConnector, timeout_seconds: int = 30) -> None:
        self._connector = connector
        self._timeout = timeout_seconds
        self.name = connector.name

    async def synthesize(self, text: str, voice: Voice) -> bytes:
        try:
            link = await self._connector.open(voice, VERBATIM_INSTRUCTIONS)
        except LiveError as error:
            raise TtsError(str(error)) from error
        pcm = bytearray()
        try:
            await link.send_text(f"Произнеси дословно, без добавлений: «{text}»")
            async with asyncio.timeout(self._timeout):
                async for event in link.events():
                    if event.kind == "audio":
                        pcm += event.data
                    elif event.kind in ("generation_complete", "turn_complete"):
                        break
                    elif event.kind == "closed":
                        break
        except TimeoutError as error:
            raise TtsError("Gemini Live не договорил фразу вовремя") from error
        except Exception as error:  # noqa: BLE001
            raise TtsError(f"Gemini Live: {type(error).__name__}: {str(error)[:160]}") from error
        finally:
            await link.aclose()
        if not pcm:
            raise TtsError("Gemini Live вернул пустое аудио")
        return bytes(pcm[: len(pcm) // 2 * 2])

    async def aclose(self) -> None:
        await self._connector.aclose()


def build_live(settings: GeminiSettings) -> LiveConnector:
    return GeminiLiveConnector(settings)
