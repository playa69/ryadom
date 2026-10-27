"""Контейнер ContextVar для хранения контекста запроса."""

from contextvars import ContextVar
from typing import Any

from .models import ContextLog


class ContextVarsContainer:
    """Хранит contextvars запроса и предоставляет доступ к ним как к ContextLog."""

    @property
    def context_vars(self) -> ContextLog:
        """Возвращает текущий контекст в виде объекта ContextLog."""
        return ContextLog(
            rqUId=self.x_trace_id_var.get(),
            rqTime=self.x_request_time_var.get(),
            systemId=self.x_client_id_var.get(),
            gwSessionId=self.x_aigw_session_id_var.get(),
            userId=self.x_user_id_var.get(),
        )

    def __init__(self) -> None:
        """Инициализирует все ContextVar со значением по умолчанию None."""
        self.x_trace_id_var = ContextVar("rquid", default=None)
        self.x_request_time_var = ContextVar("rqtm", default=None)
        self.x_client_id_var = ContextVar("systemId", default=None)
        self.x_aigw_session_id_var = ContextVar("gwSessionId", default=None)
        self.x_user_id_var = ContextVar("userId", default=None)
        self.request_start_time_var: ContextVar[float | None] = ContextVar("request_start_time", default=None)
        self.gigachat_model_var: ContextVar[str | None] = ContextVar("gigachat_model", default=None)
        self.gigachat_embedding_model_var: ContextVar[str | None] = ContextVar("gigachat_embedding_model", default=None)

    def set_context_vars(
        self,
        x_trace_id: str | None = None,
        x_request_time: str | None = None,
        x_client_id: str | None = None,
        x_aigw_session_id: str | None = None,
        x_user_id: str | None = None,
        **kwargs: Any,
    ) -> None:
        """Устанавливает основные контекстные переменные запроса."""
        self.x_trace_id_var.set(x_trace_id)
        self.x_request_time_var.set(x_request_time)
        self.x_client_id_var.set(x_client_id)
        self.x_aigw_session_id_var.set(x_aigw_session_id)
        self.x_user_id_var.set(x_user_id)

    def set_gigachat_model(self, model: str | None) -> None:
        """Задаёт модель."""
        self.gigachat_model_var.set(model)

    def get_gigachat_model(self) -> str | None:
        """Возвращает модель."""
        return self.gigachat_model_var.get()

    def set_gigachat_embedding_model(self, model: str | None) -> None:
        """Задаёт embedding."""
        self.gigachat_embedding_model_var.set(model)

    def get_gigachat_embedding_model(self) -> str | None:
        """Возвращает embedding."""
        return self.gigachat_embedding_model_var.get()

    def get_context_vars(self) -> tuple[str | None, str | None, str | None, str | None, str | None]:
        """Возвращает кортеж основных контекстных переменных."""
        return (
            self.x_trace_id_var.get(),
            self.x_request_time_var.get(),
            self.x_client_id_var.get(),
            self.x_aigw_session_id_var.get(),
            self.x_user_id_var.get(),
        )


__all__ = ["ContextVarsContainer"]
