"""WebSocket-эндпоинт диалога: текст и голос по контракту node-мока.

Кадры — JSON с полем `type` и версией протокола `v: 1` в каждом ответе.
Текстовый ход: `user_message` → `ack` → `assistant_start` → `assistant_delta` × N
→ `assistant_end`. Голосовой ход: `audio_start` → двоичные кадры PCM16 →
`audio_end` → транскрибация через whisper → `transcript { final: true }` →
дальше как текстовый ход. Озвучки ответов (TTS) в MVP нет: `tts_start` не шлём,
клиент читает ответы своим голосом (допустимо по specs/agent-api).
"""

import asyncio
import io
import json
import wave

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from loguru import logger
from starlette.responses import Response

from app.api.deps import AppContext, is_authorized
from app.core.config import APP_CONFIG
from app.graph.turn_graph import run_turn

router = APIRouter()

PROTOCOL_VERSION = 1
"""Длина заголовка двоичного кадра: [вид: 1 байт][номер: uint32 BE]."""
AUDIO_FRAME_HEADER_BYTES = 5
AUDIO_FRAME_KIND_USER = 0x01
"""Частота входного PCM16-моно по контракту (specs/agent-api «Голос — формат и ввод»)."""
INPUT_SAMPLE_RATE = 16_000
"""Пауза между дельтами ответа, как STREAM_DELAY_MS в node-моке."""
STREAM_DELAY_SECONDS = 0.06


class _ConnectionState:
    """Состояние одного сокета: буфер голосовой реплики и карта client id."""

    def __init__(self, client_ids: dict[str, str]) -> None:
        self.audio = bytearray()
        self.client_ids = client_ids


_client_ids_by_dialog: dict[str, dict[str, str]] = {}
"""Повтор `user_message` с тем же id — то же сообщение, карта живёт, пока жив процесс."""


def _pcm_to_wav(pcm: bytes, sample_rate: int) -> bytes:
    """Оборачивает PCM16-моно в WAV-контейнер для whisper API."""
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(pcm)
    return buffer.getvalue()


async def _send(socket: WebSocket, frame: dict) -> None:
    """Отправляет JSON-кадр с версией протокола."""
    await socket.send_json({"v": PROTOCOL_VERSION, **frame})


def _buffer_audio(state: _ConnectionState, data: bytes) -> None:
    """Добавляет сэмплы двоичного кадра в буфер, снимая заголовок вида 0x01."""
    if len(data) >= AUDIO_FRAME_HEADER_BYTES and data[0] == AUDIO_FRAME_KIND_USER:
        state.audio.extend(data[AUDIO_FRAME_HEADER_BYTES:])
    else:
        state.audio.extend(data)


async def _run_reply(
    socket: WebSocket,
    ctx: AppContext,
    *,
    user_id: str,
    dialog_id: str,
    text: str,
) -> None:
    """Один ход диалога: LLM-ответ, сохранение и поток кадров assistant_*."""
    try:
        reply = await asyncio.wait_for(
            run_turn(ctx.graph, user_id=user_id, dialog_id=dialog_id, text=text),
            timeout=APP_CONFIG.security.turn_timeout_seconds,
        )
    except TimeoutError:
        logger.warning("Таймаут хода диалога {} у пользователя {}", dialog_id, user_id)
        await _send(socket, {"type": "error", "code": "AGENT_TIMEOUT", "message": "turn timeout"})
        return
    except Exception:
        logger.exception("Ход диалога {} завершился ошибкой", dialog_id)
        await _send(
            socket,
            {"type": "error", "code": "AGENT_LLM_UNAVAILABLE", "message": "llm is unavailable"},
        )
        return

    message = await ctx.store.append_message(dialog_id, "assistant", reply)
    message_id = message["id"]
    await _send(socket, {"type": "assistant_start", "messageId": message_id})
    for word in reply.split(" "):
        await asyncio.sleep(STREAM_DELAY_SECONDS)
        await _send(
            socket,
            {"type": "assistant_delta", "messageId": message_id, "text": f"{word} "},
        )
    await _send(socket, {"type": "assistant_end", "messageId": message_id, "text": reply})


async def _handle_user_message(
    socket: WebSocket,
    ctx: AppContext,
    state: _ConnectionState,
    *,
    user_id: str,
    dialog_id: str,
    frame: dict,
) -> None:
    """Текстовая реплика: дедупликация по id, сохранение, ack, ответ."""
    client_id = frame.get("id")
    known = state.client_ids.get(client_id) if isinstance(client_id, str) else None
    if known is not None:
        await _send(socket, {"type": "ack", "id": client_id, "messageId": known})
        return
    text = str(frame.get("text") or "")
    message = await ctx.store.append_message(dialog_id, "user", text)
    if isinstance(client_id, str):
        state.client_ids[client_id] = message["id"]
    await _send(
        socket,
        {"type": "ack", "id": client_id or message["id"], "messageId": message["id"]},
    )
    await _run_reply(socket, ctx, user_id=user_id, dialog_id=dialog_id, text=text)


