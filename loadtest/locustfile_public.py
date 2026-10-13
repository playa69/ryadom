"""Публичный нагрузочный тест «Слышу Рядом»: как реальный пользователь, через интернет.

Полный клиентский путь против https://слышу-рядом.рф, без kubectl port-forward:
  1. access-токен из пула (pool.py; регистрация НЕ нагружается — пул готовится заранее);
  2. POST /api/dialogs — старт диалога (JWT);
  3. WSS /api/dialogs/ws — hello {token, dialogId} → ready → реплики message;
  4. конец: кадр end и закрытие сокета. Аккаунты остаются в пуле для следующих
     прогонов; диалоги завершаются штатно (ended), как у реальных пользователей.

Переменные окружения:
  PUBLIC_BASE_URL       default https://слышу-рядом.рф (punycode);
  LOADTEST_POOL         путь к pool.json (default: рядом с файлом);
  LOADTEST_THINK_MIN/MAX  пауза между репликами, сек (default 1/3 —
                          короче человеческой, чтобы 30 аккаунтов давали ~5 RPS).

Метрики: REST start_dialog / refresh, WS connect+hello, WS turn ttft
(до assistant_start), WS turn streaming, WS turn tts, WS turn total.
"""

from __future__ import annotations

import itertools
import json
import os
import random
import threading
import time
import uuid
from pathlib import Path

import requests
import websocket
from locust import HttpUser, between, events, task

BASE_URL = os.environ.get(
    "PUBLIC_BASE_URL", "https://xn----htbtgjker8b3a2c.xn--p1ai"
).rstrip("/")
WS_BASE_URL = BASE_URL.replace("https://", "wss://").replace("http://", "ws://")
POOL_PATH = Path(os.environ.get("LOADTEST_POOL", Path(__file__).parent / "pool.json"))
READY_TIMEOUT_SECONDS = 10
TURN_RECEIVE_TIMEOUT_SECONDS = 90

# Пул реплик переиспользуем из внутреннего теста: фразы те же, нагрузка сопоставимая.
from locustfile import USER_MESSAGES  # noqa: E402  (рядом в loadtest/)

_POOL: list[dict] = json.loads(POOL_PATH.read_text(encoding="utf-8"))
_ACCOUNTS = itertools.cycle(range(len(_POOL)))
_POOL_LOCK = threading.Lock()


def _persist_pool() -> None:
    """Переписывает pool.json после ротации refresh-токена (они одноразовые)."""
    with _POOL_LOCK:
        tmp = POOL_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(_POOL, ensure_ascii=False, indent=1), encoding="utf-8")
        tmp.rename(POOL_PATH)


