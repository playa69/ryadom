"""Интеграционные тесты всех 9 эндпоинтов (задачи 5.1–5.6, 6.3)."""

import uuid
from datetime import timedelta

import pytest

from app.core.security import create_access_token, hash_token
from tests.conftest import new_device_creds, register_device


def _bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


class TestOpenApi:
    def test_nine_auth_operations_present(self):
        from app.main import app

        spec = app.openapi()
        operation_ids = {
            spec["paths"][path][method]["operationId"]
            for path in spec["paths"]
            for method in spec["paths"][path]
        }
        expected = {
            "deviceLogin", "linkEmail", "confirmEmailLink", "emailLogin",
            "refreshTokens", "logout", "requestPasswordReset",
            "confirmPasswordReset", "acceptConsents",
        }
        assert expected <= operation_ids


class TestDeviceLogin:
    async def test_first_login(self, client):
        response = await client.post("/api/v1/auth/device", json=new_device_creds())
        assert response.status_code == 200
        body = response.json()
        assert body["is_new_user"] is True
        assert body["token_type"] == "bearer"
        assert body["expires_in"] == 900
        assert body["refresh_expires_in"] == 2592000
        assert body["user"]["is_anonymous"] is True

    async def test_repeat_login_same_user(self, client):
        creds = new_device_creds()
        first = (await client.post("/api/v1/auth/device", json=creds)).json()
        second = (await client.post("/api/v1/auth/device", json=creds)).json()
        assert second["is_new_user"] is False
        assert second["user"]["id"] == first["user"]["id"]

    async def test_wrong_device_key_401(self, client):
        creds = new_device_creds()
        await client.post("/api/v1/auth/device", json=creds)
        response = await client.post(
            "/api/v1/auth/device", json={**creds, "device_key": "wrong"}
        )
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "AUTH_INVALID_CREDENTIALS"

    async def test_validation_error_422(self, client):
        response = await client.post("/api/v1/auth/device", json={"device_id": "x"})
        assert response.status_code == 422
        body = response.json()
        assert body["error"]["code"] == "VALIDATION_ERROR"
        assert any(d["field"] == "device_id" for d in body["error"]["details"])

    async def test_rate_limit_429_retry_after(self, client, monkeypatch):
        from app.core.config import APP_CONFIG

        monkeypatch.setattr(APP_CONFIG.security, "device_login_rate_limit", 2)
        creds = new_device_creds()
        assert (await client.post("/api/v1/auth/device", json=creds)).status_code == 200
        assert (await client.post("/api/v1/auth/device", json=creds)).status_code == 200
        response = await client.post("/api/v1/auth/device", json=creds)
        assert response.status_code == 429
        assert response.json()["error"]["code"] == "RATE_LIMITED"
        assert "Retry-After" in response.headers

    async def test_security_and_cache_headers(self, client):
        response = await client.post("/api/v1/auth/device", json=new_device_creds())
        assert response.headers["X-Content-Type-Options"] == "nosniff"
        assert response.headers["X-Frame-Options"] == "DENY"
        assert response.headers["Cache-Control"] == "no-store"


class TestRefreshLogout:
    async def test_refresh_rotates(self, client):
        login = await register_device(client)
        response = await client.post(
            "/api/v1/auth/refresh", json={"refresh_token": login["refresh_token"]}
        )
        assert response.status_code == 200
        rotated = response.json()
        assert rotated["refresh_token"] != login["refresh_token"]

        # Старый токен вне grace-окна недействителен — проверяем через logout-флоу:
        # новый токен валиден для refresh
        second = await client.post(
            "/api/v1/auth/refresh", json={"refresh_token": rotated["refresh_token"]}
        )
        assert second.status_code == 200

    async def test_refresh_unknown_401(self, client):
        response = await client.post(
            "/api/v1/auth/refresh", json={"refresh_token": "unknown"}
        )
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "AUTH_REFRESH_TOKEN_INVALID"

    async def test_logout_idempotent(self, client, db_session):
        login = await register_device(client)
        response = await client.post(
            "/api/v1/auth/logout",
            json={"refresh_token": login["refresh_token"]},
            headers=_bearer(login["access_token"]),
        )
        assert response.status_code == 200

        # Повторный logout: access ещё валиден, refresh уже отозван — тот же успех
        repeat = await client.post(
            "/api/v1/auth/logout",
            json={"refresh_token": login["refresh_token"]},
            headers=_bearer(login["access_token"]),
        )
        assert repeat.status_code == 200
        assert repeat.json() == response.json()

        # Refresh после logout в grace-окне 10 сек допустим (design.md Risks);
        # вне grace-окна — отклоняется. Сдвигаем revoked_at за пределы окна.
        from datetime import UTC, datetime, timedelta

        from app.core.security import hash_token
        from app.repositories.auth_repository import AuthRepository

        auth = AuthRepository(db_session)
        old = await auth.get_refresh_token_by_hash(hash_token(login["refresh_token"]))
        old.revoked_at = datetime.now(UTC) - timedelta(seconds=61)
        await db_session.commit()

        refresh = await client.post(
            "/api/v1/auth/refresh", json={"refresh_token": login["refresh_token"]}
        )
        assert refresh.status_code == 401

    async def test_logout_requires_bearer(self, client):
        response = await client.post(
            "/api/v1/auth/logout", json={"refresh_token": "x"}
        )
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "AUTH_TOKEN_INVALID"


