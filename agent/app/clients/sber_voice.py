"""Голосовой путь на моделях Сбера через прокси программы: GigaASR слушает, GigaChat отвечает, SaluteSpeech говорит (PROTEUS-258).

Снаружи он устроен как Gemini Live (`LiveConnector` и `LiveLink` в app/clients/gemini_live.py), поэтому сессия разговора
(app/api/dialog_session.py) ведёт его без изменений: проверка на кризис по расшифровке, история, перебивание, повторная просьба
ответить. События хода идут в том же порядке, что у Gemini: `input_text` (расшифровка реплики целиком, с пунктуацией), затем ответ
по предложениям — `output_text` предложения и его звук (`audio`), в конце `generation_complete`, `usage` (токены GigaChat) и
`turn_complete`. Пустая расшифровка — ход без ответа, как тишина у Gemini.

Модели — константы, адрес и ключ прокси те же, что у фоновой модели (`LLM_BASE_URL`, `AGENT_API_TOKEN`):
  gigaasr                распознавание, `/v1/realtime` (сессия расшифровки): PCM16 24 кГц, серверный VAD выключен, границы
                         реплики задаёт клиент (`input_audio_buffer.commit` на конец реплики)
  gigachat3.5-432b-a28b  ответ, `/v1/chat/completions` потоком
  salutespeech           синтез, `/v1/realtime`: текст в `response.create`, звук PCM16 24 кГц, как у озвучки агента

Сессии распознавания и синтеза открываются вместе с соединением и живут, пока оно живо: открытие сессии на прокси стоит около
0,5 с, а ход на открытой — нет. Голос у SaluteSpeech на прокси пока один (`Bab-Freespeech`, проверено 28.10.2026: остальные
отвечают «not available at 24000 Hz»), поэтому род и выбранный в профиле голос здесь не различаются.

Вокруг основного пути — запасной: `FallbackConnector` открывает Gemini Live, если соединение Сбера не открылось, `FallbackTts`
озвучивает фразу голосом Gemini, если SaluteSpeech не дал звука.
"""

import asyncio
import base64
import json
import logging
import re
from array import array
from collections.abc import AsyncIterator, Callable
from typing import Any, Literal

import httpx
from websockets.asyncio.client import ClientConnection, connect
from websockets.protocol import State

from app.clients.gemini_live import LiveConnector, LiveError, LiveEvent, LiveHistory, LiveLink
from app.clients.mood_classifier import INSTRUCTIONS as MOOD_INSTRUCTIONS
from app.clients.mood_classifier import MOOD_TIMEOUT_SECONDS, parse_mood
from app.clients.speech import TextToSpeech, TtsError, Voice, pcm_stream
from app.services import usage as model_usage
from app.services.replies import SELF_GENDER

logger = logging.getLogger("agent.sber")

ASR_MODEL = "gigaasr"
CHAT_MODEL = "gigachat3.5-432b-a28b"
TTS_MODEL = "salutespeech"
TTS_VOICE = "Bab-Freespeech"
TTS_VOICE_GENDER: Literal["male", "female"] = "female"
# Распознавание ждёт PCM16 24 кГц (формат OpenAI Realtime), а клиент шлёт 16 кГц.
ASR_RATE = 24_000
OPEN_TIMEOUT_SECONDS = 10.0
# Расшифровка приходит через 0,1–0,3 с после конца реплики; дольше — сессия распознавания сломалась.
TRANSCRIPT_TIMEOUT_SECONDS = 10.0
CHAT_TIMEOUT_SECONDS = 20.0
# Фраза в 5 с синтезируется за 0,3–1 с.
SPEECH_TIMEOUT_SECONDS = 20.0
# Недослушанный ответ синтеза (перебили) дочитывается не дольше этого: потом сессия синтеза открывается заново.
DRAIN_TIMEOUT_SECONDS = 5.0
CHAT_MAX_TOKENS = 400
CHAT_TEMPERATURE = 0.7
# Соединение с прокси живёт между ходами (паузы человека дольше пяти секунд по умолчанию у httpx).
KEEPALIVE_SECONDS = 120.0
# Конец предложения в потоке ответа: знак и пробел после него. Последнее предложение отдаётся с концом потока.
_SENTENCE_END = re.compile(r"[.!?…]+[»\")]*\s+")
# Первый кусок ответа уходит в синтез раньше конца длинного предложения — на границе части предложения: первый звук не ждёт
# всего предложения. Короткие предложения не режутся: интонация части звучит как конец фразы.
_CLAUSE_END = re.compile(r"[,;:—–]\s+")
FIRST_CLAUSE_AFTER_CHARS = 60
FIRST_CLAUSE_MIN_CHARS = 25
# Разметка, которую голос прочёл бы вслух, и пункты списка: перенос строки с маркером или без него — просто пауза в речи.
_MARKUP = re.compile(r"[*#_`]+")
_LIST_BREAK = re.compile(r"\s*\n\s*(?:[-•–]|\d+[.)])?\s*")
_LIST_START = re.compile(r"^(?:[-•–]|\d+[.)])\s+")
# Gemini Live сам держит голосовой формат, GigaChat без напоминания в конце промпта отвечает списком советов на полминуты речи
# (проверено 28.10.2026: с ним 140–200 знаков против 220–740, списков нет).
VOICE_RULES = (
    "\n\nНапоминание о формате: ответ звучит голосом в живом разговоре. Одна–четыре короткие фразы обычной речью; никаких "
    "списков, пунктов, тире в начале строк и перечислений через переносы."
)
# Классификатор тона в пути Сбера отвечает JSON по просьбе в инструкции: так GigaChat 3.5 ответил разбираемо 24 раза из 24.
MOOD_SYSTEM = MOOD_INSTRUCTIONS + ' Ответь только JSON без пояснений: {"tone": "...", "intensity": 0.0}.'


