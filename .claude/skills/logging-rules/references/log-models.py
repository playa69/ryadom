"""Модели данных для структурированных логов, метрик и аудит-событий."""

import json
from dataclasses import asdict, dataclass
from typing import Any


@dataclass
class ContextLog:
    """Контекстные поля запроса, распространяемые через ContextVar."""

    # pylint: disable=C0103,R0902
    rqUId: None | str
    rqTime: None | str
    systemId: None | str
    gwSessionId: None | str
    userId: None | str


@dataclass
class Log:
    """Структурированная запись обычного лога."""

    # pylint: disable=C0103,R0902
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
    serviceType: str = ""
    clusterName: str = ""
    applicationName: str = ""
    serviceName: str = ""
    projectName: str = ""
    podName: str = ""


@dataclass
class Metric:
    """Запись метрики."""

    # pylint: disable=C0103,R0902
    rqUId: str
    metric_name: str
    metric_value: int


@dataclass
class EventParam:
    """Параметр аудит-события."""

    # pylint: disable=C0103,R0902
    name: str
    value: str


@dataclass
class Event:
    """Аудит-событие со списком параметров."""

    # pylint: disable=C0103,R0902
    name: str
    createdAt: int
    params: list[EventParam]


def dataclass_as_json_str(dataclass_object: Any) -> str:
    """Сериализует dataclass в JSON."""
    return json.dumps(asdict(dataclass_object), ensure_ascii=False)
