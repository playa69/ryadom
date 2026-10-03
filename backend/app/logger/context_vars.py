"""ContextVars для сквозных заголовков запроса (.agents/skills/api-headers-rules)."""

from contextvars import ContextVar
from dataclasses import dataclass


@dataclass
class ContextLog:
    """Контекстные поля запроса, распространяемые через ContextVar."""

    rqUId: None | str = None
    rqTime: None | str = None
    systemId: None | str = None
    gwSessionId: None | str = None
    userId: None | str = None


class ContextVarsContainer:
    """ContextVar'ы белого списка заголовков, доступные из любого async-кода."""

    def __init__(self) -> None:
        self.x_trace_id_var: ContextVar[str | None] = ContextVar("rquid", default=None)
        self.x_request_time_var: ContextVar[str | None] = ContextVar("rqtm", default=None)
        self.x_client_id_var: ContextVar[str | None] = ContextVar("systemId", default=None)
        self.x_aigw_session_id_var: ContextVar[str | None] = ContextVar("gwSessionId", default=None)
        self.x_user_id_var: ContextVar[str | None] = ContextVar("userId", default=None)

    @property
    def context_vars(self) -> ContextLog:
        return ContextLog(
            rqUId=self.x_trace_id_var.get(),
            rqTime=self.x_request_time_var.get(),
            systemId=self.x_client_id_var.get(),
            gwSessionId=self.x_aigw_session_id_var.get(),
            userId=self.x_user_id_var.get(),
        )

    def set_context_vars(
        self,
        *,
        x_trace_id: str = "",
        x_request_time: str = "",
        x_client_id: str = "",
        x_aigw_session_id: str = "",
        x_user_id: str = "",
    ) -> None:
        self.x_trace_id_var.set(x_trace_id or None)
        self.x_request_time_var.set(x_request_time or None)
        self.x_client_id_var.set(x_client_id or None)
        self.x_aigw_session_id_var.set(x_aigw_session_id or None)
        self.x_user_id_var.set(x_user_id or None)


CONTEXT_VARS_CONTAINER = ContextVarsContainer()
