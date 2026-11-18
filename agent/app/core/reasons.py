"""Короткие коды причин отказа компонента: единый словарь для журнала, метрик и события `component_called`.

Код получается из исключения или текста ошибки и не содержит ни текста, ни ответа вендора: набор закрытый, поэтому годится
для label Prometheus и для свойства аналитики. Сам текст ошибки остаётся только в журнале пода.
"""

import asyncio
import re

REASONS = (
    "quota",  # квота или лимит запросов провайдера (429, RESOURCE_EXHAUSTED)
    "auth",  # ключ или токен не принят (401, 403)
    "timeout",  # провайдер не ответил за отведённое время
    "connect",  # соединение не открылось или не удалось отправить
    "closed",  # соединение закрыто провайдером или нами посреди работы
    "empty",  # провайдер ответил, но пусто (нет расшифровки, нет звука)
    "bad_response",  # ответ не того вида или код 4xx/5xx
    "unavailable",  # путь недоступен: нет промпта, пауза после отказа
    "unknown",
)

_QUOTA = re.compile(r"quota|resource_exhausted|\b429\b|rate.?limit", re.IGNORECASE)
_AUTH = re.compile(r"\b40[13]\b|unauthori[sz]ed|forbidden|api key|permission", re.IGNORECASE)
_TIMEOUT = re.compile(r"timeout|timed out|не ответил за|не прислал", re.IGNORECASE)
_CONNECT = re.compile(r"не открыл|connect|refused|name resolution|dns|handshake|ssl|не принял настройки", re.IGNORECASE)
_CLOSED = re.compile(r"закрыт|closed|1011|1006|1000|goaway|connectionclosed|reset by peer|disconnect", re.IGNORECASE)
_EMPTY = re.compile(r"пуст|empty|no audio|без звука|без расшифровки", re.IGNORECASE)
_BAD = re.compile(r"\b[45]\d\d\b|неожиданн|unexpected|invalid|json", re.IGNORECASE)
_UNAVAILABLE = re.compile(r"недоступн|unavailable|промпт|prompt", re.IGNORECASE)


def classify(error: object) -> str:
    """Код причины по исключению или тексту. Порядок важен: квота и авторизация точнее, чем «закрыто»."""
    if isinstance(error, (asyncio.TimeoutError, TimeoutError)):
        return "timeout"
    text = f"{type(error).__name__} {error}" if isinstance(error, BaseException) else str(error)
    for code, pattern in (
        ("quota", _QUOTA),
        ("auth", _AUTH),
        ("timeout", _TIMEOUT),
        ("empty", _EMPTY),
        ("connect", _CONNECT),
        ("closed", _CLOSED),
        ("bad_response", _BAD),
        ("unavailable", _UNAVAILABLE),
    ):
        if pattern.search(text):
            return code
    return "unknown"