async def _handle_audio_end(
    socket: WebSocket,
    ctx: AppContext,
    state: _ConnectionState,
    *,
    user_id: str,
    dialog_id: str,
) -> None:
    """Голосовая реплика: транскрибация буфера, transcript, ответ как на текст."""
    pcm = bytes(state.audio)
    state.audio.clear()
    if not pcm:
        await _send(socket, {"type": "transcript", "text": "", "final": True})
        return
    try:
        wav = _pcm_to_wav(pcm, INPUT_SAMPLE_RATE)
        text = (
            await ctx.llm.transcribe(
                wav, filename="audio.wav", model=APP_CONFIG.llm.whisper_model
            )
        ).strip()
    except Exception:
        logger.exception("Транскрибация голосовой реплики диалога {} не удалась", dialog_id)
        await _send(
            socket,
            {"type": "error", "code": "VOICE_UNAVAILABLE", "message": "voice is unavailable"},
        )
        return
    if not text:
        await _send(socket, {"type": "transcript", "text": "", "final": True})
        return
    message = await ctx.store.append_message(dialog_id, "user", text)
    await _send(
        socket,
        {"type": "transcript", "text": text, "final": True, "messageId": message["id"]},
    )
    await _run_reply(socket, ctx, user_id=user_id, dialog_id=dialog_id, text=text)


async def _handle_end(
    socket: WebSocket,
    ctx: AppContext,
    *,
    user_id: str,
    dialog_id: str,
    frame: dict,
) -> None:
    """Завершение по сокету: сводка, кадр ended и закрытие кодом 1000."""
    takeaway = frame.get("takeaway")
    tension_after = frame.get("tensionAfter")
    summary = await ctx.store.end_dialog(
        user_id,
        dialog_id,
        takeaway if isinstance(takeaway, str) else None,
        tension_after if isinstance(tension_after, int) else None,
    )
    await _send(socket, {"type": "ended", "summary": summary["summary"] if summary else None})
    await socket.close(code=1000, reason="dialog ended")


@router.websocket("/v1/users/{user_id}/dialogs/{dialog_id}/ws")
async def dialog_ws(websocket: WebSocket, user_id: str, dialog_id: str) -> None:
    """Сокет диалога: ready первым кадром, дальше текстовые и голосовые ходы."""
    if not is_authorized(websocket.headers.get("authorization")):
        await websocket.send_denial_response(Response(status_code=401))
        return
    ctx: AppContext = websocket.app.state.ctx
    try:
        dialog = await ctx.store.get_dialog(user_id, dialog_id)
    except ValueError:
        dialog = None
    if dialog is None:
        await websocket.send_denial_response(Response(status_code=404))
        return

    await websocket.accept()
    logger.info("Сокет диалога {} пользователя {} открыт", dialog_id, user_id)
    state = _ConnectionState(_client_ids_by_dialog.setdefault(dialog_id, {}))
    await _send(websocket, {"type": "ready"})

    try:
        while True:
            incoming = await websocket.receive()
            if incoming["type"] == "websocket.disconnect":
                break
            if incoming.get("bytes") is not None:
                _buffer_audio(state, incoming["bytes"])
                continue
            text_data = incoming.get("text")
            if text_data is None:
                continue
            try:
                frame = json.loads(text_data)
            except json.JSONDecodeError:
                await _send(
                    websocket,
                    {"type": "error", "code": "BAD_FRAME", "message": "not a json frame"},
                )
                continue

            frame_type = frame.get("type")
            if frame_type == "user_message":
                await _handle_user_message(
                    websocket, ctx, state, user_id=user_id, dialog_id=dialog_id, frame=frame
                )
            elif frame_type == "audio_start":
                state.audio.clear()
            elif frame_type == "audio_end":
                await _handle_audio_end(
                    websocket, ctx, state, user_id=user_id, dialog_id=dialog_id
                )
            elif frame_type == "tts_cancel":
                pass
            elif frame_type == "end":
                await _handle_end(
                    websocket, ctx, user_id=user_id, dialog_id=dialog_id, frame=frame
                )
                return
            else:
                await _send(
                    websocket,
                    {"type": "error", "code": "UNKNOWN_FRAME", "message": str(frame_type)},
                )
    except WebSocketDisconnect:
        pass
    finally:
        logger.info("Сокет диалога {} пользователя {} закрыт", dialog_id, user_id)
