"""Обёртки и конфигуратор для структурированного логирования через loguru."""

import json
import sys
import uuid
from dataclasses import asdict
from datetime import datetime
from logging import DEBUG
from time import time
from typing import Any

import pytz
from loguru import logger as loguru_logger

from aigw_service.base import Singleton

from .context_vars import ContextVarsContainer
from .models import ContextLog, Event, EventParam, Log, Metric, dataclass_as_json_str
from .utils import mask_sensitive_data


class LoggerWrapper:
    """Прокси над loguru-логгером с методами метрик и аудита."""

    def __init__(self, audit_uid_pod: str, audit_ip_address: str) -> None:
        """Инициализирует обёртку с параметрами аудита."""
        self.logger = None
        self.audit_uid_pod = audit_uid_pod
        self.audit_ip_address = audit_ip_address

    def patch(self, *args: Any, **kwargs: Any) -> "LoggerWrapper":
        """Применяет патч к логгеру."""
        self.logger = loguru_logger.patch(*args, **kwargs)
        return self

    def metric(self, metric_name: str, metric_value: int | float) -> None:
        """Логирует метрику в файл метрик."""
        self.logger.info(
            "<metric>",
            metric_name=metric_name,
            metric_value=metric_value,
            target="metric",
        )

    def audit(self, event_name: str, event_params: dict[str, Any] | None) -> None:
        """Логирует аудит-событие с параметрами."""
        self.logger.info(
            "<audit-event>",
            audit_event_name=event_name,
            audit_uid_pod=self.audit_uid_pod,
            audit_ip_address=self.audit_ip_address,
            audit_params=event_params,
            target="audit-event",
        )

    def __getattr__(self, name: str) -> Any:
        """Прокси к логгеру."""
        return getattr(self.logger, name)


class LoguruPatcher:
    """Патчер записей loguru: дополняет контекстные поля и сериализует записи."""

    def __init__(
        self,
        context_vars_container: ContextVarsContainer,
        timezone: pytz.timezone,
        full_message_print: bool,
        cluster_name: str = "",
        application_name: str = "",
        service_name: str = "",
        project_name: str = "",
        pod_name: str = "",
    ) -> None:
        """Инициализирует патчер с контекстом и параметрами окружения."""
        self.context_vars_container = context_vars_container
        self.timezone: pytz.timezone = timezone
        self.full_message_print: bool = full_message_print
        self.cluster_name = cluster_name
        self.application_name = application_name
        self.service_name = service_name
        self.project_name = project_name
        self.pod_name = pod_name

    @staticmethod
    def format_stdout_record(record: dict[str, Any]) -> str:
        """Форматирует запись для вывода в stdout."""
        base_record = "<level>{level: <7}</level> | <green>{time:YYYY-MM-DD HH:mm:ss.SSS}</green> | "
        base_msg = "{name} | {message}\n"

        rq_uid = record["extra"].get("rqUId")
        if rq_uid:
            return base_record + "{extra[rqUId]} | " + base_msg
        else:
            return base_record + base_msg  # Без "|  |"

    def patching(self, record: dict[str, Any]) -> None:
        """Дополняет запись контекстом и сериализует полезную нагрузку."""
        _context_log: ContextLog = self.context_vars_container.context_vars
        # Preserve explicitly bound rqUId when ContextVar is not set (e.g., background threads)
        if not _context_log.rqUId and record["extra"].get("rqUId"):
            _context_log.rqUId = record["extra"]["rqUId"]
        # Fallback: generate rqUId if missing so every log has a trace id
        if not _context_log.rqUId:
            fallback_rq_uid = f"auto-{uuid.uuid4()}"
            self.context_vars_container.x_trace_id_var.set(fallback_rq_uid)
            _context_log.rqUId = fallback_rq_uid
        # Fallback: generate rqTime if missing
        if not _context_log.rqTime:
            fallback_rq_time = datetime.now(self.timezone).isoformat()
            self.context_vars_container.x_request_time_var.set(fallback_rq_time)
            _context_log.rqTime = fallback_rq_time
        _time_iso = record["time"].replace(tzinfo=self.timezone).isoformat()
        _target = record["extra"].get("target")
        _service_type = record["extra"].get("serviceType", "")

        if _target == "metric":
            _log_record = Metric(
                rqUId=_context_log.rqUId,
                metric_name=record["extra"].get("metric_name", "unknown"),
                metric_value=record["extra"].get("metric_value", 1),
            )
        elif _target == "audit-event":
            _log_record = Event(
                name=record["extra"].get("audit_event_name", None),
                createdAt=int(time() * 1000),
                params=[
                    EventParam(name="uid-pod", value=record["extra"].get("audit_uid_pod")),
                    EventParam(name="ip-address", value=record["extra"].get("audit_ip_address")),
                    EventParam(name="request-Id", value=_context_log.rqUId),
                    EventParam(name="request-Time", value=_context_log.rqTime),
                    EventParam(name="params", value=record["extra"].get("audit_params")),
                ],
            )
        else:
            record["extra"].update({"target": "log"})
            args = record["extra"].get("args", None)
            if args:
                message = args.get("message", {})
                if self.full_message_print:
                    print(json.dumps(message, indent=4, ensure_ascii=False))
                message = mask_sensitive_data(
                    message, message_type=record["extra"].get("message_type"), path=record["extra"].get("path")
                )
                args["message"] = str(message)
                if "headers" in args:
                    args["headers"] = str(args["headers"])

            _log_record = Log(
                levelName=str(record["level"].name),
                asctime=_time_iso,
                moduleName=str(record["name"]),
                funcName=str(record["function"]),
                message=str(record["message"]),
                stackTrace=record["extra"].get("exception", None),
                rqUId=_context_log.rqUId,
                rqTime=_context_log.rqTime,
                systemId=_context_log.systemId,
                gwSessionId=_context_log.gwSessionId,
                userId=_context_log.userId,
                args=args,
                serviceType=_service_type,
                clusterName=self.cluster_name,
                applicationName=self.application_name,
                serviceName=self.service_name,
                projectName=self.project_name,
                podName=self.pod_name,
            )

        record["extra"]["serialized"] = dataclass_as_json_str(_log_record)
        record["extra"].update(asdict(_context_log))


