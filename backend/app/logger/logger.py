"""Loguru-патчер и конфигуратор sink'ов (.agents/skills/logging-rules).

Три sink'а: обычный лог, метрики, аудит-события. Контекст (rqUId и пр.)
подмешивается патчером из ContextVars. Сервис НЕ генерирует rqUId
самостоятельно — при отсутствии x-trace-id поле остаётся пустым
(.agents/skills/api-headers-rules, железное правило 1).

В коде используется `from loguru import logger` — патчер применяется
ко всем записям через loguru configure(patcher=...).
"""

import sys
from dataclasses import asdict
from time import time
from typing import Any
from zoneinfo import ZoneInfo

from loguru import logger as loguru_logger

from app.logger.context_vars import CONTEXT_VARS_CONTAINER, ContextVarsContainer
from app.logger.masking import mask_pii_in_text
from app.logger.models import Event, EventParam, Log, Metric, dataclass_as_json_str


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

    @staticmethod
    def format_stdout_record(record: dict[str, Any]) -> str:
        base_record = "<level>{level: <7}</level> | <green>{time:YYYY-MM-DD HH:mm:ss.SSS}</green> | "
        base_msg = "{name} | {message}\n"
        rq_uid = record["extra"].get("rqUId")
        if rq_uid:
            return base_record + "{extra[rqUId]} | " + base_msg
        return base_record + base_msg

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
                    EventParam(name="params", value=record["extra"].get("audit_params")),
                ],
            )
        else:
            record["extra"].update({"target": "log"})
            message = str(record["message"])
            if self.mask_enabled:
                message = mask_pii_in_text(message)
            log_record = Log(
                levelName=str(record["level"].name),
                asctime=time_iso,
                moduleName=str(record["name"]),
                funcName=str(record["function"]),
                message=message,
                stackTrace=record["extra"].get("exception"),
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
            format=patcher.format_stdout_record,
            filter=lambda record: record["extra"].get("target") == "log",
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
    """Инициализирует loguru: патчер контекста + три файловых sink'а + консоль."""
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
