"""Разбор причины, по которой закрылось голосовое соединение: какой путь, какой компонент и какой короткий код.

Вход — текст, который уже есть в журнале (`DialogSession._on_closed`, `SberVoiceLink._fail`). Выход — три коротких слова из
закрытых списков: их можно класть в метки Prometheus и в журнал, не опасаясь ни текста реплики, ни ключей. Исходный текст
причины остаётся в строке журнала отдельным полем `detail` (обрезанным), как и раньше.
"""

from __future__ import annotations

import re
from typing import NamedTuple


class Failure(NamedTuple):
    pipeline: str  # sber | gemini | unknown
    component: str  # asr | llm | tts | live | unknown
    code: str  # см. CODES


CODES = (
    "quota",
    "upstream_error",
    "keepalive_timeout",
    "timeout",
    "service_restart",
    "connection_closed",
    "session_closed",
    "auth",
    "other",
)

_AUTH = re.compile(r"\b(401|403)\b|unauthori[sz]ed|forbidden|invalid api key|permission denied", re.IGNORECASE)


def _pipeline_and_component(lower: str) -> tuple[str, str]:
    if "salutespeech" in lower:
        return "sber", "tts"
    if "gigaasr" in lower:
        return "sber", "asr"
    if "gigachat" in lower:
        return "sber", "llm"
    if "gemini" in lower or "google" in lower or "generativelanguage" in lower:
        return "gemini", "live"
    return "unknown", "unknown"


def classify_failure(reason: str) -> Failure:
    """Чем закрылось соединение. Порядок проверок важен: «quota» и «service restart» точнее, чем общее «connection closed»."""
    lower = reason.lower()
    pipeline, component = _pipeline_and_component(lower)
    if "quota" in lower or "resource_exhausted" in lower or re.search(r"\b429\b", lower):
        code = "quota"
    elif _AUTH.search(reason):
        code = "auth"
    elif "keepalive ping timeout" in lower:
        code = "keepalive_timeout"
    elif "service restart" in lower:
        code = "service_restart"
    elif "upstream_error" in lower or "server_error" in lower or "internal error" in lower:
        code = "upstream_error"
    elif "timeout" in lower or "timed out" in lower:
        code = "timeout"
    elif "closederror" in lower or "close frame" in lower or "connection closed" in lower:
        code = "connection_closed"
    elif "закрыта" in lower or "closed" in lower:
        code = "session_closed"
    else:
        code = "other"
    return Failure(pipeline, component, code)
