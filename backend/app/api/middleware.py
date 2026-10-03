"""Middleware: сквозные заголовки → ContextVars, security-заголовки ответов."""

import time
from collections.abc import Awaitable, Callable

from fastapi import Request, Response
from loguru import logger

from app.logger.context_vars import CONTEXT_VARS_CONTAINER

HEADERS_WHITE_LIST_TO_LOG = (
    "x-trace-id",
    "x-request-time",
    "x-client-id",
    "x-session-id",
    "x-user-id",
)

NON_LOGGED_ENDPOINTS = (
    "/health",
    "/metrics",
    "/version",
    "/openapi.json",
    "/docs",
    "/",
)

_SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
}

_AUTH_PATH_PREFIX = "/api/v1/auth"


async def request_context_middleware(
    request: Request,
    call_next: Callable[[Request], Awaitable[Response]],
) -> Response:
    """Извлекает заголовки белого списка в ContextVars и логирует запрос.

    Сервис НЕ генерирует rqUId: при отсутствии x-trace-id поле остаётся
    пустым. Заголовки вне белого списка (включая Authorization) в логи
    не попадают. Служебные эндпоинты (NON_LOGGED_ENDPOINTS) не логируются.
    """
    allowed = ((k, request.headers.get(k)) for k in HEADERS_WHITE_LIST_TO_LOG)
    headers_to_log = {k: v for k, v in allowed if v}

    CONTEXT_VARS_CONTAINER.set_context_vars(
        x_trace_id=headers_to_log.get("x-trace-id", ""),
        x_request_time=headers_to_log.get("x-request-time", ""),
        x_client_id=headers_to_log.get("x-client-id", ""),
        x_aigw_session_id=headers_to_log.get("x-session-id", ""),
        x_user_id=headers_to_log.get("x-user-id", ""),
    )

    path = request.url.path
    loggable = not any(path == ep or path.startswith(f"{ep}/") for ep in NON_LOGGED_ENDPOINTS if ep != "/") and path != "/"

    started_at = time.monotonic()
    if loggable:
        logger.info(f"Запрос {request.method} {path}")

    response = await call_next(request)

    if loggable:
        duration_ms = int((time.monotonic() - started_at) * 1000)
        logger.info(f"Ответ {request.method} {path} — {response.status_code} ({duration_ms} мс)")
        logger.bind(
            target="metric",
            metric_name="backend_request_duration_ms",
            metric_value=duration_ms,
        ).info("")

    return response


async def security_headers_middleware(
    request: Request,
    call_next: Callable[[Request], Awaitable[Response]],
) -> Response:
    """Добавляет security-заголовки; для auth-эндпоинтов — Cache-Control: no-store."""
    response = await call_next(request)
    for header, value in _SECURITY_HEADERS.items():
        response.headers.setdefault(header, value)
    if request.url.path.startswith(_AUTH_PATH_PREFIX):
        response.headers["Cache-Control"] = "no-store"
    return response
