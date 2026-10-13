"""Общее для посева и пост-деплойных проверок: клиент публичного API и сокет диалога.

Только то, что делает приложение: REST с конвертом {status, result} и WSS /api/dialogs/ws (см. app/packages/contracts/src/api).
Текстов реплик в журнал не пишем: в отчётах только размеры и коды.
"""

from __future__ import annotations

import json
import os
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

import requests
import websocket

BASE_URL = os.environ.get("PUBLIC_BASE_URL", "https://xn----htbtgjker8b3a2c.xn--p1ai").rstrip("/")
WS_URL = BASE_URL.replace("https://", "wss://").replace("http://", "ws://") + "/api/dialogs/ws"

# Нейтральная реплика: не про кризис, чтобы не включать горячие линии и кризисный ответ.
TURN_TEXT = "Привет! Это проверка после обновления. Ответь, пожалуйста, одним коротким предложением."
READY_TIMEOUT = 15
TURN_TIMEOUT = 90
AFTER_TEXT_TTS_WAIT = 20  # сколько ждать озвучку после конца текста ответа

AUDIO_TTS_KIND = 0x02
FRAME_HEADER_BYTES = 5
PCM16_FRAME_BYTES = 9600  # 200 мс при 24 кГц
MULAW_FRAME_BYTES = 4800


class ApiError(RuntimeError):
    pass


class Api:
    """REST публичного API: HTTP-статус и конверт."""

    def __init__(self, base_url: str = BASE_URL) -> None:
        self.base_url = base_url
        self.session = requests.Session()

    def call(
        self, method: str, path: str, *, token: str | None = None, body: dict | None = None, params: dict | None = None
    ) -> tuple[int, Any]:
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        response = self.session.request(
            method, f"{self.base_url}{path}", json=body, params=params, headers=headers, timeout=30
        )
        try:
            return response.status_code, response.json()
        except ValueError:
            return response.status_code, None

    def result(self, method: str, path: str, **kwargs: Any) -> Any:
        """Успешный конверт -> result. Всё остальное -> ApiError (без тела ответа, оно может нести данные человека)."""
        code, payload = self.call(method, path, **kwargs)
        if code != 200 or not isinstance(payload, dict) or payload.get("status") is not True:
            reason = payload.get("errorCode") if isinstance(payload, dict) else None
            raise ApiError(f"{method} {path}: HTTP {code} {reason or ''}".strip())
        return payload["result"]

    def device_login(self, device_id: str, device_key: str) -> dict:
        return self.result("POST", "/api/auth/device", body={"deviceId": device_id, "deviceKey": device_key})

    def accept_consents(self, token: str, offer_version: str) -> None:
        self.result(
            "POST",
            "/api/auth/me/consents",
            token=token,
            body={
                "ageConfirmed": True,
                "disclaimerAccepted": True,
                "offerAccepted": True,
                "offerVersion": offer_version,
            },
        )

    def list_dialogs(self, token: str) -> list[dict]:
        """Все страницы списка диалогов."""
        items: list[dict] = []
        cursor: str | None = None
        for _ in range(50):
            result = self.result("GET", "/api/dialogs", token=token, params={"cursor": cursor} if cursor else None)
            items += result["items"]
            cursor = result.get("next")
            if not cursor:
                break
        return items

    def get_dialog(self, token: str, dialog_id: str) -> dict:
        return self.result("GET", f"/api/dialogs/{dialog_id}", token=token)

    def start_dialog(self, token: str, **body: Any) -> dict:
        return self.result("POST", "/api/dialogs", token=token, body={"mode": "vent", **body})


@dataclass
class TurnResult:
    """Что пришло на одну реплику. Тексты не журналируются: только размеры."""

    ack: bool = False
    assistant_text: str = ""
    tts_codec: str | None = None
    tts_sample_rate: int | None = None
    audio_frames: list[bytes] = field(default_factory=list)  # тела кадров без заголовка
    audio_seq: list[int] = field(default_factory=list)
    frame_types: list[str] = field(default_factory=list)
    seconds_to_first_text: float | None = None
    seconds_total: float = 0.0


