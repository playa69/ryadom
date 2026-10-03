"""Тесты middleware заголовков (задача 1.4) и security-заголовков (1.5)."""

import json
from pathlib import Path

from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.api.middleware import request_context_middleware, security_headers_middleware
from app.logger.context_vars import CONTEXT_VARS_CONTAINER
from app.logger.logger import configure_logging


def _mini_app() -> FastAPI:
    mini = FastAPI()
    mini.middleware("http")(request_context_middleware)

    @mini.get("/ctx")
    async def ctx():
        cv = CONTEXT_VARS_CONTAINER.context_vars
        return {
            "rqUId": cv.rqUId,
            "rqTime": cv.rqTime,
            "systemId": cv.systemId,
            "gwSessionId": cv.gwSessionId,
            "userId": cv.userId,
        }

    @mini.get("/health")
    async def health():
        return {"status": "ok"}

    return mini


async def test_whitelist_headers_extracted_to_context():
    async with AsyncClient(
        transport=ASGITransport(app=_mini_app()), base_url="http://t"
    ) as client:
        response = await client.get(
            "/ctx",
            headers={
                "x-trace-id": "trace-abc",
                "x-request-time": "2026-10-03T10:00:00",
                "x-client-id": "ios",
                "x-session-id": "sess-42",
                "x-user-id": "user-7",
                "authorization": "Bearer must-not-leak",
            },
        )
    assert response.status_code == 200
    assert response.json() == {
        "rqUId": "trace-abc",
        "rqTime": "2026-10-03T10:00:00",
        "systemId": "ios",
        "gwSessionId": "sess-42",
        "userId": "user-7",
    }


async def test_no_trace_id_request_processed_rquid_empty():
    async with AsyncClient(
        transport=ASGITransport(app=_mini_app()), base_url="http://t"
    ) as client:
        response = await client.get("/ctx")
    assert response.status_code == 200
    assert response.json()["rqUId"] is None


async def test_non_whitelist_headers_not_logged(tmp_path, monkeypatch):
    """Заголовки вне белого списка (Authorization) не попадают в логи."""
    configure_logging(
        log_lvl=20,
        log_file_path=str(tmp_path / "app.log"),
        metric_file_path=str(tmp_path / "metric.log"),
        audit_file_path=str(tmp_path / "events.log"),
        timezone="Europe/Moscow",
        enqueue=False,
    )
    secret = "Bearer very-secret-token-value"
    async with AsyncClient(
        transport=ASGITransport(app=_mini_app()), base_url="http://t"
    ) as client:
        await client.get("/ctx", headers={"authorization": secret, "x-trace-id": "t-1"})
    log_text = Path(tmp_path / "app.log").read_text(encoding="utf-8")
    assert "very-secret-token-value" not in log_text
    assert '"rqUId": "t-1"' in log_text


async def test_health_endpoint_not_logged(tmp_path):
    configure_logging(
        log_lvl=20,
        log_file_path=str(tmp_path / "app.log"),
        metric_file_path=str(tmp_path / "metric.log"),
        audit_file_path=str(tmp_path / "events.log"),
        timezone="Europe/Moscow",
        enqueue=False,
    )
    async with AsyncClient(
        transport=ASGITransport(app=_mini_app()), base_url="http://t"
    ) as client:
        await client.get("/health")
    log_text = Path(tmp_path / "app.log").read_text(encoding="utf-8")
    assert "/health" not in log_text


async def test_security_headers_on_responses():
    mini = FastAPI()
    mini.middleware("http")(security_headers_middleware)

    @mini.get("/api/v1/auth/device")
    async def auth_ep():
        return {}

    @mini.get("/api/v1/other")
    async def other_ep():
        return {}

    async with AsyncClient(transport=ASGITransport(app=mini), base_url="http://t") as client:
        auth_response = await client.get("/api/v1/auth/device")
        other_response = await client.get("/api/v1/other")

    for response in (auth_response, other_response):
        assert response.headers["X-Content-Type-Options"] == "nosniff"
        assert response.headers["X-Frame-Options"] == "DENY"
        assert response.headers["Referrer-Policy"] == "no-referrer"
        assert "max-age=" in response.headers["Strict-Transport-Security"]

    # Cache-Control: no-store — только для auth-эндпоинтов
    assert auth_response.headers["Cache-Control"] == "no-store"
    assert "Cache-Control" not in other_response.headers
