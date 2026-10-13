"""Loguru-патчер и конфигуратор sink'ов (.agents/skills/logging-rules).

Три файловых sink'а (обычный лог, метрики, аудит-события) плюс stdout,
куда пишется тот же JSON (`{extra[serialized]}`) по всем target'ам —
в k8s stdout забирает Alloy → Loki. Контекст (rqUId и пр.) подмешивается
патчером из ContextVars. Сервис НЕ генерирует rqUId самостоятельно —
при отсутствии x-trace-id поле остаётся пустым
(.agents/skills/api-headers-rules, железное правило 1).

Стандартный logging (uvicorn, sqlalchemy и пр.) перехватывается
InterceptHandler'ом на root-логгере и тоже уходит в loguru → JSON.
Access-лог uvicorn отключён (uvicorn_log_config.json): запросы логирует
middleware с rqUId и исключениями служебных эндпоинтов.

В коде используется `from loguru import logger` — патчер применяется
ко всем записям через loguru configure(patcher=...).
"""

import logging
import sys
import traceback
from dataclasses import asdict
from time import time
from typing import Any
from zoneinfo import ZoneInfo

from loguru import logger as loguru_logger

from app.logger.context_vars import CONTEXT_VARS_CONTAINER, ContextVarsContainer
from app.logger.masking import mask_pii_in_text
from app.logger.models import Event, EventParam, Log, Metric, dataclass_as_json_str


class InterceptHandler(logging.Handler):
    """Перенаправляет записи стандартного logging (uvicorn и пр.) в loguru."""

    def emit(self, record: logging.LogRecord) -> None:
        try:
            level = loguru_logger.level(record.levelname).name
        except ValueError:
            level = record.levelno
        frame, depth = logging.currentframe(), 2
        while frame and frame.f_code.co_filename == logging.__file__:
            frame = frame.f_back
            depth += 1
        loguru_logger.opt(depth=depth, exception=record.exc_info).log(
            level, record.getMessage()
        )


class LoguruPatcher:
    """Патчер записей loguru: дополняет контекстные поля и сериализует записи."""

    def __init__(
        self,
        context_vars_container: ContextVarsContainer,
        timezone: ZoneInfo,
        mask_enabled: bool = True,
    ) -> None:
        self.context_vars_container = context_vars_container
        self.timezone = timezone
        self.mask_enabled = mask_enabled

    def patching(self, record: dict[str, Any]) -> None:
        """Дополняет запись контекстом из ContextVars и сериализует payload."""
        context_log = self.context_vars_container.context_vars
        # Фоновая задача без ContextVar, но с явным bind(rqUId=...)
        if not context_log.rqUId and record["extra"].get("rqUId"):
            context_log.rqUId = record["extra"]["rqUId"]

        time_iso = record["time"].replace(tzinfo=self.timezone).isoformat()
        target = record["extra"].get("target")

        if target == "metric":
            log_record: Log | Metric | Event = Metric(
                rqUId=context_log.rqUId,
                metric_name=record["extra"].get("metric_name", "unknown"),
                metric_value=record["extra"].get("metric_value", 1),
            )
        elif target == "audit-event":
            log_record = Event(
                name=record["extra"].get("audit_event_name"),
                createdAt=int(time() * 1000),
                params=[
                    EventParam(name="request-Id", value=context_log.rqUId),
                    EventParam(name="request-Time", value=context_log.rqTime),
                    EventParam(
                        name="params", value=record["extra"].get("audit_params")
                    ),
                ],
            )
        else:
            record["extra"].update({"target": "log"})
            message = str(record["message"])
            if self.mask_enabled:
                message = mask_pii_in_text(message)
            exception = record.get("exception")
            log_record = Log(
                levelName=str(record["level"].name),
                asctime=time_iso,
                moduleName=str(record["name"]),
                funcName=str(record["function"]),
                message=message,
                stackTrace=(
                    "".join(traceback.format_exception(*exception))
                    if exception
                    else None
                ),
                rqUId=context_log.rqUId,
                rqTime=context_log.rqTime,
                systemId=context_log.systemId,
                gwSessionId=context_log.gwSessionId,
                userId=context_log.userId,
                args=record["extra"].get("args"),
            )

        record["extra"]["serialized"] = dataclass_as_json_str(log_record)
        record["extra"].update({k: v for k, v in asdict(context_log).items() if v})


class LoggerConfigurator:
    """Настройка файловых и консольных обработчиков loguru."""

    def __init__(
        self,
        *,
        log_lvl: int,
        log_file_path: str,
        metric_file_path: str,
        audit_file_path: str,
        timezone: str,
        rotation: str = "10 MB",
        mask_enabled: bool = True,
        enqueue: bool = True,
    ) -> None:
        patcher = LoguruPatcher(
            CONTEXT_VARS_CONTAINER,
            ZoneInfo(timezone),
            mask_enabled=mask_enabled,
        )
        loguru_logger.remove()
        loguru_logger.configure(patcher=patcher.patching)

        common: dict[str, Any] = {
            "serialize": False,
            "format": "{extra[serialized]}",
            "rotation": rotation,
            "enqueue": enqueue,
        }
        loguru_logger.add(
            log_file_path,
            level=log_lvl,
            filter=lambda record: record["extra"].get("target") == "log",
            **common,
        )
        loguru_logger.add(
            metric_file_path,
            filter=lambda record: record["extra"].get("target") == "metric",
            **common,
        )
        loguru_logger.add(
            audit_file_path,
            filter=lambda record: record["extra"].get("target") == "audit-event",
            **common,
        )
        loguru_logger.add(
            sys.stdout,
            level=log_lvl,
            format="{extra[serialized]}",
            enqueue=enqueue,
        )


def configure_logging(
    *,
    log_lvl: int,
    log_file_path: str,
    metric_file_path: str,
    audit_file_path: str,
    timezone: str,
    rotation: str = "10 MB",
    mask_enabled: bool = True,
    enqueue: bool = True,
) -> None:
    """Инициализирует loguru: патчер контекста + три файловых sink'а + JSON в stdout."""
    logging.basicConfig(handlers=[InterceptHandler()], level=0, force=True)
    # httpx/httpcore пишут INFO о каждом HTTP-запросе — шум (референс скилла logging-rules)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    LoggerConfigurator(
        log_lvl=log_lvl,
        log_file_path=log_file_path,
        metric_file_path=metric_file_path,
        audit_file_path=audit_file_path,
        timezone=timezone,
        rotation=rotation,
        mask_enabled=mask_enabled,
        enqueue=enqueue,
    )