class DialogSocket:
    """Один сокет диалога: hello -> ready -> реплики."""

    def __init__(self, token: str, dialog_id: str, codecs: list[str] | None = None) -> None:
        self.ws = websocket.create_connection(WS_URL, timeout=READY_TIMEOUT)
        hello: dict[str, Any] = {"type": "hello", "token": token, "dialogId": dialog_id}
        if codecs is not None:
            hello["codecs"] = codecs
        self.ws.send(json.dumps(hello))
        self.ready = self._next_json()
        if self.ready.get("type") != "ready":
            raise ApiError(f"ожидали ready, пришло {self.ready.get('type')} {self.ready.get('code', '')}".strip())
        self.ws.settimeout(TURN_TIMEOUT)

    def _next_json(self) -> dict:
        while True:
            frame = self.ws.recv()
            if isinstance(frame, bytes):
                continue
            if not frame.strip():
                continue
            return json.loads(frame)

    def run_turn(self, text: str = TURN_TEXT) -> TurnResult:
        """Реплика человека и ответ целиком: текст и озвучка до tts_end (или до тишины, если озвучки нет)."""
        result = TurnResult()
        client_id = uuid.uuid4().hex
        started = time.monotonic()
        self.ws.send(json.dumps({"type": "message", "clientId": client_id, "text": text}, ensure_ascii=False))
        text_done_at: float | None = None
        tts_done = False
        deadline = started + TURN_TIMEOUT
        while time.monotonic() < deadline:
            wait = AFTER_TEXT_TTS_WAIT if text_done_at is not None else TURN_TIMEOUT
            self.ws.settimeout(max(1.0, min(wait, deadline - time.monotonic())))
            try:
                frame = self.ws.recv()
            except websocket.WebSocketTimeoutException:
                if text_done_at is not None:
                    break  # текст пришёл, озвучки нет
                raise
            if isinstance(frame, bytes):
                if len(frame) >= FRAME_HEADER_BYTES and frame[0] == AUDIO_TTS_KIND:
                    result.audio_seq.append(int.from_bytes(frame[1:5], "big"))
                    result.audio_frames.append(frame[FRAME_HEADER_BYTES:])
                continue
            if not frame.strip():
                continue
            data = json.loads(frame)
            kind = data.get("type")
            result.frame_types.append(str(kind))
            if kind == "error":
                raise ApiError(f"ошибка в сокете: {data.get('code')}")
            if kind == "ack" and data.get("clientId") == client_id:
                result.ack = True
            if kind in ("assistant_delta", "assistant_end") and result.seconds_to_first_text is None:
                result.seconds_to_first_text = time.monotonic() - started
            if kind == "assistant_end":
                result.assistant_text = data.get("text", "")
                text_done_at = text_done_at or time.monotonic()
            elif kind == "tts_start":
                result.tts_codec = data.get("codec")
                result.tts_sample_rate = data.get("sampleRate")
            elif kind == "tts_end":
                tts_done = True
            if text_done_at is not None and tts_done:
                break
        result.seconds_total = time.monotonic() - started
        return result

    def end(self, takeaway: str | None = None, tension_after: int | None = None) -> dict:
        frame: dict[str, Any] = {"type": "end"}
        if takeaway is not None:
            frame["takeaway"] = takeaway
        if tension_after is not None:
            frame["tensionAfter"] = tension_after
        self.ws.send(json.dumps(frame, ensure_ascii=False))
        self.ws.settimeout(TURN_TIMEOUT)
        while True:
            data = self._next_json()
            if data.get("type") == "ended":
                return data
            if data.get("type") == "error":
                raise ApiError(f"ошибка в сокете при завершении: {data.get('code')}")

    def close(self) -> None:
        try:
            self.ws.close()
        except Exception:  # noqa: BLE001
            pass

    def __enter__(self) -> "DialogSocket":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


def opus_packets(frame_body: bytes) -> list[bytes]:
    """Разбор кадра Opus: [uint16 BE длина][пакет]... Ошибка формата -> ValueError."""
    packets: list[bytes] = []
    pos = 0
    while pos < len(frame_body):
        if pos + 2 > len(frame_body):
            raise ValueError("обрезан заголовок длины пакета")
        size = int.from_bytes(frame_body[pos : pos + 2], "big")
        pos += 2
        if size == 0 or pos + size > len(frame_body):
            raise ValueError("длина пакета выходит за кадр")
        packets.append(frame_body[pos : pos + size])
        pos += size
    return packets