class PublicDialogUser(HttpUser):
    """Виртуальный пользователь публичного API: диалог через WS-gateway."""

    host = BASE_URL

    wait_time = between(
        float(os.environ.get("LOADTEST_THINK_MIN", "1")),
        float(os.environ.get("LOADTEST_THINK_MAX", "3")),
    )

    def on_start(self) -> None:
        """Берёт аккаунт из пула, стартует диалог и открывает сокет."""
        self.account_index = next(_ACCOUNTS)
        self.account = _POOL[self.account_index]
        self.dialog_id: str | None = None
        self.ws: websocket.WebSocket | None = None
        self._ensure_token()
        self._start_dialog()
        if self.dialog_id is not None:
            self._connect_ws()

    def on_stop(self) -> None:
        """Завершает диалог кадром end и закрывает сокет."""
        if self.ws is None:
            return
        try:
            self.ws.send(json.dumps({"type": "end"}))
            self.ws.close()
        except Exception:
            pass

    def _fire(self, name: str, started: float, exception: Exception | None = None) -> None:
        """Публикует замер в статистику Locust."""
        self.environment.events.request.fire(
            request_type="WS" if name.startswith("WS") else "REST",
            name=name,
            response_time=(time.perf_counter() - started) * 1000,
            response_length=0,
            exception=exception,
            context={},
        )

    def _ensure_token(self) -> None:
        """Обновляет access-токен, если до истечения меньше двух минут."""
        expires_ms = self.account.get("expiresAt", 0)
        if expires_ms - time.time() * 1000 > 120_000:
            return
        started = time.perf_counter()
        try:
            resp = requests.post(
                f"{BASE_URL}/api/auth/refresh",
                json={"refreshToken": self.account["refreshToken"]},
                timeout=30,
            )
            payload = resp.json()
            if resp.status_code != 200 or not payload.get("status"):
                raise RuntimeError(f"refresh: HTTP {resp.status_code} {payload}")
            tokens = payload["result"]
            self.account.update(tokens)
            with _POOL_LOCK:
                _POOL[self.account_index].update(tokens)
            _persist_pool()
            self._fire("REST refresh", started)
        except Exception as exc:
            self._fire("REST refresh", started, exception=exc)
            raise

    def _start_dialog(self) -> None:
        """POST /api/dialogs с Bearer access-токеном; конверт {status, result}."""
        started = time.perf_counter()
        try:
            resp = requests.post(
                f"{BASE_URL}/api/dialogs",
                json={},
                headers={"Authorization": f"Bearer {self.account['accessToken']}"},
                timeout=30,
            )
            payload = resp.json()
            if resp.status_code != 200 or not payload.get("status"):
                raise RuntimeError(f"start_dialog: HTTP {resp.status_code} {payload}")
            self.dialog_id = payload["result"]["dialogId"]
            self._fire("REST start_dialog", started)
        except Exception as exc:
            self._fire("REST start_dialog", started, exception=exc)

    def _connect_ws(self) -> None:
        """Открывает сокет, шлёт hello и ждёт ready."""
        started = time.perf_counter()
        try:
            self.ws = websocket.create_connection(
                f"{WS_BASE_URL}/api/dialogs/ws", timeout=TURN_RECEIVE_TIMEOUT_SECONDS
            )
            self.ws.settimeout(READY_TIMEOUT_SECONDS)
            self.ws.send(
                json.dumps(
                    {
                        "type": "hello",
                        "token": self.account["accessToken"],
                        "dialogId": self.dialog_id,
                    }
                )
            )
            frame = json.loads(self.ws.recv())
            if frame.get("type") != "ready":
                raise RuntimeError(f"ожидали ready, получили {frame}")
            self.ws.settimeout(TURN_RECEIVE_TIMEOUT_SECONDS)
        except Exception as exc:
            self._fire("WS connect+hello", started, exception=exc)
            self.ws = None
            return
        self._fire("WS connect+hello", started)

    @task
    def dialog_turn(self) -> None:
        """Один ход диалога через публичный gateway."""
        if self.ws is None:
            # Сокет умер (restart/idle/ошибка): новый диалог и новое подключение.
            self._start_dialog()
            if self.dialog_id is None:
                return
            self._connect_ws()
            if self.ws is None:
                return

        frame = {
            "type": "message",
            "clientId": uuid.uuid4().hex,
            "text": random.choice(USER_MESSAGES),
        }
        started = ttft_started = tts_started = time.perf_counter()
        ttft_recorded = tts_recorded = False
        try:
            self.ws.send(json.dumps(frame, ensure_ascii=False))
            while True:
                incoming = self.ws.recv()
                if isinstance(incoming, bytes):
                    continue  # PCM-озвучка: байты считать не нужно, метрика — по tts-кадрам
                if not incoming.strip():
                    continue  # редкий пустой текстовый кадр gateway — не ход диалога
                kind = json.loads(incoming).get("type")
                if kind == "error":
                    raise RuntimeError(f"gateway error: {json.loads(incoming).get('code')}")
                if kind == "assistant_start" and not ttft_recorded:
                    self._fire("WS turn ttft", started)
                    ttft_recorded = True
                    ttft_started = time.perf_counter()
                elif kind == "tts_start" and not tts_recorded:
                    tts_recorded = True
                    tts_started = time.perf_counter()
                elif kind == "tts_end" and tts_recorded:
                    self._fire("WS turn tts", tts_started)
                    tts_recorded = False
                elif kind == "assistant_end":
                    self._fire("WS turn total", started)
                    if ttft_recorded:
                        self._fire("WS turn streaming", ttft_started)
                    break
                elif kind == "ended":
                    # Агент сам завершил диалог: следующий таск откроет новый.
                    raise StopIteration("dialog ended by agent")
        except StopIteration:
            try:
                self.ws.close()
            except Exception:
                pass
            self.ws = None
        except Exception as exc:
            self._fire("WS turn total", started, exception=exc)
            try:
                self.ws.close()
            except Exception:
                pass
            self.ws = None

        self._ensure_token()  # access живёт 15 минут — на длинных прогонах ротируем
