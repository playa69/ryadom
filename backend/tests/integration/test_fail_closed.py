"""Тест fail-closed (задача 6.4): Redis недоступен → auth 503, прочие лимиты fail-open."""

from httpx import ASGITransport, AsyncClient

from app.core.redis import set_redis_client
from app.main import app
from app.services.rate_limit_service import NoOpRateLimitBackend
from tests.conftest import new_device_creds


async def test_auth_endpoints_fail_closed_without_redis(fake_redis):
    # Останавливаем Redis: клиент отсутствует
    set_redis_client(None)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://t") as client:
        for path, payload in (
            ("/api/v1/auth/device", new_device_creds()),
            (
                "/api/v1/auth/email/login",
                {"email": "a@b.co", "password": "password-1", "device_id": new_device_creds()["device_id"]},
            ),
            ("/api/v1/auth/password-reset/request", {"email": "a@b.co"}),
        ):
            response = await client.post(path, json=payload)
            assert response.status_code == 503, f"{path}: {response.status_code}"
            assert response.json()["error"]["code"] == "SERVICE_UNAVAILABLE"


async def test_email_link_fail_closed_without_redis(fake_redis):
    """Флоу привязки email без Redis тоже 503 (коды негде хранить)."""
    from tests.conftest import register_device

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://t") as client:
        login = await register_device(client)
        set_redis_client(None)
        response = await client.post(
            "/api/v1/auth/email/link",
            json={"email": "a@b.co", "password": "password-1"},
            headers={"Authorization": f"Bearer {login['access_token']}"},
        )
        assert response.status_code == 503
        assert response.json()["error"]["code"] == "SERVICE_UNAVAILABLE"


async def test_non_critical_limits_fail_open():
    """Некритичные лимиты fail-open: NoOp-бэкенд всегда разрешает."""
    backend = NoOpRateLimitBackend()
    for _ in range(100):
        _, allowed = await backend.check_and_increment("k", 60, 1)
        assert allowed
    assert not await backend.check_cooldown("k")
    assert await backend.get_cooldown_ttl("k") == 0


async def test_readiness_degraded_without_redis(fake_redis):
    set_redis_client(None)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://t") as client:
        response = await client.get("/health/ready")
    assert response.status_code == 503
    assert response.json()["checks"]["redis"] == "error"
