"""WebSocket диалога: текст и голос (specs/agent-api «Разговор по WebSocket», «Голос»).

Один сокет на диалог. Реплики идут в очередь и обрабатываются по одной; `tts_cancel` действует сразу.
Ответ агента шаблонный (app.services.replies), озвучка настоящая (app.clients.speech).
"""

import asyncio
import json
import logging
import re
from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

from app.api.deps import active_tts, canonical_user_id, token_ok
from app.clients.speech import TextToSpeech, pcm_chunks, tts_frame
from app.core.config import APP_CONFIG
from app.core.errors import error_body
from app.services.dialog_store import Dialog, DialogStore
from app.services.replies import CRISIS_REPLY, CRISIS_SAFETY_TEXT, is_crisis, next_reply, split_sentences

logger = logging.getLogger("agent.ws")

router = APIRouter()

FRAME_KIND_AUDIO_IN = 0x01
MAX_USER_TEXT = 4000
# Один кадр голоса человека — 100 мс (specs/agent-api «Голос — формат и ввод»).
AUDIO_FRAME_SECONDS = 0.1


class DialogSession:
    def __init__(
        self,
        websocket: WebSocket,
        store: DialogStore,
        dialog: Dialog,
        tts_source: Callable[[], TextToSpeech | None],
    ) -> None:
        self._ws = websocket
        self._store = store
        self._dialog = dialog
        # Озвучка берётся при каждой реплике: dev-режим может выключить её на лету.
        self._tts_source = tts_source
        self._stream_delay = APP_CONFIG.dialog.stream_delay_ms / 1000
        self._frame_interval = APP_CONFIG.speech.tts_frame_interval_ms / 1000

        self._closed = False
        self._send_lock = asyncio.Lock()
        # Озвучки двух сообщений не перемежаются: каждая берёт замок целиком.
        self._speech_lock = asyncio.Lock()
        self._jobs: asyncio.Queue[Callable[[], Awaitable[None]]] = asyncio.Queue()
        self._speech_tasks: set[asyncio.Task[None]] = set()
        self._cancelled: set[str] = set()
        self._voice_error_sent = False
        self._audio_open = False
        self._audio_frames = 0

    # ─── отправка ─────────────────────────────────────────────────────────────

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

    async def run(self) -> None:
        await self._send({"type": "ready"})
        dialog = self._dialog
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
            worker.cancel()
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
                self._audio_open = True
                self._audio_frames = 0
            case "audio_end":
                await self._on_audio_end()
            case "tts_cancel":
                message_id = frame.get("messageId")
                if isinstance(message_id, str):
                    self._cancelled.add(message_id)
            case "end":
                return await self._on_end(frame)
        return False

    async def _on_user_message(self, frame: dict[str, Any]) -> None:
        text = frame.get("text")
        client_id = frame.get("id") if isinstance(frame.get("id"), str) and frame.get("id") else None
        if not isinstance(text, str) or not text.strip():
            return
        dialog = self._dialog
        # Клиент повторяет реплику, пока нет ack: тот же id — то же сообщение, без второго ответа.
        if client_id and client_id in dialog.client_ids:
            await self._send({"type": "ack", "id": client_id, "messageId": dialog.client_ids[client_id]})
            return
        message = self._store.add_message(dialog, "user", text[:MAX_USER_TEXT])
        if client_id:
            dialog.client_ids[client_id] = message.id
        await self._send({"type": "ack", "id": client_id or message.id, "messageId": message.id})
        crisis = is_crisis(text)
        if crisis:
            await self._send({"type": "safety", "text": CRISIS_SAFETY_TEXT})
        self._jobs.put_nowait(lambda: self._reply(crisis))

    def _on_audio_frame(self, data: bytes) -> None:
        if self._audio_open and len(data) > 5 and data[0] == FRAME_KIND_AUDIO_IN:
            self._audio_frames += 1

    async def _on_audio_end(self) -> None:
        """Распознавание-заглушка: текст реплики говорит только о её длительности.

        Реплика без `audio_end` (обрыв) сюда не доходит и отбрасывается вместе с сокетом.
        """
        if not self._audio_open:
            return
        frames, self._audio_open, self._audio_frames = self._audio_frames, False, 0
        if frames == 0:
            await self._send({"type": "transcript", "text": "", "final": True})  # тишина: ни сообщения, ни ответа
            return
        seconds = max(1, round(frames * AUDIO_FRAME_SECONDS))
        text = f"[голосовая реплика, {seconds} с]"
        message = self._store.add_message(self._dialog, "user", text)
        # На голосовую реплику ack не нужен: final-транскрипт несёт id сохранённого сообщения.
        await self._send({"type": "transcript", "text": text, "final": True, "messageId": message.id})
        self._jobs.put_nowait(lambda: self._reply(False))

    async def _on_end(self, frame: dict[str, Any]) -> bool:
        takeaway = frame.get("takeaway") if isinstance(frame.get("takeaway"), str) else None
        tension = frame.get("tensionAfter")
        tension_after = tension if isinstance(tension, int) and not isinstance(tension, bool) and 1 <= tension <= 10 else None
        summary = self._store.end(self._dialog, takeaway, tension_after)
        await self._send({"type": "ended", "summary": summary})
        self._closed = True
        try:
            await self._ws.close(code=1000)
        except (RuntimeError, WebSocketDisconnect, OSError):
            pass
        return True

    # ─── ответ ────────────────────────────────────────────────────────────────

    async def _reply(self, crisis: bool) -> None:
        dialog = self._dialog
        if crisis:
            text = CRISIS_REPLY
        else:
            text = next_reply(dialog.reply_index)
            dialog.reply_index += 1
        # Законченный ответ лежит в истории сразу: после обрыва клиент найдёт его там.
        message = self._store.add_message(dialog, "assistant", text)

        await self._send({"type": "assistant_start", "messageId": message.id})
        # Голос стартует вместе с текстом: первое предложение звучит, пока дописывается остальное.
        self._speak_in_background(message.id, text)
        # Дельты в сумме дают ровно текст ответа: assistant_end.text совпадает с их склейкой.
        for piece in re.findall(r"\S+\s*", text):
            if self._closed:
                return
            if self._stream_delay:
                await asyncio.sleep(self._stream_delay)
            await self._send({"type": "assistant_delta", "messageId": message.id, "text": piece})
        await self._send({"type": "assistant_end", "messageId": message.id, "text": text})

    # ─── озвучка ──────────────────────────────────────────────────────────────

    def _speak_in_background(self, message_id: str, text: str) -> None:
        tts = self._tts_source()
        if tts is None or not text:
            return
        task = asyncio.create_task(self._speak(tts, message_id, text))
        self._speech_tasks.add(task)
        task.add_done_callback(self._speech_tasks.discard)

    async def _speak(self, tts: TextToSpeech, message_id: str, text: str) -> None:
        """tts_start → кадры 0x02 → tts_end, по предложениям. `tts_start` уходит, когда готов первый звук."""
        async with self._speech_lock:
            if message_id in self._cancelled:
                return
            started = False
            sequence = 0
            try:
                for sentence in split_sentences(text):
                    if self._closed or message_id in self._cancelled:
                        break
                    pcm = await tts.synthesize(sentence)
                    if self._closed or message_id in self._cancelled:
                        break  # перебили, пока синтезировалось: не начинаем озвучку
                    if not started:
                        await self._send({"type": "tts_start", "messageId": message_id})
                        started = True
                    for chunk in pcm_chunks(pcm):
                        if self._closed or message_id in self._cancelled:
                            break
                        await self._send_audio(tts_frame(sequence, chunk))
                        sequence += 1
                        if self._frame_interval:
                            await asyncio.sleep(self._frame_interval)
            except asyncio.CancelledError:
                raise
            except Exception as error:
                # Озвучка упала: текст дойдёт, а приложение прочитает ответ своим голосом.
                logger.warning("tts failed dialog=%s message=%s: %s", self._dialog.id, message_id, error)
                if not self._voice_error_sent:
                    self._voice_error_sent = True
                    await self._send({"type": "error", "code": "VOICE_UNAVAILABLE", "message": "Озвучка недоступна"})
            finally:
                if started:
                    await self._send({"type": "tts_end", "messageId": message_id})


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
    dialog = store.get(canonical, dialog_id) if canonical else None
    # Чужой и несуществующий диалог неразличимы.
    if dialog is None:
        return await _deny(websocket, 404, "AGENT_DIALOG_NOT_FOUND", "Диалог не найден")
    # Один живой сокет на диалог: второе соединение отклоняем, первое не трогаем.
    if dialog.has_live_socket:
        return await _deny(websocket, 409, "AGENT_VALIDATION", "У диалога уже есть живое соединение")

    dialog.has_live_socket = True
    try:
        await websocket.accept()
        logger.info("socket opened dialog=%s", dialog.id)
        await DialogSession(websocket, store, dialog, lambda: active_tts(websocket.app)).run()
    finally:
        dialog.has_live_socket = False
        logger.info("socket closed dialog=%s", dialog.id)
