"""WebSocket диалога: текст и голос (specs/agent-api «Разговор по WebSocket», «Голос»).

Один сокет на диалог. Реплики идут в очередь и обрабатываются по одной; `tts_cancel` действует сразу.
Ответ пишет чат-модель (app.clients.llm), голос человека распознаёт whisper, ответ озвучивает app.clients.speech.
Если модель не ответила, клиент получает `error AGENT_LLM_UNAVAILABLE`, а не шаблон. Заглушка из app.services.replies отвечает
только в режиме без моделей (`LLM_MODE=template`: разработка и тесты).
"""

import asyncio
import json
import logging
import math
import re
import time
import uuid
from array import array
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import aclosing
from dataclasses import dataclass
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

from app.api.deps import active_tts, canonical_user_id, token_ok
from app.clients.llm import STT_RATE, ChatModel, ModelError, ProxyChat, Recognizer, ReplyTruncated, ToolCallRequested
from app.clients.speech import FRAME_BYTES, TTS_RATE, VOICES, TextToSpeech, Voice, pcm_stream, tts_frame
from app.core.config import APP_CONFIG
from app.core.errors import error_body
from app.core.metrics import (
    VOICE_ECHO_TOTAL,
    VOICE_FALSE_INTERRUPTIONS_TOTAL,
    VOICE_HELD_TURNS_TOTAL,
    VOICE_INTERRUPTIONS_TOTAL,
    VOICE_LATENCY_SECONDS,
    VOICE_TURN_END_DELAY_SECONDS,
    VOICE_TURNS_TRUNCATED_TOTAL,
)
from app.services import usage as model_usage
from app.core.reclaim import forget_cancellation
from app.core.tracing import NullTracer, Observation, Tracer
from app.services.dialog_store import Dialog, DialogStore, Message
from app.services.replies import (
    CRISIS_REPLY,
    CRISIS_SAFETY_TEXT,
    chat_messages,
    is_crisis,
    is_echo,
    looks_unfinished,
    next_reply,
    split_sentences,
    take_sentences,
)

logger = logging.getLogger("agent.ws")

router = APIRouter()

FRAME_KIND_AUDIO_IN = 0x01
# Набранный текст шлюз приложения ограничивает 4000 символов сам; запас здесь — для голоса:
# пять минут речи (VOICE_TURN_MAX_SECONDS) — это 4-5 тысяч символов распознанного текста.
MAX_USER_TEXT = 8000

# Инструмент поиска в долговременной памяти: модель зовёт его, когда человек спрашивает «а помнишь…».
RECALL_TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "recall_memory",
            "description": (
                "Вспомнить факты о человеке из долговременной памяти (прошлые разговоры: имя, семья, работа, "
                "предпочтения, события). Вызывай, когда человек спрашивает, помнишь ли ты что-то, или когда для "
                "ответа нужны факты из прошлых разговоров."
            ),
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string", "description": "О чём вспомнить, своими словами"}},
                "required": ["query"],
            },
        },
    }
]
# Один кадр голоса человека — 100 мс (specs/agent-api «Голос — формат и ввод»).
AUDIO_FRAME_SECONDS = 0.1
# Одна голосовая реплика — не длиннее VOICE_TURN_MAX_SECONDS: остальное отбрасывается, память не растёт без предела.
MAX_AUDIO_BYTES = STT_RATE * 2 * APP_CONFIG.dialog.voice_turn_max_seconds
# Тише этого (среднеквадратичное по PCM16, около -50 дБ) — тишина: whisper на ней выдумывает слова, и в него она не идёт.
SILENCE_RMS = 100
# Ответ модели длиннее — обрезаем: озвучка и экран рассчитаны на короткую реплику.
MAX_REPLY_CHARS = 1200
# Сколько предложений ответа синтезируется одновременно: звучащее и следующее. Больше не надо, а прокси общий.
SPEECH_PREFETCH = 2


