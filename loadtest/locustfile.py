"""Нагрузочный тест сервиса agent «Слышу Рядом» (Locust + WebSocket).

Виртуальный пользователь повторяет реальный сценарий PWA-клиента:
  1. POST /v1/users/{userId}/dialogs — начать диалог (REST, Bearer-токен);
  2. WS /v1/users/{userId}/dialogs/{dialogId}/ws — текстовые ходы диалога;
  3. POST .../end + DELETE /v1/users/{userId} — завершить и стереть
     тестовые данные из продуктовой БД.

Переменные окружения:
  AGENT_BASE_URL          базовый URL сервиса (default http://localhost:18001 —
                          kubectl port-forward -n agent svc/agent 18001:8001);
  AGENT_INTERNAL_TOKEN    Bearer-токен (обязательно);
  LOADTEST_THINK_MIN/MAX  пауза между репликами, сек (default 4/10);
  LOADTEST_RAMP           1 — включить ступенчатый рост до ~10 RPS
                          (иначе стандартные --users/--spawn-rate locust).

Замеряемые метрики (видны в веб-UI и CSV):
  REST start_dialog  — старт диалога;
  WS connect         — рукопожатие и кадр ready;
  WS turn ttft       — от отправки реплики до assistant_start
                       (чистая латентность LLM-хода);
  WS turn streaming  — от assistant_start до assistant_end (искусственный
                       стриминг ~60 мс/слово на стороне агента);
  WS turn tts        — от tts_start до конца приёма PCM-аудио (озвучка);
  WS turn total      — полное время хода диалога.
Завершение диалога и стирание тестовых данных (REST end + DELETE user)
идут вне статистики — это cleanup, а не нагрузка.
"""

from __future__ import annotations

import json
import os
import random
import time
import uuid

import websocket
import requests
from locust import HttpUser, LoadTestShape, between, events, task

BASE_URL = os.environ.get("AGENT_BASE_URL", "http://localhost:18001").rstrip("/")
WS_BASE_URL = BASE_URL.replace("http://", "ws://").replace("https://", "wss://")
TOKEN = os.environ.get("AGENT_INTERNAL_TOKEN", "")
TURN_RECEIVE_TIMEOUT_SECONDS = 90  # чуть больше TURN_TIMEOUT_SECONDS агента (60)

# Реплики в духе продукта (психологическая поддержка): короткие и средние.
USER_MESSAGES = [
    "Привет. Сегодня был тяжёлый день, чувствую усталость и раздражение.",
    "Поссорился с близким человеком, не могу отпустить эту ситуацию.",
    "Тревожно на работе, постоянно кажется, что я не справляюсь.",
    "Не могу уснуть уже несколько ночей, мысли крутятся по кругу.",
    "Чувствую себя одиноко, даже когда вокруг люди.",
    "Злость накрывает из-за мелочей, а потом стыдно за это.",
    "Расскажи, как понять, что мне на самом деле нужно?",
    "У меня завтра важный разговор, и я очень переживаю.",
    "Иногда кажется, что ничего не получается, хотя я стараюсь.",
    "Хочу научиться спокойнее реагировать на критику.",
    "Спасибо, мне уже немного легче. Что можно сделать прямо сейчас?",
    "А как ты думаешь, почему я так остро реагирую на эту тему?",
]


