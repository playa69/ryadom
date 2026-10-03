"""Модели данных для структурированных логов, метрик и аудит-событий."""

import json
from dataclasses import asdict, dataclass
from typing import Any

from app.logger.context_vars import ContextLog

__all__ = ["ContextLog", "Log", "Metric", "Event", "EventParam", "dataclass_as_json_str"]


@dataclass
class Log:
    """Структурированная запись обычного лога."""

    levelName: str
    asctime: str
    moduleName: str
    funcName: str
    message: str
    stackTrace: str | None
    rqUId: None | str
    rqTime: None | str
    systemId: None | str
    gwSessionId: None | str
    userId: None | str
    args: str | None


@dataclass
class Metric:
    """Запись метрики."""

    rqUId: str | None
    metric_name: str
    metric_value: int | float


@dataclass
class EventParam:
    """Параметр аудит-события."""

    name: str
    value: Any


@dataclass
class Event:
    """Аудит-событие со списком параметров."""

    name: str
    createdAt: int
    params: list[EventParam]


def dataclass_as_json_str(dataclass_object: Any) -> str:
    """Сериализует dataclass в JSON."""
    return json.dumps(asdict(dataclass_object), ensure_ascii=False, default=str)