class TestEmailLink:
    async def test_full_flow(self, client, spy_email_sender, fake_redis):
        login = await register_device(client)

        pending_response = await client.post(
            "/api/v1/auth/email/link",
            json={"email": "user@example.com", "password": "password-123"},
            headers=_bearer(login["access_token"]),
        )
        assert pending_response.status_code == 200
        pending = pending_response.json()
        assert pending["expires_in"] == 600
        assert pending["email_masked"] == "u***r@example.com"

        code = spy_email_sender.link_codes[0]["code"]
        confirm = await client.post(
            "/api/v1/auth/email/link/confirm",
            json={"pending_token": pending["pending_token"], "code": code},
            headers=_bearer(login["access_token"]),
        )
        assert confirm.status_code == 200
        assert confirm.json()["user"]["has_email"] is True

        # Вход по email с нового устройства
        email_login = await client.post(
            "/api/v1/auth/email/login",
            json={
                "email": "user@example.com",
                "password": "password-123",
                "device_id": str(uuid.uuid4()),
            },
        )
        assert email_login.status_code == 200
        assert email_login.json()["user"]["id"] == login["user"]["id"]

    async def test_wrong_code_400_remaining(self, client, spy_email_sender):
        login = await register_device(client)
        pending = (
            await client.post(
                "/api/v1/auth/email/link",
                json={"email": "user@example.com", "password": "password-123"},
                headers=_bearer(login["access_token"]),
            )
        ).json()
        real_code = spy_email_sender.link_codes[0]["code"]
        wrong = "000000" if real_code != "000000" else "111111"
        response = await client.post(
            "/api/v1/auth/email/link/confirm",
            json={"pending_token": pending["pending_token"], "code": wrong},
            headers=_bearer(login["access_token"]),
        )
        assert response.status_code == 400
        body = response.json()
        assert body["error"]["code"] == "AUTH_CODE_INVALID"
        assert body["error"]["details"]["remaining_attempts"] == 4

    async def test_link_requires_auth(self, client):
        response = await client.post(
            "/api/v1/auth/email/link",
            json={"email": "user@example.com", "password": "password-123"},
        )
        assert response.status_code == 401

    async def test_email_conflict_409(self, client, spy_email_sender):
        first = await register_device(client)
        second = await register_device(client)

        # Первый пользователь полностью привязывает email
        pending = (
            await client.post(
                "/api/v1/auth/email/link",
                json={"email": "taken@example.com", "password": "password-123"},
                headers=_bearer(first["access_token"]),
            )
        ).json()
        code = spy_email_sender.link_codes[0]["code"]
        confirm = await client.post(
            "/api/v1/auth/email/link/confirm",
            json={"pending_token": pending["pending_token"], "code": code},
            headers=_bearer(first["access_token"]),
        )
        assert confirm.status_code == 200

        # Второй пользователь пытается привязать тот же email — 409
        conflict = await client.post(
            "/api/v1/auth/email/link",
            json={"email": "taken@example.com", "password": "password-123"},
            headers=_bearer(second["access_token"]),
        )
        assert conflict.status_code == 409
        assert conflict.json()["error"]["code"] == "AUTH_EMAIL_ALREADY_LINKED"


class TestEmailLogin:
    async def test_anti_enumeration_identical_responses(self, client, spy_email_sender):
        login = await register_device(client)
        pending = (
            await client.post(
                "/api/v1/auth/email/link",
                json={"email": "user@example.com", "password": "password-123"},
                headers=_bearer(login["access_token"]),
            )
        ).json()
        code = spy_email_sender.link_codes[0]["code"]
        await client.post(
            "/api/v1/auth/email/link/confirm",
            json={"pending_token": pending["pending_token"], "code": code},
            headers=_bearer(login["access_token"]),
        )

        ghost = await client.post(
            "/api/v1/auth/email/login",
            json={
                "email": "ghost@example.com",
                "password": "password-123",
                "device_id": str(uuid.uuid4()),
            },
        )
        wrong_password = await client.post(
            "/api/v1/auth/email/login",
            json={
                "email": "user@example.com",
                "password": "wrong-password",
                "device_id": str(uuid.uuid4()),
            },
        )
        assert ghost.status_code == 401 == wrong_password.status_code
        assert ghost.json() == wrong_password.json()