class AgentDialogUser(HttpUser):
    """Виртуальный пользователь: один диалог, реплики по WebSocket."""

    host = BASE_URL

    wait_time = between(
        float(os.environ.get("LOADTEST_THINK_MIN", "4")),
        float(os.environ.get("LOADTEST_THINK_MAX", "10")),
    )

    def on_start(self) -> None:
        """Стартует диалог и открывает WebSocket."""
        if not TOKEN:
            raise RuntimeError("Задайте AGENT_INTERNAL_TOKEN (см. docstring модуля)")
        self.user_id = str(uuid.uuid4())  # сервис требует userId в формате UUID
        self.dialog_id: str | None = None
        self.ws: websocket.WebSocket | None = None
        self.client.headers = {"Authorization": f"Bearer {TOKEN}"}

        with self.client.post(
            f"/v1/users/{self.user_id}/dialogs", name="REST start_dialog", catch_response=True
        ) as resp:
            if resp.status_code != 200:
                resp.failure(f"start_dialog: HTTP {resp.status_code}")
                self.stop(True)
                return
            self.dialog_id = resp.json()["dialogId"]
        self._connect_ws()

    def on_stop(self) -> None:
        """Завершает диалог и стирает данные тестового пользователя.

        Cleanup идёт через обычный requests (не через self.client Locust):
        при остановке теста раннер убивает greenlet'ы, и GreenletExit в
        self.client засчитывался бы как ошибка запроса в статистике.
        """
        if self.ws is not None:
            try:
                self.ws.close()
            except Exception:
                pass
        if self.dialog_id is None:
            return
        try:
            requests.post(
                f"{BASE_URL}/v1/users/{self.user_id}/dialogs/{self.dialog_id}/end",
                headers={"Authorization": f"Bearer {TOKEN}"},
                timeout=10,
            )
            requests.delete(
                f"{BASE_URL}/v1/users/{self.user_id}",
                headers={"Authorization": f"Bearer {TOKEN}"},
                timeout=10,
            )
        except Exception:
            pass

    def _connect_ws(self) -> None:
        """Открывает сокет диалога и ждёт кадр ready."""
        url = f"{WS_BASE_URL}/v1/users/{self.user_id}/dialogs/{self.dialog_id}/ws"
        started = time.perf_counter()
        try:
            self.ws = websocket.create_connection(
                url,
                header={"Authorization": f"Bearer {TOKEN}"},
                timeout=TURN_RECEIVE_TIMEOUT_SECONDS,
            )
            frame = json.loads(self.ws.recv())
            if frame.get("type") != "ready":
                raise RuntimeError(f"ожидали ready, получили {frame}")
        except Exception as exc:
            self._fire("WS connect", started, exception=exc)
            self.ws = None
            self.stop(True)
            return
        self._fire("WS connect", started)

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

    @task
    def dialog_turn(self) -> None:
        """Один ход диалога: реплика пользователя и ответ ассистента."""
        if self.ws is None:
            self._connect_ws()
            if self.ws is None:
                return

        text = random.choice(USER_MESSAGES)
        frame = {"type": "user_message", "id": uuid.uuid4().hex, "text": text}
        started = ttft_started = tts_started = time.perf_counter()
        ttft_recorded = tts_recorded = False
        audio_bytes = 0
        try:
            self.ws.send(json.dumps(frame, ensure_ascii=False))
            while True:
                incoming = self.ws.recv()
                if isinstance(incoming, bytes):
                    # Бинарные кадры — PCM-озвучка ответа (TTS), просто считаем.
                    audio_bytes += len(incoming)
                    continue
                kind = json.loads(incoming).get("type")
                if kind == "error":
                    raise RuntimeError(f"agent error: {json.loads(incoming).get('code')}")
                if kind == "assistant_start" and not ttft_recorded:
                    self._fire("WS turn ttft", started)
                    ttft_recorded = True
                    ttft_started = time.perf_counter()
                elif kind == "tts_start" and not tts_recorded:
                    tts_recorded = True
                    tts_started = time.perf_counter()
                elif kind == "assistant_end":
                    self._fire("WS turn total", started)
                    if ttft_recorded:
                        self._fire("WS turn streaming", ttft_started)
                    if tts_recorded and audio_bytes:
                        self._fire("WS turn tts", tts_started)
                    break
        except Exception as exc:
            self._fire("WS turn total", started, exception=exc)
            try:
                self.ws.close()
            except Exception:
                pass
            self.ws = None  # следующий таск переподключится


class RampTo10RpsShape(LoadTestShape):
    """Ступени роста нагрузки до ~10 RPS ходов диалога.

    RPS ходов ≈ users / (время хода + пауза). При ответе агента ~10–15 с
    и паузе 4–10 с целевые 10 RPS достигаются примерно на 150–200
    пользователях; ступени позволяют увидеть, где агент насыщается раньше.
    """

    STAGES = [
        {"duration": 120, "users": 10, "spawn_rate": 2},    # разогрев ~0.5 RPS
        {"duration": 300, "users": 30, "spawn_rate": 2},    # ~1.5 RPS
        {"duration": 300, "users": 60, "spawn_rate": 2},    # ~3 RPS
        {"duration": 300, "users": 100, "spawn_rate": 3},   # ~5 RPS
        {"duration": 300, "users": 150, "spawn_rate": 3},   # ~7-8 RPS
        {"duration": 300, "users": 200, "spawn_rate": 3},   # ~10 RPS
    ]

    def tick(self) -> tuple[int, float] | None:
        """Возвращает (users, spawn_rate) для текущей ступени."""
        run_time = self.get_run_time()
        for stage in self.STAGES:
            if run_time < stage["duration"]:
                return stage["users"], stage["spawn_rate"]
            run_time -= stage["duration"]
        return None


# Без LOADTEST_RAMP=1 shape не регистрируем — действуют --users/--spawn-rate.
if os.environ.get("LOADTEST_RAMP") != "1":
    del RampTo10RpsShape