class LoggerConfigurator(metaclass=Singleton):
    """Singleton-конфигуратор обработчиков loguru для приложения."""

    # pylint: disable=R0902
    @property
    def async_logger(self) -> Any:
        """Логгер."""
        return self.logger

    def __init__(
        # pylint: disable=R0917
        self,
        log_lvl: int,
        log_file_path: str,
        metric_file_path: str,
        audit_file_path: str,
        audit_host_ip: str,
        audit_host_uid: str,
        context_vars_container: ContextVarsContainer,
        timezone: pytz.timezone,
        rotation: str = "10 MB",
        cluster_name: str = "",
        application_name: str = "",
        service_name: str = "",
        project_name: str = "",
        pod_name: str = "",
    ) -> None:
        """Создаёт патчер и инициализирует обработчики."""
        self.handlers: dict = {0: "standard-loguru"}
        self.log_lvl: int = log_lvl
        self.log_file_path: str = log_file_path
        self.metric_file_path: str = metric_file_path
        self.audit_file_path: str = audit_file_path
        self.audit_host_ip: str = audit_host_ip
        self.audit_host_uid: str = audit_host_uid
        self.rotation: str = rotation

        full_message_print = log_lvl == DEBUG
        _patcher = LoguruPatcher(
            context_vars_container,
            timezone,
            full_message_print,
            cluster_name=cluster_name,
            application_name=application_name,
            service_name=service_name,
            project_name=project_name,
            pod_name=pod_name,
        )
        self._init_async_logger(_patcher)

    def add_handler(self, *args: Any, handler_name: str = "", **kwargs: Any) -> None:
        """Добавляет обработчик."""
        self.handlers[self.logger.add(*args, **kwargs)] = handler_name

    def list_logger_handlers(self) -> None:
        """Выводит список активных обработчиков."""
        print(f"Displaying active handlers ({len(self.handlers)}):")
        for handler_id, handler_name in self.handlers.items():
            print(f" -- Handler id: {handler_id} | Status: ready | Handler name: {handler_name}")

    def _init_async_logger(self, loguru_patcher: LoguruPatcher) -> None:
        """Настраивает файловые и консольные обработчики loguru."""
        print("Setting up logging handlers")
        self.list_logger_handlers()
        self.delete_handler_by_id(0)
        self.logger = LoggerWrapper(audit_uid_pod=self.audit_host_uid, audit_ip_address=self.audit_host_ip).patch(
            loguru_patcher.patching
        )

        self.add_handler(
            handler_name="log-file-handler",
            sink=self.log_file_path,
            serialize=False,
            format="{extra[serialized]}",
            rotation=self.rotation,
            retention=0,
            compression=None,
            level=self.log_lvl,
            enqueue=True,
            filter=lambda record: record["extra"].get("target") == "log",
        )

        self.add_handler(
            handler_name="metric-file-handler",
            sink=self.metric_file_path,
            serialize=False,
            format="{extra[serialized]}",
            rotation=self.rotation,
            retention=0,
            compression=None,
            enqueue=True,
            filter=lambda record: record["extra"].get("target") == "metric",
        )

        self.add_handler(
            handler_name="audit-file-handler",
            sink=self.audit_file_path,
            serialize=False,
            format="{extra[serialized]}",
            rotation=self.rotation,
            retention=0,
            compression=None,
            enqueue=True,
            filter=lambda record: record["extra"].get("target") == "audit-event",
        )

        self.add_handler(
            handler_name="log-console-handler",
            sink=sys.stdout,
            level=self.log_lvl,
            format=loguru_patcher.format_stdout_record,
            filter=lambda record: record["extra"].get("target") == "log",
        )

        self.list_logger_handlers()
        print("---------------- All handlers are ready, now loguru is in charge ----------------")

    def delete_handler_by_id(self, handler_id: int) -> None:
        """Удаляет обработчик по идентификатору."""
        handler_name = self.handlers.get(handler_id, "<None>")
        try:
            loguru_logger.remove(handler_id)
            self.handlers.pop(handler_id)
            print(f"Successfully removed {handler_name} logger with id {handler_id}")
        except ValueError:
            print(f"Failed to remove {handler_name} logger with id {handler_id}")

    def remove_logger_handlers(self) -> None:
        """Удаляет все активные обработчики."""
        self.logger.info("Destroying logging handlers, loguru says goodbye")

        for handler_id in list(self.handlers):
            self.delete_handler_by_id(handler_id)

        self.list_logger_handlers()


__all__ = ["LoggerConfigurator"]
