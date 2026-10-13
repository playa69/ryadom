"""Точка входа FastAPI-приложения «Слышу Рядом» backend.

Lifespan: инициализация PostgreSQL/Redis с флагами *_IS_HARD_HEALTH.
Middleware: заголовки → ContextVars, security-заголовки. Exception handlers
единого формата ошибок. Роутеры под /api/v1, служебные эндпоинты
(health/version/metrics) вне префикса.
"""

import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, PlainTextResponse
from loguru import logger
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.api.middleware import request_context_middleware, security_headers_middleware
from app.api.router import api_v1_router
from app.core.config import APP_CONFIG
from app.core.db import dispose_engine, ping_database
from app.core.redis import (
    close_redis_client,
    create_redis_client,
    get_redis_client,
    set_redis_client,
)
from app.logger.logger import configure_logging
from app.schemas.errors import ErrorCode, ErrorResponse, FieldErrorDetail
from app.services.exceptions import AppError

os.makedirs(APP_CONFIG.log.log_path, exist_ok=True)
os.makedirs(APP_CONFIG.log.metric_path, exist_ok=True)
os.makedirs(APP_CONFIG.log.audit_log_path, exist_ok=True)

configure_logging(
    log_lvl=APP_CONFIG.app.log_lvl,
    log_file_path=APP_CONFIG.log.log_file_path,
    metric_file_path=APP_CONFIG.log.metric_file_path,
    audit_file_path=APP_CONFIG.log.audit_file_path,
    timezone=APP_CONFIG.app.timezone,
    rotation=APP_CONFIG.log.log_rotation,
    mask_enabled=APP_CONFIG.log.mask_enabled,
)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    # PostgreSQL
    try:
        await ping_database()
        logger.info("PostgreSQL доступен")
    except Exception as exc:
        if APP_CONFIG.pg.is_hard_health:
            raise RuntimeError(
                f"PostgreSQL недоступен при PG_IS_HARD_HEALTH=true: {exc}"
            ) from exc
        logger.warning(
            f"PostgreSQL недоступен, старт с деградацией (PG_IS_HARD_HEALTH=false): {exc}"
        )

    # Redis
    if APP_CONFIG.redis.enabled:
        try:
            client = await create_redis_client(
                sentinel_host=APP_CONFIG.redis.sentinel_host,
                sentinel_port=APP_CONFIG.redis.sentinel_port,
                master_name=APP_CONFIG.redis.master_name,
                password=(
                    APP_CONFIG.redis.password.get_secret_value()
                    if APP_CONFIG.redis.password
                    else None
                ),
            )
            set_redis_client(client)
        except Exception as exc:
            if APP_CONFIG.redis.is_hard_health:
                raise RuntimeError(
                    f"Redis недоступен при REDIS_IS_HARD_HEALTH=true: {exc}"
                ) from exc
            logger.warning(
                f"Redis недоступен, старт с деградацией (REDIS_IS_HARD_HEALTH=false): {exc}"
            )
    else:
        logger.warning(
            "Redis отключён (REDIS_ENABLED=false) — auth-контуры fail-closed 503"
        )

    yield

    await close_redis_client()
    await dispose_engine()


app = FastAPI(
    title="Ryadom Backend",
    version=APP_CONFIG.app.version,
    lifespan=lifespan,
    docs_url="/docs",
    openapi_url="/openapi.json",
)

app.middleware("http")(request_context_middleware)
app.middleware("http")(security_headers_middleware)


@app.exception_handler(AppError)
async def app_error_handler(request: Request, exc: AppError) -> JSONResponse:
    error_response = ErrorResponse.from_code(exc.code, exc.message, exc.details)
    return JSONResponse(
        status_code=exc.status_code,
        content=error_response.model_dump(mode="json"),
        headers=exc.headers,
    )


@app.exception_handler(RequestValidationError)
async def validation_error_handler(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    details = [
        FieldErrorDetail(
            field=str(error["loc"][-1]) if error["loc"] else "unknown",
            message=error["msg"],
            code=error["type"],
        )
        for error in exc.errors()
    ]
    error_response = ErrorResponse.from_code(
        ErrorCode.VALIDATION_ERROR, details=details
    )
    return JSONResponse(status_code=422, content=error_response.model_dump(mode="json"))


@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(
    request: Request, exc: StarletteHTTPException
) -> JSONResponse:
    code = ErrorCode.NOT_FOUND if exc.status_code == 404 else ErrorCode.INTERNAL_ERROR
    error_response = ErrorResponse.from_code(code)
    return JSONResponse(
        status_code=exc.status_code, content=error_response.model_dump(mode="json")
    )


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    logger.exception(f"Необработанное исключение: {exc}")
    error_response = ErrorResponse.from_code(ErrorCode.INTERNAL_ERROR)
    return JSONResponse(status_code=500, content=error_response.model_dump(mode="json"))


@app.get("/health", include_in_schema=False)
async def liveness() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/health/ready", include_in_schema=False)
async def readiness() -> JSONResponse:
    checks: dict[str, str] = {}
    try:
        await ping_database()
        checks["postgres"] = "ok"
    except Exception:  # noqa: BLE001 — пробы не должны падать
        checks["postgres"] = "error"

    redis_client = get_redis_client()
    if redis_client is None:
        checks["redis"] = "error" if APP_CONFIG.redis.enabled else "disabled"
    else:
        try:
            await redis_client.ping()
            checks["redis"] = "ok"
        except Exception:  # noqa: BLE001 — пробы не должны падать
            checks["redis"] = "error"

    healthy = all(value in ("ok", "disabled") for value in checks.values())
    return JSONResponse(
        status_code=200 if healthy else 503,
        content={"status": "ok" if healthy else "error", "checks": checks},
    )


@app.get("/version", include_in_schema=False)
async def version() -> dict[str, str]:
    return {"version": APP_CONFIG.app.version}


@app.get("/metrics", include_in_schema=False)
async def metrics_endpoint() -> PlainTextResponse:
    return PlainTextResponse(generate_latest(), media_type=CONTENT_TYPE_LATEST)


app.include_router(api_v1_router, prefix="/api/v1")
