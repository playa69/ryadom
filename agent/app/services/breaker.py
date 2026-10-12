"""Размыкатель цепи для Gemini Live: после серии сбоев подряд новые реплики идут сразу в каскад.

Без него каждая реплика при лежащем Gemini ждала бы свой таймаут (`GEMINI_FIRST_OUTPUT_TIMEOUT_SECONDS`) перед откатом.
Состояния: `closed` (всё хорошо), `open` (Gemini считается недоступным, реплики идут в каскад), `half_open` (идёт фоновая
проверка). Вернуть Gemini может только проверка (`app/main.py`, фоновая задача) или успешный ответ в состоянии `half_open`:
обычные реплики Gemini в состоянии `open` не пробуют, чтобы человек не платил за пробу своим временем.
"""

import logging
import time
from collections.abc import Callable
from typing import Literal

from app.core.metrics import GEMINI_BREAKER_STATE, GEMINI_BREAKER_TRANSITIONS_TOTAL

logger = logging.getLogger("agent.breaker")

State = Literal["closed", "open", "half_open"]
_STATE_VALUE: dict[State, int] = {"closed": 0, "open": 1, "half_open": 2}


class CircuitBreaker:
    def __init__(self, failures: int, cooldown_seconds: float, clock: Callable[[], float] = time.monotonic) -> None:
        self._threshold = failures
        self._cooldown = cooldown_seconds
        self._clock = clock
        self._consecutive = 0
        self._opened_at = 0.0
        self.state: State = "closed"
        self.last_reason = ""
        GEMINI_BREAKER_STATE.set(0)

    def allow(self) -> bool:
        """Можно ли отправить реплику в Gemini. В состояниях `open` и `half_open` нет: идёт откат на каскад."""
        return self.state == "closed"

    def probe_due(self) -> bool:
        """Пора ли фоновой проверке пробовать Gemini: разомкнут и прошла пауза."""
        return self.state == "open" and self._clock() - self._opened_at >= self._cooldown

    def begin_probe(self) -> None:
        if self.state == "open":
            self._to("half_open")

    def record_success(self) -> None:
        self._consecutive = 0
        if self.state != "closed":
            self._to("closed")

    def record_failure(self, reason: str) -> None:
        self.last_reason = reason
        self._consecutive += 1
        if self.state == "half_open" or (self.state == "closed" and self._consecutive >= self._threshold):
            self._opened_at = self._clock()
            self._to("open")

    def _to(self, state: State) -> None:
        if state == self.state:
            return
        logger.warning("gemini breaker %s -> %s reason=%s failures=%d", self.state, state, self.last_reason or "-", self._consecutive)
        self.state = state
        GEMINI_BREAKER_STATE.set(_STATE_VALUE[state])
        GEMINI_BREAKER_TRANSITIONS_TOTAL.labels(state).inc()
