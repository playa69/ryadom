"""Единый формат ошибок REST: {"error": {"code", "message", "details"}} (specs/agent-api «Формат ошибок»)."""

import logging
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

logger = logging.getLogger("agent")


class AgentError(Exception):
    """Ошибка с кодом из каталога контракта."""

    def __init__(self, status: int, code: str, message: str, details: Any = None) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details


def validation_error(message: str, details: Any = None) -> AgentError:
    return AgentError(400, "AGENT_VALIDATION", message, details)


def unauthorized() -> AgentError:
    return AgentError(401, "AGENT_UNAUTHORIZED", "Нужен внутренний токен")


def dialog_not_found() -> AgentError:
    return AgentError(404, "AGENT_DIALOG_NOT_FOUND", "Диалог не найден")


def error_body(code: str, message: str, details: Any = None) -> dict[str, Any]:
    return {"error": {"code": code, "message": message, "details": details}}


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(AgentError)
    async def on_agent_error(_: Request, exc: AgentError) -> JSONResponse:
        return JSONResponse(error_body(exc.code, exc.message, exc.details), status_code=exc.status)

    @app.exception_handler(RequestValidationError)
    async def on_validation(_: Request, exc: RequestValidationError) -> JSONResponse:
        details = [{"loc": [str(part) for part in e["loc"]], "msg": e["msg"]} for e in exc.errors()]
        return JSONResponse(error_body("AGENT_VALIDATION", "Невалидный запрос", details), status_code=400)

    @app.exception_handler(StarletteHTTPException)
    async def on_http(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = "AGENT_INTERNAL" if exc.status_code >= 500 else "AGENT_VALIDATION"
        return JSONResponse(error_body(code, str(exc.detail), None), status_code=exc.status_code)

    @app.exception_handler(Exception)
    async def on_unhandled(_: Request, exc: Exception) -> JSONResponse:
        logger.exception("unhandled error", exc_info=exc)
        return JSONResponse(error_body("AGENT_INTERNAL", "Внутренняя ошибка", None), status_code=500)
