"""Юнит-тесты единого формата ошибок (задача 1.6)."""

from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from pydantic import BaseModel

from app.main import (
    app_error_handler,
    unhandled_exception_handler,
    validation_error_handler,
)
from app.schemas.errors import ErrorCode, ErrorResponse
from app.services.exceptions import (
    AppError,
    InvalidCredentialsError,
    RateLimitExceededError,
)


def _mini_app() -> FastAPI:
    mini = FastAPI()
    mini.exception_handler(AppError)(app_error_handler)
    mini.exception_handler(Exception)(unhandled_exception_handler)
    from fastapi.exceptions import RequestValidationError

    mini.exception_handler(RequestValidationError)(validation_error_handler)

    class Payload(BaseModel):
        code: int

    @mini.post("/validate")
    async def validate(payload: Payload):
        return {"ok": True}

    @mini.get("/domain-error")
    async def domain_error():
        raise InvalidCredentialsError()

    @mini.get("/rate-limited")
    async def rate_limited():
        raise RateLimitExceededError(retry_after_seconds=42)

    @mini.get("/boom")
    async def boom():
        raise RuntimeError("db password is hunter2")

    return mini


async def _client() -> AsyncClient:
    return AsyncClient(
        transport=ASGITransport(app=_mini_app(), raise_app_exceptions=False),
        base_url="http://t",
    )


def test_from_code_default_message():
    response = ErrorResponse.from_code(ErrorCode.AUTH_TOKEN_EXPIRED)
    assert response.error.code == ErrorCode.AUTH_TOKEN_EXPIRED
    assert response.error.message
    assert response.error.details is None


async def test_domain_error_format():
    async with await _client() as client:
        response = await client.get("/domain-error")
    assert response.status_code == 401
    body = response.json()
    assert body["error"]["code"] == "AUTH_INVALID_CREDENTIALS"
    assert body["error"]["message"]
    assert body["error"]["details"] is None


async def test_validation_error_422_field_details():
    async with await _client() as client:
        response = await client.post("/validate", json={"code": "not-an-int"})
    assert response.status_code == 422
    body = response.json()
    assert body["error"]["code"] == "VALIDATION_ERROR"
    assert body["error"]["details"][0]["field"] == "code"
    assert body["error"]["details"][0]["message"]


async def test_rate_limited_has_retry_after():
    async with await _client() as client:
        response = await client.get("/rate-limited")
    assert response.status_code == 429
    assert response.headers["Retry-After"] == "42"
    assert response.json()["error"]["code"] == "RATE_LIMITED"


async def test_unhandled_exception_no_internals():
    async with await _client() as client:
        response = await client.get("/boom")
    assert response.status_code == 500
    body = response.json()
    assert body["error"]["code"] == "INTERNAL_ERROR"
    # Внутренние детали исключения не утекают
    assert "hunter2" not in response.text
    assert "RuntimeError" not in response.text