class TestPasswordReset:
    async def _link_email(self, client, spy_email_sender, email="reset@example.com"):
        login = await register_device(client)
        pending = (
            await client.post(
                "/api/v1/auth/email/link",
                json={"email": email, "password": "old-password-1"},
                headers=_bearer(login["access_token"]),
            )
        ).json()
        code = spy_email_sender.link_codes[0]["code"]
        await client.post(
            "/api/v1/auth/email/link/confirm",
            json={"pending_token": pending["pending_token"], "code": code},
            headers=_bearer(login["access_token"]),
        )
        return login

    async def test_request_response_identical_for_any_email(
        self, client, spy_email_sender, monkeypatch
    ):
        # IP-лимит 1/21ч поднят, чтобы два запроса подряд прошли без 429
        from app.core.config import APP_CONFIG

        monkeypatch.setattr(APP_CONFIG.security, "password_reset_rate_limit", 100)

        await self._link_email(client, spy_email_sender)
        existing = await client.post(
            "/api/v1/auth/password-reset/request", json={"email": "reset@example.com"}
        )
        assert existing.status_code == 200
        ghost = await client.post(
            "/api/v1/auth/password-reset/request", json={"email": "ghost@example.com"}
        )
        assert ghost.status_code == 200
        assert ghost.json() == existing.json()
        # Письмо ушло только на существующий email
        assert [m["email"] for m in spy_email_sender.password_resets] == ["reset@example.com"]

    async def test_full_reset_flow(self, client, spy_email_sender):
        await self._link_email(client, spy_email_sender)
        await client.post(
            "/api/v1/auth/password-reset/request", json={"email": "reset@example.com"}
        )
        reset_token = spy_email_sender.password_resets[0]["reset_token"]

        confirm = await client.post(
            "/api/v1/auth/password-reset/confirm",
            json={"token": reset_token, "new_password": "new-password-9"},
        )
        assert confirm.status_code == 200

        # Старый пароль не работает, новый работает
        old_login = await client.post(
            "/api/v1/auth/email/login",
            json={
                "email": "reset@example.com",
                "password": "old-password-1",
                "device_id": str(uuid.uuid4()),
            },
        )
        assert old_login.status_code == 401
        new_login = await client.post(
            "/api/v1/auth/email/login",
            json={
                "email": "reset@example.com",
                "password": "new-password-9",
                "device_id": str(uuid.uuid4()),
            },
        )
        assert new_login.status_code == 200

    async def test_confirm_invalid_token_400(self, client):
        response = await client.post(
            "/api/v1/auth/password-reset/confirm",
            json={"token": "no-such", "new_password": "new-password-9"},
        )
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "AUTH_RESET_TOKEN_INVALID"


class TestConsents:
    async def test_accept_consents(self, client):
        login = await register_device(client)
        response = await client.post(
            "/api/v1/users/me/consents",
            json={
                "age_confirmed": True,
                "disclaimer_accepted": True,
                "offer_accepted": True,
                "offer_version": "2026-09-01",
            },
            headers=_bearer(login["access_token"]),
        )
        assert response.status_code == 200
        body = response.json()
        assert body["consents_completed"] is True
        assert body["accepted_at"]

    async def test_age_restricted_403(self, client):
        login = await register_device(client)
        response = await client.post(
            "/api/v1/users/me/consents",
            json={
                "age_confirmed": False,
                "disclaimer_accepted": True,
                "offer_accepted": True,
                "offer_version": "2026-09-01",
            },
            headers=_bearer(login["access_token"]),
        )
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "AGE_RESTRICTED"

    async def test_consents_unauthorized_401(self, client):
        response = await client.post(
            "/api/v1/users/me/consents",
            json={
                "age_confirmed": True,
                "disclaimer_accepted": True,
                "offer_accepted": True,
                "offer_version": "2026-09-01",
            },
        )
        assert response.status_code == 401


class TestAuthGuards:
    async def test_expired_token_401_code(self, client):
        expired = create_access_token(str(uuid.uuid4()), expires_delta=timedelta(seconds=-1))
        response = await client.post(
            "/api/v1/users/me/consents",
            json={
                "age_confirmed": True,
                "disclaimer_accepted": True,
                "offer_accepted": True,
                "offer_version": "1",
            },
            headers=_bearer(expired.token),
        )
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "AUTH_TOKEN_EXPIRED"

    async def test_invalid_token_401_code(self, client):
        response = await client.post(
            "/api/v1/users/me/consents",
            json={
                "age_confirmed": True,
                "disclaimer_accepted": True,
                "offer_accepted": True,
                "offer_version": "1",
            },
            headers=_bearer("garbage-token"),
        )
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "AUTH_TOKEN_INVALID"


class TestHealthEndpoints:
    async def test_liveness(self, client):
        response = await client.get("/health")
        assert response.status_code == 200
        assert response.json() == {"status": "ok"}

    async def test_readiness_ok(self, client):
        response = await client.get("/health/ready")
        assert response.status_code == 200
        assert response.json()["checks"]["redis"] == "ok"

    async def test_version(self, client):
        response = await client.get("/version")
        assert response.status_code == 200
        assert "version" in response.json()

    async def test_metrics(self, client):
        response = await client.get("/metrics")
        assert response.status_code == 200

    async def test_unknown_path_404_format(self, client):
        response = await client.get("/api/v1/no-such-path")
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "NOT_FOUND"
