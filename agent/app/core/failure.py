"""Отказ компонента: одна запись в журнале с полями `component`, `reason`, `pipeline`, `dialog_id`, `turn` и один счётчик.

Поля идут в строку как `ключ=значение` в фиксированном порядке, чтобы их находил LogQL (`| logfmt`). В строке нет текстов реплик,
промптов и ответов вендора: `detail` — только имя класса исключения. Подробный текст ошибки остаётся там, где он был.
"""

import logging

from app.core.metrics import COMPONENT_ERRORS_TOTAL
from app.core.reasons import classify

# Вендор, а не роль: роль (stt/llm/tts/live) уходит в `agent_component_calls_total` и событие `component_called`.
GIGAASR = "gigaasr"
GIGACHAT = "gigachat"
SALUTESPEECH = "salutespeech"
GEMINI_LIVE = "gemini_live"
GEMINI_TTS = "gemini_tts"


def failure_fields(
    component: str, pipeline: str, reason: str, dialog_id: str | None = None, turn: str | None = None, user_id: str | None = None
) -> str:
    parts = [f"component={component}", f"reason={reason}", f"pipeline={pipeline}"]
    if dialog_id:
        parts.append(f"dialog_id={dialog_id}")
    if turn:
        parts.append(f"turn={turn}")
    if user_id:
        parts.append(f"user_id={user_id}")
    return " ".join(parts)


def record_failure(
    logger: logging.Logger,
    what: str,
    component: str,
    pipeline: str,
    error: object,
    dialog_id: str | None = None,
    turn: str | None = None,
    user_id: str | None = None,
    level: int = logging.WARNING,
) -> str:
    """Посчитать отказ и записать его в журнал; вернуть код причины. `what` — короткая фраза о том, что не удалось."""
    reason = classify(error)
    COMPONENT_ERRORS_TOTAL.labels(component, pipeline, reason).inc()
    detail = type(error).__name__ if isinstance(error, BaseException) else "-"
    logger.log(level, "%s %s detail=%s", what, failure_fields(component, pipeline, reason, dialog_id, turn, user_id), detail)
    return reason