def own_gender(instructions: str) -> str:
    """О себе агент говорит в роде голоса, который звучит, а не рода, выбранного для Gemini: Bab-Freespeech — женский голос (высота
    около 235 Гц), а «я не расслышал» женским голосом режет слух."""
    own = SELF_GENDER[TTS_VOICE_GENDER]
    for rule in SELF_GENDER.values():
        instructions = instructions.replace(rule, own)
    return instructions


def speakable(text: str) -> str:
    """Кусок ответа для синтеза и ленты: без маркеров списка и переносов строк."""
    return _LIST_START.sub("", _LIST_BREAK.sub(" ", text).strip())


class Upsampler:
    """16 кГц → 24 кГц линейной интерполяцией (коэффициент 3/2), поток кусками любой длины: стык кусков считается по последнему
    сэмплу прошлого, поэтому звук не зависит от длины кадра. Для распознавания речи линейной интерполяции достаточно; без пересчёта
    GigaASR принимает 16 кГц за 24 кГц (речь в полтора раза быстрее)."""

    STEP = 2 / 3

    def __init__(self) -> None:
        self._last: int | None = None
        self._pos = 0.0  # где следующий сэмпл выхода, в сэмплах входа от `_last`

    def __call__(self, pcm: bytes) -> bytes:
        src = array("h")
        src.frombytes(pcm[: len(pcm) // 2 * 2])
        if not src:
            return b""
        buf = src if self._last is None else array("h", [self._last]) + src
        top = len(buf) - 1
        out = array("h")
        pos = self._pos
        while pos < top:
            j = int(pos)
            a = buf[j]
            out.append(int(a + (buf[j + 1] - a) * (pos - j)))
            pos += self.STEP
        self._pos = pos - top
        self._last = buf[top]
        return out.tobytes()


def realtime_url(base_url: str, model: str) -> str:
    """`https://host:4000/v1` → `wss://host:4000/v1/realtime?model=…`."""
    return re.sub(r"^http", "ws", base_url.rstrip("/")) + f"/realtime?model={model}"


async def _open_realtime(base_url: str, api_key: str, model: str) -> ClientConnection:
    """Сессия Realtime на прокси; первое событие сервера — `session.created` или `transcription_session.created`."""
    headers = {"Authorization": f"Bearer {api_key}", "OpenAI-Beta": "realtime=v1"}
    ws = await connect(realtime_url(base_url, model), additional_headers=headers, max_size=None, open_timeout=OPEN_TIMEOUT_SECONDS)
    try:
        first = json.loads(await asyncio.wait_for(ws.recv(), OPEN_TIMEOUT_SECONDS))
    except BaseException:
        await ws.close()
        raise
    if first.get("type") == "error":
        await ws.close()
        raise LiveError(f"{model}: {str(first.get('error'))[:200]}")
    return ws


class SaluteSpeaker:
    """Сессия синтеза SaluteSpeech: фразы по одной. Недослушанный ответ (перебили) отменяется `response.cancel`, и следующая фраза
    сначала дочитывает его `response.done`: иначе ей достались бы чужие кусочки звука."""

    def __init__(self, ws: ClientConnection) -> None:
        self._ws = ws
        self._lock = asyncio.Lock()
        self._unfinished = 0  # ответов, чей `response.done` ещё не прочитан
        self.broken = False  # сессию дальше не использовать: ошибка сервера или обрыв

    async def speak(self, text: str) -> AsyncIterator[bytes]:
        async with self._lock:
            if self.broken or self._ws.state is not State.OPEN:
                self.broken = True
                raise TtsError("сессия SaluteSpeech закрыта")
            await self._drain()
            await self._ws.send(json.dumps({"type": "response.create", "response": {"instructions": text}}))
            self._unfinished += 1
            try:
                async with asyncio.timeout(SPEECH_TIMEOUT_SECONDS):
                    while True:
                        event = json.loads(await self._ws.recv())
                        kind = event.get("type")
                        if kind == "response.audio.delta":
                            yield base64.b64decode(event["delta"])
                        elif kind == "response.done":
                            self._unfinished -= 1
                            return
                        elif kind == "error":
                            self.broken = True
                            raise TtsError(f"SaluteSpeech: {str(event.get('error'))[:200]}")
            except (asyncio.CancelledError, GeneratorExit):
                # Перебили посреди фразы: остаток синтеза не нужен, сессия остаётся для следующей.
                try:
                    await self._ws.send(json.dumps({"type": "response.cancel"}))
                except Exception:  # noqa: BLE001
                    self.broken = True
                raise
            except TtsError:
                raise
            except Exception as error:
                self.broken = True
                raise TtsError(f"SaluteSpeech: {type(error).__name__}: {str(error)[:160]}") from error

    async def _drain(self) -> None:
        try:
            async with asyncio.timeout(DRAIN_TIMEOUT_SECONDS):
                while self._unfinished > 0:
                    event = json.loads(await self._ws.recv())
                    if event.get("type") == "response.done":
                        self._unfinished -= 1
        except Exception as error:
            self.broken = True
            raise TtsError(f"SaluteSpeech не закончил прошлую фразу: {type(error).__name__}") from error

    async def aclose(self) -> None:
        self.broken = True
        await self._ws.close()


class SberVoiceLink:
    """Соединение одного голоса: сессия распознавания, сессия синтеза и история разговора для GigaChat."""

    # Токены GigaChat не входят в окно токенов Gemini (`GEMINI_TPM_LIMIT`), даже когда эта ссылка запасная у пути Gemini Live.
    counts_tokens = False

    def __init__(
        self,
        connector: "SberVoiceConnector",
        asr: ClientConnection,
        speaker: SaluteSpeaker,
        voice: Voice,
        instructions: str,
        history: LiveHistory | None,
    ) -> None:
        self.voice: Voice = voice
        self.voice_name = TTS_VOICE
        self.model = CHAT_MODEL
        self.closed = False
        self._connector = connector
        self._asr = asr
        self._speaker = speaker
        self._events: asyncio.Queue[LiveEvent] = asyncio.Queue()
        self._messages: list[dict[str, str]] = [{"role": "system", "content": own_gender(instructions) + VOICE_RULES}]
        for role, text in history or ():
            self._add("user" if role == "user" else "assistant", text)
        self._transcripts: asyncio.Queue[str] = asyncio.Queue()
        self._asr_reader = asyncio.create_task(self._read_asr())
        self._answer: asyncio.Task[None] | None = None
        self._answer_output = False  # идущий ответ уже прислал текст или звук
        self._turn_bytes = 0  # звук реплики, ушедший в распознавание (24 кГц)
        self._upsample = Upsampler()

    # ─── вход ─────────────────────────────────────────────────────────────────

    async def activity_start(self) -> None:
        await self._stop_answer()
        while not self._transcripts.empty():  # расшифровка прошлой реплики, на которую уже не отвечаем
            self._transcripts.get_nowait()
        self._turn_bytes = 0
        self._upsample = Upsampler()
        self._connector.prewarm()  # пока человек говорит: ответ GigaChat не будет ждать TLS
        await self._asr_send({"type": "input_audio_buffer.clear"})

    async def send_audio(self, pcm: bytes) -> None:
        data = self._upsample(pcm)
        self._turn_bytes += len(data)
        await self._asr_send({"type": "input_audio_buffer.append", "audio": base64.b64encode(data).decode()})

    async def activity_end(self) -> None:
        seconds = self._turn_bytes / (2 * ASR_RATE)
        if self._turn_bytes:
            await self._asr_send({"type": "input_audio_buffer.commit"})
        else:
            self._transcripts.put_nowait("")
        self._answer = asyncio.create_task(self._answer_voice(seconds))

    async def send_text(self, text: str) -> None:
        await self._stop_answer()
        self._add("user", text)
        self._answer = asyncio.create_task(self._reply())

    async def nudge(self) -> None:
        await self._stop_answer()
        self._answer = asyncio.create_task(self._reply())

    async def _asr_send(self, event: dict[str, Any]) -> None:
        try:
            await self._asr.send(json.dumps(event))
        except Exception as error:
            self._fail(f"GigaASR: {type(error).__name__}: {str(error)[:160]}")
            raise LiveError("сессия GigaASR закрыта") from error

    async def _read_asr(self) -> None:
        reason = "GigaASR закрыл соединение"
        try:
            async for raw in self._asr:
                event = json.loads(raw)
                kind = event.get("type")
                if kind == "conversation.item.input_audio_transcription.completed":
                    self._transcripts.put_nowait(event.get("transcript") or "")
                elif kind == "conversation.item.input_audio_transcription.failed":
                    logger.warning("gigaasr transcription failed: %s", str(event.get("error"))[:200])
                    self._transcripts.put_nowait("")
                elif kind == "error":
                    error = event.get("error") or {}
                    if error.get("code") == "input_audio_buffer_commit_empty":
                        self._transcripts.put_nowait("")
                    else:
                        logger.warning("gigaasr error: %s", str(error)[:200])
        except asyncio.CancelledError:
            raise
        except Exception as error:  # noqa: BLE001
            reason = f"GigaASR: {type(error).__name__}: {str(error)[:160]}"
        self._fail(reason)

    # ─── ответ ────────────────────────────────────────────────────────────────

    async def _answer_voice(self, seconds: float) -> None:
        try:
            heard = await asyncio.wait_for(self._transcripts.get(), TRANSCRIPT_TIMEOUT_SECONDS)
        except TimeoutError:
            self._fail("GigaASR не прислал расшифровку")
            return
        model_usage.record(ASR_MODEL, "live", "input", "audio", "seconds", seconds)
        heard = heard.strip()
        if not heard:
            self._events.put_nowait(LiveEvent("generation_complete"))
            self._events.put_nowait(LiveEvent("turn_complete"))
            return
        self._events.put_nowait(LiveEvent("input_text", text=heard))
        self._add("user", heard)
        await self._reply()

    async def _reply(self) -> None:
        """Ответ GigaChat по предложениям: предложение готово — его текст и звук уходят, пока модель пишет следующее."""
        self._answer_output = False
        sentences: asyncio.Queue[str | None] = asyncio.Queue()
        usage: dict[str, int] = {}
        writer = asyncio.create_task(self._write(list(self._messages), sentences, usage))
        said: list[str] = []
        try:
            while (sentence := await sentences.get()) is not None:
                self._answer_output = True
                said.append(sentence)
                self._events.put_nowait(LiveEvent("output_text", text=sentence + " "))
                async for pcm in self._speak(sentence):
                    self._events.put_nowait(LiveEvent("audio", data=pcm))
            await writer
        except asyncio.CancelledError:
            writer.cancel()
            raise
        except Exception as error:  # noqa: BLE001
            writer.cancel()
            self._fail(f"{type(error).__name__}: {str(error)[:180]}")
            return
        finally:
            if said:
                self._add("assistant", " ".join(said))  # в истории то, что человек успел услышать
        self._events.put_nowait(LiveEvent("generation_complete"))
        if usage:
            self._events.put_nowait(LiveEvent("usage", usage=usage))
        self._events.put_nowait(LiveEvent("turn_complete"))

    async def _write(self, messages: list[dict[str, str]], sentences: "asyncio.Queue[str | None]", usage: dict[str, int]) -> None:
        body = {
            "model": CHAT_MODEL,
            "messages": messages,
            "stream": True,
            "stream_options": {"include_usage": True},
            "max_tokens": CHAT_MAX_TOKENS,
            "temperature": CHAT_TEMPERATURE,
        }
        buffer = ""
        first = True
        try:
            async with self._connector.http.stream("POST", self._connector.chat_url, json=body) as response:
                if response.status_code != 200:
                    raise LiveError(f"GigaChat ответил {response.status_code}: {(await response.aread())[:200]!r}")
                async for line in response.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    chunk = json.loads(data)
                    if chunk.get("usage"):
                        usage["input_text"] = int(chunk["usage"].get("prompt_tokens") or 0)
                        usage["output_text"] = int(chunk["usage"].get("completion_tokens") or 0)
                    for choice in chunk.get("choices") or []:
                        buffer += _MARKUP.sub("", (choice.get("delta") or {}).get("content") or "")
                    while True:
                        match = _SENTENCE_END.search(buffer)
                        if match is None and first and len(buffer) >= FIRST_CLAUSE_AFTER_CHARS:
                            match = _CLAUSE_END.search(buffer, FIRST_CLAUSE_MIN_CHARS)
                        if match is None:
                            break
                        sentence, buffer = speakable(buffer[: match.end()]), buffer[match.end() :]
                        if sentence:
                            sentences.put_nowait(sentence)
                            first = False
            if speakable(buffer):
                sentences.put_nowait(speakable(buffer))
        finally:
            sentences.put_nowait(None)

    async def _speak(self, text: str) -> AsyncIterator[bytes]:
        if self._speaker.broken:
            old, self._speaker = self._speaker, await self._connector.speaker()
            await old.aclose()
        async for pcm in self._speaker.speak(text):
            yield pcm
        model_usage.record(TTS_MODEL, "live", "input", "text", "chars", len(text))

    async def _stop_answer(self) -> None:
        answer, self._answer = self._answer, None
        if answer is None or answer.done():
            return
        answer.cancel()
        await asyncio.gather(answer, return_exceptions=True)
        if self._answer_output:
            self._events.put_nowait(LiveEvent("interrupted"))

    def _add(self, role: Literal["user", "assistant"], text: str) -> None:
        """Реплики одного автора подряд склеиваются: так историю принимает любая чат-модель."""
        last = self._messages[-1]
        if last["role"] == role:
            last["content"] += "\n" + text
        else:
            self._messages.append({"role": role, "content": text})

    # ─── события и закрытие ───────────────────────────────────────────────────

    def _fail(self, reason: str) -> None:
        if self.closed:
            return
        self.closed = True
        logger.warning("sber voice link closed: %s", reason)
        self._events.put_nowait(LiveEvent("closed", text=reason[:200]))

    async def events(self) -> AsyncIterator[LiveEvent]:
        while True:
            event = await self._events.get()
            yield event
            if event.kind == "closed":
                return

    async def aclose(self) -> None:
        self.closed = True
        tasks = [task for task in (self._answer, self._asr_reader) if task is not None]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await asyncio.gather(self._asr.close(), self._speaker.aclose(), return_exceptions=True)


class SberVoiceConnector:
    name = f"sber-voice:{CHAT_MODEL}"
    model = CHAT_MODEL

    def __init__(self, base_url: str, api_key: str) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self.chat_url = f"{self._base_url}/chat/completions"
        # Проверка живости прокси без ключа и почти без ответа: ей прогревается соединение до запроса к GigaChat.
        self._ping_url = re.sub(r"/v1$", "", self._base_url) + "/health/liveliness"
        self.http = httpx.AsyncClient(
            timeout=httpx.Timeout(CHAT_TIMEOUT_SECONDS, connect=OPEN_TIMEOUT_SECONDS),
            limits=httpx.Limits(keepalive_expiry=KEEPALIVE_SECONDS),
            headers={"Authorization": f"Bearer {api_key}"},
        )
        self._prewarm: asyncio.Task[None] | None = None

    def prewarm(self) -> None:
        """Открыть соединение с прокси заранее (в фоне); живое соединение просто переиспользуется."""
        if self._prewarm is None or self._prewarm.done():
            self._prewarm = asyncio.create_task(self._ping())

    async def _ping(self) -> None:
        try:
            await self.http.get(self._ping_url)
        except Exception as error:  # noqa: BLE001 - прогрев не обязателен
            logger.debug("prewarm failed: %s", error)

    async def speaker(self) -> SaluteSpeaker:
        try:
            return SaluteSpeaker(await _open_realtime(self._base_url, self._api_key, TTS_MODEL))
        except LiveError:
            raise
        except Exception as error:
            raise LiveError(f"SaluteSpeech не открылся: {type(error).__name__}: {str(error)[:200]}") from error

    async def _open_asr(self) -> ClientConnection:
        try:
            ws = await _open_realtime(self._base_url, self._api_key, ASR_MODEL)
        except LiveError:
            raise
        except Exception as error:
            raise LiveError(f"GigaASR не открылся: {type(error).__name__}: {str(error)[:200]}") from error
        session = {
            "input_audio_format": "pcm16",
            "input_audio_transcription": {"model": ASR_MODEL, "language": "ru"},
            "turn_detection": None,
        }
        try:
            await ws.send(json.dumps({"type": "session.update", "session": session}))
            reply = json.loads(await asyncio.wait_for(ws.recv(), OPEN_TIMEOUT_SECONDS))
        except Exception as error:
            await ws.close()
            raise LiveError(f"GigaASR не принял настройки: {type(error).__name__}") from error
        if reply.get("type") == "error":
            await ws.close()
            raise LiveError(f"GigaASR не принял настройки: {str(reply.get('error'))[:200]}")
        return ws

    async def open(self, voice: Voice, instructions: str, history: LiveHistory | None = None) -> SberVoiceLink:
        asr, speaker = await asyncio.gather(self._open_asr(), self.speaker(), return_exceptions=True)
        if isinstance(asr, BaseException) or isinstance(speaker, BaseException):
            if not isinstance(asr, BaseException):
                await asr.close()
            if not isinstance(speaker, BaseException):
                await speaker.aclose()
            error = asr if isinstance(asr, BaseException) else speaker
            if not isinstance(error, Exception):
                raise error  # отмена
            raise error if isinstance(error, LiveError) else LiveError(str(error)[:200])
        return SberVoiceLink(self, asr, speaker, voice, instructions, history)

    def mood_classifier(self) -> "GigaChatMoodClassifier":
        """Тон реплики в пути Сбера определяет GigaChat на том же прокси, а не Gemini."""
        return GigaChatMoodClassifier(self)

    async def aclose(self) -> None:
        await self.http.aclose()


class GigaChatMoodClassifier:
    """Тон реплики человека для цвета шарика в пути Сбера: GigaChat на модельном прокси, чтобы слова человека не уходили в Google.

    Замер 29.10.2026 на 24 синтетических репликах: GigaChat 3.5 угадал тон 24 раза, медиана 0,5 с (p90 0,63 с);
    gemini-3.1-flash-lite через тот же прокси — 21 раз, медиана 0,9 с; gigachat3-10b быстрее (0,2 с), но 22 из 24 и выдумывал тон.
    """

    def __init__(self, connector: SberVoiceConnector) -> None:
        self._connector = connector

    async def warm(self) -> None:
        self._connector.prewarm()

    async def classify(self, text: str) -> dict | None:
        body = {
            "model": CHAT_MODEL,
            "messages": [{"role": "system", "content": MOOD_SYSTEM}, {"role": "user", "content": text}],
            "temperature": 0,
            "max_tokens": 60,
        }
        for attempt in (1, 2):  # один повтор, как у классификатора Gemini
            try:
                response = await asyncio.wait_for(
                    self._connector.http.post(self._connector.chat_url, json=body), MOOD_TIMEOUT_SECONDS
                )
                response.raise_for_status()
                data = response.json()
                usage = data.get("usage") or {}
                model_usage.record(CHAT_MODEL, "mood", "input", "text", "tokens", int(usage.get("prompt_tokens") or 0))
                model_usage.record(CHAT_MODEL, "mood", "output", "text", "tokens", int(usage.get("completion_tokens") or 0))
                return parse_mood(_json_object(data["choices"][0]["message"]["content"]))
            except Exception as error:  # noqa: BLE001
                logger.warning("классификатор тона GigaChat (попытка %d): %s: %s", attempt, type(error).__name__, str(error)[:120])
        return None


def _json_object(text: str) -> dict | None:
    """JSON из ответа модели, даже если вокруг него слова или разметка."""
    match = re.search(r"\{.*\}", text or "", re.S)
    try:
        return json.loads(match.group(0)) if match else None
    except json.JSONDecodeError:
        return None


class SaluteTts:
    """Готовые фразы (приветствие, кризисный ответ, просьба повторить) голосом SaluteSpeech: своя сессия синтеза на фразу."""

    name = f"{TTS_MODEL}:{TTS_VOICE}"

    def __init__(self, connector: SberVoiceConnector) -> None:
        self._connector = connector

    async def stream(self, text: str, voice: Voice) -> AsyncIterator[bytes]:
        try:
            speaker = await self._connector.speaker()
        except LiveError as error:
            raise TtsError(str(error)) from error
        try:
            async for pcm in speaker.speak(text):
                yield pcm
            model_usage.record(TTS_MODEL, "phrase", "input", "text", "chars", len(text))
        finally:
            await speaker.aclose()

    async def synthesize(self, text: str, voice: Voice) -> bytes:
        pcm = b"".join([piece async for piece in self.stream(text, voice)])
        if not pcm:
            raise TtsError("SaluteSpeech вернул пустое аудио")
        return pcm[: len(pcm) // 2 * 2]

    async def aclose(self) -> None:
        return None


class FallbackTts:
    """Фраза голосом основного провайдера, а если он не дал ни кусочка звука, — запасного: у пути Сбера это Gemini Live, у пути
    Gemini Live — SaluteSpeech."""

    def __init__(self, primary: TextToSpeech, fallback: TextToSpeech) -> None:
        self._primary = primary
        self._fallback = fallback
        self.name = f"{primary.name}>{fallback.name}"

    async def stream(self, text: str, voice: Voice) -> AsyncIterator[bytes]:
        seen = False
        try:
            async for piece in pcm_stream(self._primary, text, voice):
                seen = True
                yield piece
            return
        except Exception as error:
            if seen:
                raise
            logger.warning("основная озвучка не ответила, фраза идёт голосом %s: %s", self._fallback.name, error)
        async for piece in pcm_stream(self._fallback, text, voice):
            yield piece

    async def synthesize(self, text: str, voice: Voice) -> bytes:
        try:
            return await self._primary.synthesize(text, voice)
        except Exception as error:  # noqa: BLE001
            logger.warning("основная озвучка не ответила, фраза идёт голосом %s: %s", self._fallback.name, error)
            return await self._fallback.synthesize(text, voice)

    async def aclose(self) -> None:
        await self._primary.aclose()  # запасную закрывает её владелец


class FallbackConnector:
    """Основной голосовой путь, а если его соединение не открылось, — запасной: у пути Сбера это Gemini Live, у пути Gemini
    Live — Сбер. Оборвался основной посреди разговора — сессия открывает соединение заново (`DialogSession._ensure_link`), и
    снова сначала основной.

    `skip_primary`: основной путь сейчас заведомо откажет (пауза после отказа Google по квоте), открывать его незачем.
    `on_primary_error`: основной путь не открылся — вызывающий узнаёт об этом (так отказ по квоте при открытии начинает паузу).
    """

    # Сессия разговора видит: у соединителя есть куда отступить, поэтому пауза основного пути не должна задерживать открытие.
    has_fallback = True

    def __init__(
        self,
        primary: LiveConnector,
        fallback: LiveConnector,
        model: str | None = None,
        skip_primary: Callable[[], bool] | None = None,
        on_primary_error: Callable[[Exception], None] | None = None,
    ) -> None:
        self._primary = primary
        self._fallback = fallback
        self._skip_primary = skip_primary
        self._on_primary_error = on_primary_error
        self.name = f"{primary.name}>{fallback.name}"
        # Расход пишется по модели соединения (`LiveLink.model`); у соединения без неё — по модели Gemini Live: у ссылки пути
        # Сбера своя модель, у ссылки Gemini её нет. По умолчанию это модель запасного пути (путь Сбера с запасным Gemini).
        self.model = model or fallback.model

    async def open(self, voice: Voice, instructions: str, history: LiveHistory | None = None) -> LiveLink:
        if self._skip_primary is not None and self._skip_primary():
            logger.info("голосовой путь %s на паузе, разговор идёт на %s", self._primary.name, self._fallback.name)
            return await self._fallback.open(voice, instructions, history)
        try:
            return await self._primary.open(voice, instructions, history)
        except LiveError as error:
            logger.warning("голосовой путь %s не открылся, разговор идёт на %s: %s", self._primary.name, self._fallback.name, error)
            if self._on_primary_error is not None:
                self._on_primary_error(error)
            return await self._fallback.open(voice, instructions, history)

    async def aclose(self) -> None:
        await self._primary.aclose()  # запасной закрывает его владелец