def is_silence(pcm: bytes) -> bool:
    """Нет ли в записи речи: меряем каждый 16-й сэмпл, этого хватает и не держит цикл событий."""
    samples = array("h")
    samples.frombytes(pcm[: len(pcm) // 2 * 2])
    picked = samples[::16]
    if not picked:
        return True
    return math.sqrt(sum(x * x for x in picked) / len(picked)) < SILENCE_RMS


@dataclass
class Turn:
    """Один ход: от чего считать задержку. `started` — конец реплики человека или его набранное сообщение (monotonic)."""

    started: float | None = None
    # Трасса хода в Langfuse (app/core/tracing.py); None — ход без трейсинга (например, прогрев).
    trace: Observation | None = None


class SpeechFeed:
    """Куски текста для озвучки одного сообщения: `add` по мере появления предложений, `close` в конце.

    Кусок — одно предложение. Пробовали озвучивать первое отдельно, а остальные одним запросом ради связной интонации
    между предложениями (настройка `TTS_JOIN_REST`): на слух разницы с Qwen не было, скорости это не добавляло, и опцию
    убрали.
    """

    def __init__(self) -> None:
        self.chunks: asyncio.Queue[str | None] = asyncio.Queue()

    def add(self, sentence: str) -> None:
        self.chunks.put_nowait(sentence)

    def close(self) -> None:
        self.chunks.put_nowait(None)


class Synthesis:
    """Синтез одного куска текста, который наполняет `pieces` звуком по мере прихода от провайдера.

    В очереди куски PCM, затем `None` (конец) или исключение (отказ провайдера). Читает тот, кто озвучивает.
    """

    def __init__(
        self,
        tts: TextToSpeech,
        text: str,
        voice: Voice,
        first: bool,
        memory: str = "off",
        tracer: Tracer | None = None,
        trace: Observation | None = None,
    ) -> None:
        self.pieces: asyncio.Queue[bytes | Exception | None] = asyncio.Queue()
        self._memory = memory
        self.task = asyncio.create_task(self._run(tts, text, voice, first, tracer or NullTracer(), trace))
        # Синтез перебитой озвучки отменяется: без этого он держал бы себя (и недозвученный звук) циклом через свою задачу.
        self.task.add_done_callback(forget_cancellation)

    async def _run(
        self, tts: TextToSpeech, text: str, voice: Voice, first: bool, tracer: Tracer, trace: Observation | None
    ) -> None:
        began = time.monotonic()
        seen = False
        span = tracer.start_span(
            trace,
            name="tts",
            input=text,
            metadata={"model": getattr(tts, "name", "?"), "voice": voice, "first": first, "chars": len(text)},
        )
        try:
            async for piece in pcm_stream(tts, text, voice):
                if first and not seen:
                    VOICE_LATENCY_SECONDS.labels("tts_first", self._memory).observe(time.monotonic() - began)
                seen = True
                self.pieces.put_nowait(piece)
            self.pieces.put_nowait(None)
        except asyncio.CancelledError:
            span.update(metadata={"cancelled": True})
            raise
        except Exception as error:
            span.update(level="ERROR", status=str(error)[:160])
            self.pieces.put_nowait(error)
        finally:
            span.end()

    def cancel(self) -> None:
        self.task.cancel()


class DialogSession:
    def __init__(
        self,
        websocket: WebSocket,
        store: DialogStore,
        dialog: Dialog,
        tts_source: Callable[[], TextToSpeech | None],
        chat: ChatModel | None = None,
        recognizer: Recognizer | None = None,
        tracer: Tracer | None = None,
    ) -> None:
        self._ws = websocket
        self._store = store
        self._dialog = dialog
        # Без моделей (`LLM_MODE=template`) агент отвечает заглушкой, а голос превращает в заглушку.
        self._chat = chat
        # Заглушка вместо ответа — только в режиме без моделей. С моделью её нет: молчание модели — ошибка, а не шаблон.
        self._stub_replies = chat is None
        self._recognizer = recognizer
        # Озвучка берётся при каждой реплике: dev-режим может выключить её на лету.
        self._tts_source = tts_source
        # Трейсинг LLM-ходов (app/core/tracing.py); по умолчанию выключен (NullTracer).
        self._tracer = tracer or NullTracer()
        # Имя конвейера в метаданных трассы; режим gemini_live подменяет (app/api/dialog_live.py).
        self._pipeline = "cascade"
        self._stream_delay = APP_CONFIG.dialog.stream_delay_ms / 1000
        self._frame_interval = APP_CONFIG.speech.tts_frame_interval_ms / 1000

        self._closed = False
        self._replace_task: asyncio.Task[None] | None = None
        self._send_lock = asyncio.Lock()
        # Озвучки двух сообщений не перемежаются: каждая берёт замок целиком.
        self._speech_lock = asyncio.Lock()
        self._jobs: asyncio.Queue[Callable[[], Awaitable[None]]] = asyncio.Queue()
        self._speech_tasks: set[asyncio.Task[None]] = set()
        # Озвучка, которая идёт или ждёт своей очереди, по сообщению: её можно оборвать, не дожидаясь провайдера.
        self._speeches: dict[str, asyncio.Task[None]] = {}
        self._cancelled: set[str] = set()
        self._voice_error_sent = False
        self._audio_open = False
        self._audio_frames = 0
        self._audio = bytearray()
        # Когда пришёл последний кадр с речью (monotonic): по нему видно, сколько тишины ждал детектор конца реплики.
        self._last_voiced: float | None = None
        # Озвучку перебили, и следующая голосовая реплика — ответ на это перебивание.
        self._interrupted = False
        self._turn_interrupts = False
        self._component_tasks: set[asyncio.Task[None]] = set()  # кадры `component` в полёте
        # Реплика, оборванная на полуслове: ответ на неё ждёт, не договорит ли человек (см. `_hold`).
        self._held: Turn | None = None
        self._hold_timer: asyncio.Task[None] | None = None

    def _memory_label(self) -> str:
        """Метка `memory` задержек: подмешана ли в этот разговор сводка памяти (чтение кэша, без диска и сети)."""
        return "on" if self._store.memory_brief(self._dialog, count=False) else "off"

    # ─── отправка ─────────────────────────────────────────────────────────────

    def bind_component_calls(self) -> None:
        """Обращения к компонентам внутри этого сокета (и задач, которые он породит) уходят шлюзу кадром `component`.
        Звать в задаче сокета до `run`: контекст наследуют только задачи, созданные после."""
        model_usage.bind_calls(self._component_called)

    def _component_called(self, component: str, outcome: str, cached: bool) -> None:
        if self._closed:
            return
        try:
            task = asyncio.get_running_loop().create_task(
                self._send({"type": "component", "component": component, "outcome": outcome, "cached": cached})
            )
        except RuntimeError:  # вне цикла событий (синхронный тест): отправлять некому
            return
        self._component_tasks.add(task)
        task.add_done_callback(self._component_tasks.discard)

    async def _send(self, frame: dict[str, Any]) -> None:
        if self._closed:
            return
        async with self._send_lock:
            try:
                await self._ws.send_text(json.dumps({"v": 1, **frame}, ensure_ascii=False))
            except (RuntimeError, WebSocketDisconnect, OSError):
                self._closed = True

    async def _send_audio(self, data: bytes) -> None:
        if self._closed:
            return
        async with self._send_lock:
            try:
                await self._ws.send_bytes(data)
            except (RuntimeError, WebSocketDisconnect, OSError):
                self._closed = True

    # ─── жизненный цикл ───────────────────────────────────────────────────────

    def _replaced(self, summary: dict[str, Any] | None) -> None:
        """Диалог завершён снаружи (человек начал новый разговор с другого экрана): сообщить и закрыть сокет."""
        if not self._closed:
            self._replace_task = asyncio.get_running_loop().create_task(self._close_replaced(summary))

    async def _close_replaced(self, summary: dict[str, Any] | None) -> None:
        await self._send({"type": "ended", "summary": summary})
        self._closed = True
        try:
            await self._ws.close(code=1000)
        except (RuntimeError, WebSocketDisconnect, OSError):
            pass

    async def run(self) -> None:
        await self._send({"type": "ready"})
        dialog = self._dialog
        dialog.on_replaced = self._replaced
        if dialog.greeting_pending:
            dialog.greeting_pending = False  # один раз на каждый POST …/dialogs, не на каждый сокет
            if dialog.greeting:
                self._speak_in_background("greeting", dialog.greeting)

        worker = asyncio.create_task(self._worker())
        try:
            while not self._closed:
                message = await self._ws.receive()
                if message["type"] == "websocket.disconnect":
                    break
                if message.get("bytes") is not None:
                    self._on_audio_frame(message["bytes"])
                elif message.get("text") is not None and await self._on_text(message["text"]):
                    break
        finally:
            self._closed = True
            dialog.on_replaced = None
            worker.cancel()
            self._pause_hold()
            self._end_held_trace()  # сокет закрыт: ответа на оборванную реплику уже не будет
            for task in self._speech_tasks:
                task.cancel()
            await asyncio.gather(worker, *self._speech_tasks, return_exceptions=True)

    async def _worker(self) -> None:
        while True:
            job = await self._jobs.get()
            try:
                await job()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("reply failed dialog=%s", self._dialog.id)
                await self._send({"type": "error", "code": "AGENT_INTERNAL", "message": "Не удалось ответить"})

    # ─── входящие кадры ───────────────────────────────────────────────────────

    async def _on_text(self, raw: str) -> bool:
        """Обрабатывает JSON-кадр. True — сокет надо закрыть (диалог завершён)."""
        try:
            frame = json.loads(raw)
        except ValueError:
            return False
        if not isinstance(frame, dict):
            return False
        # Неизвестные кадры и поля игнорируются в обе стороны (specs/agent-api «Идентификаторы…»).
        match frame.get("type"):
            case "user_message":
                await self._on_user_message(frame)
            case "audio_start":
                self._pause_hold()  # человек заговорил снова: пока он говорит, ответ на прошлую реплику не идёт
                self._audio_open = True
                self._audio_frames = 0
                self._audio = bytearray()
                self._last_voiced = None
                # tts_cancel прямо перед audio_start — перебивание голосом: реплику начинаем с чистого листа.
                self._turn_interrupts, self._interrupted = self._interrupted, False
                self._audio_started()
            case "audio_end":
                await self._on_audio_end()
            case "set_voice":
                voice = frame.get("voice")
                if voice in VOICES:  # чужие значения игнорируются, как любое неизвестное поле
                    self._store.set_voice(self._dialog, voice)
            case "tts_cancel":
                message_id = frame.get("messageId")
                if isinstance(message_id, str):
                    self._cancel_speech(message_id)
                    VOICE_INTERRUPTIONS_TOTAL.inc()
                    # Перебили посреди реплики (она началась, пока агент думал) — это перебивание той же реплики.
                    if self._audio_open:
                        self._turn_interrupts = True
                    else:
                        self._interrupted = True
            case "end":
                return await self._on_end(frame)
        return False

    async def _on_user_message(self, frame: dict[str, Any]) -> None:
        text = frame.get("text")
        client_id = frame.get("id") if isinstance(frame.get("id"), str) and frame.get("id") else None
        if not isinstance(text, str) or not text.strip():
            return
        self._interrupted = False  # перебили, чтобы написать: это не голосовая реплика
        self._drop_hold()  # ответ на набранное сообщение отвечает и на оборванную реплику перед ним
        dialog = self._dialog
        # Клиент повторяет реплику, пока нет ack: тот же id — то же сообщение, без второго ответа.
        if client_id and client_id in dialog.client_ids:
            await self._send({"type": "ack", "id": client_id, "messageId": dialog.client_ids[client_id]})
            return
        self._supersede_speech()
        message = self._store.add_message(dialog, "user", text[:MAX_USER_TEXT])
        if client_id:
            dialog.client_ids[client_id] = message.id
        await self._send({"type": "ack", "id": client_id or message.id, "messageId": message.id})
        crisis = is_crisis(text)
        model_usage.call("safety")
        if crisis:
            self._store.mark_crisis(dialog)  # извлечение памяти из такого разговора пропускается (I13)
            await self._send({"type": "safety", "text": CRISIS_SAFETY_TEXT})
        turn = Turn(started=time.monotonic())
        self._dispatch_text_turn(text, crisis, turn)

    def _dispatch_text_turn(self, text: str, crisis: bool, turn: Turn) -> None:
        """Ответ на набранное сообщение. Режим gemini_live подменяет это место (app/api/dialog_live.py)."""
        turn.trace = self._tracer.start_turn(
            name="text_turn",
            session_id=self._dialog.id,
            user_id=self._dialog.user_id,
            input=text,
            metadata={"crisis": crisis},
            tags=[self._pipeline],
        )
        self._jobs.put_nowait(lambda: self._reply(crisis, turn))

    def _audio_started(self) -> None:
        """Началась голосовая реплика. Хук для режима gemini_live."""

    def _on_audio_frame(self, data: bytes) -> None:
        if self._audio_open and len(data) > 5 and data[0] == FRAME_KIND_AUDIO_IN:
            self._audio_frames += 1
            if not is_silence(data[5:]):
                self._last_voiced = time.monotonic()
            if len(self._audio) < MAX_AUDIO_BYTES:
                self._audio += data[5:]
                if len(self._audio) >= MAX_AUDIO_BYTES:
                    VOICE_TURNS_TRUNCATED_TOTAL.inc()
                    logger.warning(
                        "voice turn reached the limit dialog=%s seconds=%d",
                        self._dialog.id,
                        APP_CONFIG.dialog.voice_turn_max_seconds,
                    )

    async def _on_audio_end(self) -> None:
        """Конец голосовой реплики. Распознавание идёт в очереди, а не здесь: сокет в это время читает `tts_cancel`.

        Реплика без `audio_end` (обрыв) сюда не доходит и отбрасывается вместе с сокетом.
        """
        if not self._audio_open:
            return
        frames, pcm = self._audio_frames, bytes(self._audio)
        interrupts = self._turn_interrupts
        if self._last_voiced is not None:
            VOICE_TURN_END_DELAY_SECONDS.observe(time.monotonic() - self._last_voiced)
        self._audio_open, self._audio_frames, self._audio = False, 0, bytearray()
        self._last_voiced, self._turn_interrupts = None, False
        if frames == 0:
            self._count_false_interruption(interrupts)
            self._release_held()  # это было ложное «человек заговорил»: оборванной реплике надо ответить
            await self._send({"type": "transcript", "text": "", "final": True})  # тишина: ни сообщения, ни ответа
            return
        turn = Turn(started=time.monotonic())
        self._jobs.put_nowait(lambda: self._voice_turn(frames, pcm, interrupts, turn))

    def _count_false_interruption(self, interrupts: bool) -> None:
        """Перебили, а сказать нечего: детектор принял за речь эхо голоса агента или шум. Текст не пишется."""
        if interrupts:
            VOICE_FALSE_INTERRUPTIONS_TOTAL.inc()
            logger.info("false interruption dialog=%s", self._dialog.id)

    async def _voice_turn(self, frames: int, pcm: bytes, interrupts: bool = False, turn: Turn | None = None) -> None:
        turn = turn or Turn(started=time.monotonic())
        turn.trace = self._tracer.start_turn(
            name="voice_turn",
            session_id=self._dialog.id,
            user_id=self._dialog.user_id,
            metadata={"frames": frames, "audio_seconds": round(frames * AUDIO_FRAME_SECONDS, 2), "interrupts": interrupts},
            tags=[self._pipeline],
        )
        with model_usage.collect() as heard:  # расход распознавания — на реплику человека, а если её не будет, на диалог
            text = await self._recognize(frames, pcm, turn.trace)
        if text is None:
            self._store.add_usage(self._dialog, None, heard)
            turn.trace.update(level="ERROR", status="распознавание недоступно")
            turn.trace.end()
            turn.trace = None
            self._release_held()
            return  # распознавание не сработало, error уже ушёл
        if self._recognizer is not None and text and turn.started is not None:
            VOICE_LATENCY_SECONDS.labels("stt", self._memory_label()).observe(time.monotonic() - turn.started)
        if not text or (interrupts and self._is_echo(text)):
            self._store.add_usage(self._dialog, None, heard)
            turn.trace.update(metadata={"discarded": True, "reason": "silence_or_echo"})
            turn.trace.end()
            turn.trace = None
            self._count_false_interruption(interrupts)
            self._release_held()
            await self._send({"type": "transcript", "text": "", "final": True})  # тишина: ни сообщения, ни ответа
            return
        self._end_held_trace()
        self._held = None  # ответ на эту реплику отвечает и на оборванную перед ней
        self._supersede_speech()
        message = self._store.add_message(
            self._dialog, "user", text[:MAX_USER_TEXT], audio_seconds=round(frames * AUDIO_FRAME_SECONDS, 3)
        )
        self._store.add_usage(self._dialog, message.id, heard)
        turn.trace.update(input=message.text)
        # На голосовую реплику ack не нужен: final-транскрипт несёт id сохранённого сообщения.
        await self._send({"type": "transcript", "text": message.text, "final": True, "messageId": message.id})
        crisis = is_crisis(message.text)
        model_usage.call("safety")
        if crisis:
            self._store.mark_crisis(self._dialog)  # извлечение памяти из такого разговора пропускается (I13)
            await self._send({"type": "safety", "text": CRISIS_SAFETY_TEXT})
        elif APP_CONFIG.dialog.incomplete_hold_ms and looks_unfinished(message.text):
            self._hold(turn)
            return
        await self._reply(crisis, turn)

    def _is_echo(self, heard: str) -> bool:
        """Услышанное при перебивании — слова самого агента (последний ответ или приветствие), а не человека."""
        spoken = [m.text for m in reversed(self._dialog.messages) if m.role == "assistant"][:1]
        if self._dialog.greeting:
            spoken.append(self._dialog.greeting)
        if not any(is_echo(heard, text) for text in spoken):
            return False
        VOICE_ECHO_TOTAL.inc()
        logger.info("echo of the agent heard as speech dialog=%s", self._dialog.id)
        return True

    # ─── оборванная на полуслове реплика ──────────────────────────────────────

    def _hold(self, turn: Turn) -> None:
        """Реплика оборвана на союзе, запятой, многоточии: отвечать сразу значит перебить человека на середине мысли.

        Ответ откладывается на `INCOMPLETE_HOLD_MS`. Если человек заговорит раньше, ответом на оба куска будет один
        (модель видит их как одну реплику); если нет, ответ уходит по таймеру.
        """
        VOICE_HELD_TURNS_TOTAL.inc()
        self._held = turn
        self._hold_timer = asyncio.create_task(self._hold_expires())

    async def _hold_expires(self) -> None:
        await asyncio.sleep(APP_CONFIG.dialog.incomplete_hold_ms / 1000)
        self._hold_timer = None
        self._release_held()

    def _pause_hold(self) -> None:
        """Таймер остановлен, но ответ на оборванную реплику не забыт: если новая реплика окажется шумом, он уйдёт."""
        if self._hold_timer is not None:
            self._hold_timer.cancel()
            self._hold_timer = None

    def _drop_hold(self) -> None:
        self._pause_hold()
        self._end_held_trace()
        self._held = None

    def _end_held_trace(self) -> None:
        """Трассу оборванной реплики закрыть: отдельного ответа на неё не будет, ответит следующий ход."""
        held = self._held
        if held is not None and held.trace is not None:
            held.trace.update(metadata={"merged_into_next": True})
            held.trace.end()
            held.trace = None

    def _release_held(self) -> None:
        """Ответить на оборванную реплику сейчас."""
        held, self._held = self._held, None
        self._pause_hold()
        if held is not None and not self._closed:
            self._jobs.put_nowait(lambda: self._reply(False, held))

    async def _recognize(self, frames: int, pcm: bytes, trace: Observation | None = None) -> str | None:
        """Текст реплики; "" — тишина; None — распознавание недоступно (`error VOICE_UNAVAILABLE` уже ушёл)."""
        if self._recognizer is None:
            # Режим без моделей: текст реплики говорит только о её длительности.
            seconds = max(1, round(frames * AUDIO_FRAME_SECONDS))
            return f"[голосовая реплика, {seconds} с]"
        if is_silence(pcm):
            return ""
        span = self._tracer.start_span(
            trace, name="stt", metadata={"model": self._recognizer.name, "audio_bytes": len(pcm), "frames": frames}
        )
        try:
            async with asyncio.timeout(APP_CONFIG.llm.stt_timeout_seconds):
                text = await self._recognizer.transcribe(pcm)
        except (ModelError, TimeoutError) as error:
            span.update(level="ERROR", status=str(error)[:160])
            span.end()
            logger.warning("stt failed dialog=%s: %s", self._dialog.id, error)
            await self._send({"type": "error", "code": "VOICE_UNAVAILABLE", "message": "Не удалось распознать речь"})
            return None
        span.update(output=text, metadata={"chars": len(text)})
        span.end()
        return text

    async def _on_end(self, frame: dict[str, Any]) -> bool:
        takeaway = frame.get("takeaway") if isinstance(frame.get("takeaway"), str) else None
        tension = frame.get("tensionAfter")
        tension_after = tension if isinstance(tension, int) and not isinstance(tension, bool) and 1 <= tension <= 10 else None
        # Поле «Что забираешь с собой» и есть итог: заполнено — сохраняется сразу; пусто — итог подведётся в фоне.
        source = "draft" if frame.get("recapSource") == "draft" else "manual"
        summary = self._store.end(self._dialog, takeaway, tension_after, source)
        await self._send({"type": "ended", "summary": summary})
        self._closed = True
        try:
            await self._ws.close(code=1000)
        except (RuntimeError, WebSocketDisconnect, OSError):
            pass
        return True

    # ─── ответ ────────────────────────────────────────────────────────────────

    def _template(self) -> str:
        """Следующий ответ-заглушка режима без моделей (`LLM_MODE=template`)."""
        text = next_reply(self._dialog.reply_index)
        self._dialog.reply_index += 1
        return text

    @staticmethod
    async def _fixed(text: str) -> AsyncIterator[str]:
        """Готовый текст как поток предложений: шаблон и кризисный ответ идут тем же путём, что и ответ модели."""
        for sentence in split_sentences(text):
            yield sentence

    async def _model_sentences(self, trace: Observation | None = None) -> AsyncIterator[str]:
        """Предложения ответа модели по мере написания. Отказ или таймаут поднимаются, когда до них доходит очередь."""
        out: asyncio.Queue[str | Exception | None] = asyncio.Queue()
        pump = asyncio.create_task(self._pump_chat(out, trace))
        try:
            while (item := await out.get()) is not None:
                if isinstance(item, Exception):
                    raise item
                yield item
        finally:
            pump.cancel()  # не ждём: сам разберётся с потоком модели, а тот, кто читает ответ, не должен ждать сеть

    async def _pump_chat(self, out: asyncio.Queue[str | Exception | None], trace: Observation | None = None) -> None:
        """Читает поток модели и складывает готовые предложения в очередь. Таймаут — на модель, а не на тех, кто читает."""
        assert self._chat is not None
        # Сводка памяти — из кэша процесса (I3); у разговора «Без памяти» и при любой ошибке памяти она пустая.
        memory = self._store.memory_brief(self._dialog)
        messages = chat_messages(self._dialog.messages, APP_CONFIG.llm.history_messages, memory, self._dialog.voice)
        generation = self._tracer.start_generation(trace, name="chat", model=self._chat.name, input=messages)
        # Расход токенов умеет отдавать только настоящий прокси (финальный SSE-кусок), у фейков и шаблонов его нет.
        usage_sink: list[dict[str, Any]] | None = [] if isinstance(self._chat, ProxyChat) else None
        # Инструмент поиска в памяти — только прокси, только при MEMORY_RECALL_TOOL и бэкенде с прямым поиском (Cognee).
        # По умолчанию выключен: синхронный recall — это 10–30 с паузы посреди голосового хода.
        tools = (
            RECALL_TOOLS
            if usage_sink is not None
            and APP_CONFIG.memory.recall_tool
            and self._store.memory_recall_supported(self._dialog)
            else None
        )
        buffer, total, full = "", 0, False
        truncated = False
        emitted: list[str] = []

        def offer(sentence: str) -> bool:
            """Положить предложение в очередь; False, если ответ уже дошёл до предела длины."""
            nonlocal total
            if total and total + len(sentence) > MAX_REPLY_CHARS:
                return False
            total += len(sentence) + 1
            emitted.append(sentence[:MAX_REPLY_CHARS])
            out.put_nowait(sentence[:MAX_REPLY_CHARS])
            return True

        async def run_pass(pass_messages: list[dict[str, Any]], pass_tools: list[dict[str, Any]] | None) -> None:
            """Один проход потока модели. Вызов инструмента поднимает ToolCallRequested — разбирает тот, кто вызвал."""
            nonlocal buffer, full, truncated
            try:
                if usage_sink is not None:
                    stream_ctx = self._chat.stream(pass_messages, usage_sink=usage_sink, tools=pass_tools)  # type: ignore[call-arg]
                else:
                    stream_ctx = self._chat.stream(pass_messages)
                async with aclosing(stream_ctx) as stream:
                    async for piece in stream:
                        buffer += piece
                        sentences, buffer = take_sentences(buffer)
                        full = not all(offer(sentence) for sentence in sentences)
                        if full:
                            break  # дальше читать незачем: остальное не влезет
            except ReplyTruncated:
                truncated = True
                buffer = ""  # оборван по лимиту токенов: недописанный хвост не берём

        try:
            # Таймаут — на каждый проход модели отдельно и на recall отдельно: tool-flow длиннее одного хода
            # (проход → recall 15–30 с → второй проход), общий таймаут сгорал бы посреди поиска.
            try:
                async with asyncio.timeout(APP_CONFIG.llm.timeout_seconds):
                    await run_pass(messages, tools)
            except ToolCallRequested as requested:
                # Модель попросила память: исполняем recall и просим ответ ещё раз, уже с находкой (без инструментов).
                call = requested.calls[0]
                query = call.query()
                if query is None:
                    raise ModelError("Чат-модель вызвала инструмент с мусорными аргументами")
                # Поиск идёт 10–30 с: без этой фразы человек всё это время слышал бы тишину в «Думаю»
                offer("Секунду, вспомню…")
                # Бюджет recall — двойной таймаут модели: GRAPH_COMPLETION идёт 15–30 с, в одиночный не влезает.
                # Не успел — отвечаем без находки (модель скажет «не нашлось»), а не обрываем весь ход.
                try:
                    async with asyncio.timeout(APP_CONFIG.llm.timeout_seconds * 2):
                        found = await self._store.memory_recall_now(self._dialog, query)
                except TimeoutError:
                    logger.warning("memory recall timed out dialog=%s", self._dialog.id)
                    found = ""
                followup: list[dict[str, Any]] = [
                    *messages,
                    call.assistant_message(),
                    {
                        "role": "tool",
                        "tool_call_id": call.id,
                        "content": found or "В памяти по этому вопросу ничего не нашлось.",
                    },
                ]
                async with asyncio.timeout(APP_CONFIG.llm.timeout_seconds):
                    await run_pass(followup, None)
            if not full:
                for sentence in take_sentences(buffer, final=True)[0]:
                    if not offer(sentence):
                        break
            generation.update(
                output=" ".join(emitted) or None,
                usage=usage_sink[0] if usage_sink else None,
                metadata={"truncated_by_tokens": truncated, "max_reply_chars_hit": full},
            )
            out.put_nowait(None)
        except (ModelError, TimeoutError) as error:
            generation.update(level="ERROR", status=str(error)[:200])
            out.put_nowait(error)
        finally:
            generation.end()

    async def _reply(self, crisis: bool, turn: Turn | None = None, text: str | None = None) -> None:
        """Ответ потоком: первое предложение уходит в текст и в озвучку, как только модель его дописала.

        `text` — готовая фраза вместо ответа модели (например, просьба повторить): идёт тем же путём, что кризисный ответ."""
        dialog = self._dialog
        turn = turn or Turn(started=time.monotonic())
        message_id = str(uuid.uuid4())
        sentences: list[str] = []
        speech: SpeechFeed | None = None
        message: Message | None = None
        began = time.monotonic()
        used_template = False

        async def deliver(source: AsyncIterator[str]) -> None:
            nonlocal speech, message
            async with aclosing(source) as stream:
                async for sentence in stream:
                    if self._closed:
                        return
                    prefix = " " if sentences else ""
                    if not sentences:
                        VOICE_LATENCY_SECONDS.labels("first_sentence", self._memory_label()).observe(
                            time.monotonic() - began
                        )
                        await self._send({"type": "assistant_start", "messageId": message_id})
                        speech = self._start_speech(message_id, turn)
                    sentences.append(sentence)
                    # Ответ лежит в истории с первого предложения и дописывается: порядок сообщений тот, что видит человек,
                    # а после обрыва клиент найдёт там всё, что успело прозвучать и показаться.
                    if message is None:
                        message = self._store.add_message(dialog, "assistant", sentence, message_id)
                    else:
                        message.text = " ".join(sentences)
                    if speech is not None:
                        speech.add(sentence)
                    # Дельты в сумме дают ровно текст ответа: предложения через пробел, как в assistant_end.text.
                    for piece in re.findall(r"\S+\s*", sentence):
                        if self._closed:
                            return
                        if self._stream_delay:
                            await asyncio.sleep(self._stream_delay)
                        await self._send({"type": "assistant_delta", "messageId": message_id, "text": prefix + piece})
                        prefix = ""

        try:
            if crisis:
                await deliver(self._fixed(CRISIS_REPLY))
            elif text is not None:
                await deliver(self._fixed(text))
            else:
                if self._chat is not None:
                    # Расход чат-модели — на её ответ; если ответа нет (отказ, пусто), на диалог.
                    with model_usage.collect() as spent:
                        try:
                            await deliver(self._model_sentences(turn.trace))
                        except (ModelError, TimeoutError) as error:
                            # После первых предложений отказ не страшен: человек уже слышит начало, договариваем им.
                            # У TimeoutError пустой str — в журнал пишем и тип, иначе строка выходит пустой.
                            logger.warning("chat failed dialog=%s: %s", dialog.id, str(error) or type(error).__name__)
                        else:
                            if not sentences:
                                logger.warning("chat returned nothing dialog=%s", dialog.id)
                        finally:
                            self._store.add_usage(dialog, message_id, spent)
                if not sentences and self._stub_replies:
                    used_template = True
                    await deliver(self._fixed(self._template()))
                elif not sentences:
                    # Шаблона вместо ответа нет: не зная сказанного, он звучал невпопад. Человек видит честное «сейчас не могу
                    # ответить» и может повторить.
                    await self._send({"type": "error", "code": "AGENT_LLM_UNAVAILABLE", "message": "Модель не ответила"})
        finally:
            if speech is not None:
                speech.close()
            if turn.trace is not None:
                turn.trace.update(
                    output=" ".join(sentences) or None,
                    metadata={"crisis": crisis, "template": used_template},
                )
                turn.trace.end()
                turn.trace = None
        if sentences and not self._closed:
            await self._send({"type": "assistant_end", "messageId": message_id, "text": " ".join(sentences)})

    # ─── озвучка ──────────────────────────────────────────────────────────────

    def _forget_speech(self, message_id: str, task: asyncio.Task[None]) -> None:
        if self._speeches.get(message_id) is task:  # той же озвучки, а не новой под тем же id
            del self._speeches[message_id]

    def _cancel_speech(self, message_id: str) -> None:
        """Озвучку сообщения прекратить сразу: флаг для кадров в пути и отмена задачи, которая могла застрять на провайдере."""
        self._cancelled.add(message_id)
        task = self._speeches.get(message_id)
        if task is not None:
            task.cancel()

    def _supersede_speech(self) -> None:
        """Человек сказал новое: недоговорённое агентом больше не нужно. Новая озвучка не ждёт, пока доиграет прошлая."""
        for message_id in list(self._speeches):
            self._cancel_speech(message_id)

    def _start_speech(self, message_id: str, turn: Turn | None) -> SpeechFeed | None:
        """Озвучка сообщения, которое ещё пишется: куски текста подаются в `SpeechFeed.add`, `close` — конец."""
        tts = self._tts_source()
        if tts is None:
            return None
        return self._speech_with(tts, message_id, turn)

    def _speech_with(self, tts: TextToSpeech, message_id: str, turn: Turn | None) -> SpeechFeed:
        """Озвучка сообщения заданным провайдером (режим gemini_live озвучивает шаблоны хода без Gemini другим)."""
        feed = SpeechFeed()
        task = asyncio.create_task(self._speak(tts, message_id, feed.chunks, self._dialog.voice, turn))
        self._speech_tasks.add(task)
        self._speeches[message_id] = task
        task.add_done_callback(self._speech_tasks.discard)
        task.add_done_callback(lambda done: self._forget_speech(message_id, done))
        return feed

    def _speak_in_background(self, message_id: str, text: str) -> None:
        """Озвучка готового текста (приветствие)."""
        feed = self._start_speech(message_id, None)
        if feed is None:
            return
        for sentence in split_sentences(text):
            feed.add(sentence)
        feed.close()

    async def _speak(
        self,
        tts: TextToSpeech,
        message_id: str,
        chunks: asyncio.Queue[str | None],
        voice: Voice,
        turn: Turn | None = None,
    ) -> None:
        """tts_start → кадры 0x02 → tts_end, по кускам текста. `tts_start` уходит с первым готовым кадром.

        Куски приходят по мере написания ответа. Звук каждого читается потоком (если провайдер так умеет): кадр по
        200 мс уходит, как только набрался, не дожидаясь конца фразы. Синтез идёт с опережением (`SPEECH_PREFETCH`):
        пока звучит один кусок, следующий уже готовится, и между ними нет паузы на запрос к провайдеру. Кадры идут
        строго по порядку.

        Расход синтеза пишется на озвучиваемое сообщение (приветствие сообщением не является: его расход — на диалог), а в
        сообщение — сколько секунд звука ушло клиенту.
        """
        model_usage.bind(lambda item: self._store.add_usage(self._dialog, message_id, [item]))  # своя задача (`_start_speech`)
        async with self._speech_lock:
            if message_id in self._cancelled:
                return
            started = False
            sequence = 0
            sent_bytes = 0
            slots = asyncio.Semaphore(SPEECH_PREFETCH)
            syntheses: asyncio.Queue[Synthesis | None] = asyncio.Queue()
            planned: list[Synthesis] = []

            async def plan() -> None:
                first = True
                turn_trace = turn.trace if turn is not None else None
                while (text := await chunks.get()) is not None:
                    await slots.acquire()
                    synthesis = Synthesis(tts, text, voice, first, self._memory_label(), self._tracer, turn_trace)
                    first = False
                    planned.append(synthesis)
                    syntheses.put_nowait(synthesis)
                syntheses.put_nowait(None)

            async def send_frame(pcm: bytes) -> bool:
                """Отправить кадр; False, если озвучку прервали или сокет закрыт."""
                nonlocal started, sequence, sent_bytes
                if self._closed or message_id in self._cancelled:
                    return False
                if not started:
                    await self._send({"type": "tts_start", "messageId": message_id})
                    started = True
                    self._first_sound(message_id, turn)
                await self._send_audio(tts_frame(sequence, pcm))
                sequence += 1
                sent_bytes += len(pcm)
                if self._frame_interval:
                    await asyncio.sleep(self._frame_interval)
                return True

            planner = asyncio.create_task(plan())
            try:
                while (synthesis := await syntheses.get()) is not None:
                    pending = bytearray()
                    interrupted = False
                    while (piece := await synthesis.pieces.get()) is not None:
                        if isinstance(piece, Exception):
                            raise piece
                        pending += piece
                        while len(pending) >= FRAME_BYTES:
                            frame = bytes(pending[:FRAME_BYTES])
                            del pending[:FRAME_BYTES]
                            if not await send_frame(frame):
                                interrupted = True
                                break
                        if interrupted:
                            break
                    if interrupted or (pending and not await send_frame(bytes(pending))):
                        break
                    slots.release()
            except asyncio.CancelledError:
                raise
            except Exception as error:
                # Озвучка упала: текст дойдёт, а человек увидит, что голос недоступен.
                logger.warning("tts failed dialog=%s message=%s: %s", self._dialog.id, message_id, error)
                if not self._voice_error_sent:
                    self._voice_error_sent = True
                    await self._send({"type": "error", "code": "VOICE_UNAVAILABLE", "message": "Озвучка недоступна"})
            finally:
                # Недозвученное (перебили, обрыв, отказ) не синтезируем дальше. Отменённые задачи не ждём: их отказы
                # уже лежат в очередях звука, а ожидание затягивало завершение сессии (см. `run`).
                planner.cancel()
                for synthesis in planned:
                    synthesis.cancel()
                self._store.set_audio_seconds(self._dialog, message_id, sent_bytes / (2 * TTS_RATE))
                if started:
                    await self._send({"type": "tts_end", "messageId": message_id})

    def _first_sound(self, message_id: str, turn: Turn | None) -> None:
        """Первый звук ответа ушёл: сколько человек ждал с конца своей реплики. Без текстов и без id в метрике."""
        if turn is None or turn.started is None:
            return
        seconds = time.monotonic() - turn.started
        VOICE_LATENCY_SECONDS.labels("first_sound", self._memory_label()).observe(seconds)
        logger.info("first sound dialog=%s message=%s ms=%d", self._dialog.id, message_id, seconds * 1000)


async def _deny(websocket: WebSocket, status: int, code: str, message: str) -> None:
    """Отклонить рукопожатие HTTP-статусом (401/404/409), как требует контракт."""
    try:
        await websocket.send_denial_response(JSONResponse(error_body(code, message), status_code=status))
    except RuntimeError:
        # Сервер не умеет HTTP-ответ на рукопожатие: закрываем сокет, статус достанется библиотеке.
        await websocket.close(code=1008)


@router.websocket("/v1/users/{user_id}/dialogs/{dialog_id}/ws")
async def dialog_ws(websocket: WebSocket, user_id: str, dialog_id: str) -> None:
    if not token_ok(websocket.headers.get("authorization")):
        return await _deny(websocket, 401, "AGENT_UNAUTHORIZED", "Нужен внутренний токен")

    store: DialogStore = websocket.app.state.store
    canonical = canonical_user_id(user_id)
    if canonical:
        await store.ensure_user(canonical)  # после перезапуска диалоги человека поднимаются с диска
    dialog = store.get(canonical, dialog_id) if canonical else None
    # Чужой и несуществующий диалог неразличимы.
    if dialog is None:
        return await _deny(websocket, 404, "AGENT_DIALOG_NOT_FOUND", "Диалог не найден")
    # Один живой сокет на диалог: второе соединение отклоняем, первое не трогаем.
    if dialog.has_live_socket:
        return await _deny(websocket, 409, "AGENT_VALIDATION", "У диалога уже есть живое соединение")

    store.socket_opened(dialog)
    try:
        await websocket.accept()
        logger.info("socket opened dialog=%s", dialog.id)
        if dialog.ended_at is not None:
            # Диалог завершён (человек начал новый разговор с другого экрана, а этот был без связи): в него больше ничего не пишем.
            await websocket.send_text(json.dumps({"v": 1, "type": "ready"}))
            await websocket.send_text(json.dumps({"v": 1, "type": "ended", "summary": dialog.summary}, ensure_ascii=False))
            await websocket.close(code=1000)
            return
        live = websocket.app.state.live
        tracer = websocket.app.state.tracer
        if live is not None:  # VOICE_PIPELINE=gemini_live: речь в речь; бюджет Gemini исчерпан — разговор в каскаде
            from app.api.dialog_live import admit_session

            session: DialogSession = admit_session(websocket, store, dialog)
        else:
            session = DialogSession(
                websocket,
                store,
                dialog,
                lambda: active_tts(websocket.app),
                websocket.app.state.chat,
                websocket.app.state.recognizer,
                tracer,
            )
        session.bind_component_calls()
        await session.run()
    finally:
        store.socket_closed(dialog)
        logger.info("socket closed dialog=%s", dialog.id)
