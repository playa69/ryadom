"""Юнит-тесты AuthService: device/email вход, ротация, logout (задачи 4.4, 4.5)."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest

from app.core.security import decode_and_validate_jwt, hash_token
from app.repositories.audit_log_repository import AuditLogRepository
from app.repositories.auth_repository import AuthRepository
from app.repositories.consent_repository import ConsentRepository
from app.repositories.user_repository import AuthIdentityRepository, UserRepository
from app.schemas.auth import (
    DeviceLoginRequest,
    EmailLoginRequest,
    RefreshRequest,
)
from app.services.anti_spam_service import AntiSpamService, RequestSecurityContext
from app.services.auth_service import AuthService
from app.services.exceptions import InvalidCredentialsError, InvalidRefreshTokenError
from app.services.rate_limit_service import InMemoryRateLimitBackend
from tests.conftest import SpyEmailSender


def _context() -> RequestSecurityContext:
    return RequestSecurityContext(ip_address="10.0.0.1", user_agent="pytest/1.0")


def _service(db_session) -> AuthService:
    return AuthService(
        session=db_session,
        user_repository=UserRepository(db_session),
        identity_repository=AuthIdentityRepository(db_session),
        auth_repository=AuthRepository(db_session),
        consent_repository=ConsentRepository(db_session),
        audit_log_repository=AuditLogRepository(db_session),
        anti_spam_service=AntiSpamService(rate_limit_backend=InMemoryRateLimitBackend()),
        email_sender=SpyEmailSender(),
    )


def _device_request(device_id: str, key: str = "device-key-1") -> DeviceLoginRequest:
    return DeviceLoginRequest(device_id=uuid.UUID(device_id), device_key=key, platform="ios")


async def test_device_login_first_time_creates_user(db_session):
    service = _service(db_session)
    device_id = str(uuid.uuid4())
    response = await service.device_login(_device_request(device_id), context=_context())

    assert response.is_new_user is True
    assert response.user.is_anonymous is True
    assert response.user.has_email is False
    assert response.expires_in == 900
    assert response.refresh_expires_in == 2592000
    payload = decode_and_validate_jwt(response.access_token)
    assert payload.sub == str(response.user.id)


async def test_device_login_repeat_is_idempotent(db_session):
    service = _service(db_session)
    device_id = str(uuid.uuid4())
    first = await service.device_login(_device_request(device_id), context=_context())
    second = await service.device_login(_device_request(device_id), context=_context())

    assert second.is_new_user is False
    assert second.user.id == first.user.id
    # Дубликат пользователя не создан
    users = UserRepository(db_session)
    assert (await users.get_by_identity("device", device_id)).id == first.user.id


async def test_device_login_wrong_key_rejected(db_session):
    service = _service(db_session)
    device_id = str(uuid.uuid4())
    await service.device_login(_device_request(device_id, key="right-key"), context=_context())

    with pytest.raises(InvalidCredentialsError):
        await service.device_login(_device_request(device_id, key="wrong-key"), context=_context())


async def _make_email_user(db_session, email="user@example.com", password="password-123"):
    users = UserRepository(db_session)
    from app.core.security import hash_password

    user = await users.create_with_identity(
        kind="device", identifier=str(uuid.uuid4()), secret_hash=hash_password("dk")
    )
    identities = AuthIdentityRepository(db_session)
    await identities.create(
        user_id=user.id, kind="email", identifier=email, secret_hash=hash_password(password)
    )
    await db_session.commit()
    return user


async def test_email_login_success(db_session):
    user = await _make_email_user(db_session)
    service = _service(db_session)
    response = await service.email_login(
        EmailLoginRequest(
            email="user@example.com", password="password-123", device_id=uuid.uuid4()
        ),
        context=_context(),
    )
    assert response.user.id == user.id
    assert response.user.has_email is True
    assert response.user.is_anonymous is False
    assert response.is_new_user is False


async def test_email_login_anti_enumeration(db_session):
    await _make_email_user(db_session)
    service = _service(db_session)

    # Несуществующий email
    with pytest.raises(InvalidCredentialsError) as no_user:
        await service.email_login(
            EmailLoginRequest(
                email="ghost@example.com", password="password-123", device_id=uuid.uuid4()
            ),
            context=_context(),
        )
    # Неверный пароль
    with pytest.raises(InvalidCredentialsError) as bad_password:
        await service.email_login(
            EmailLoginRequest(
                email="user@example.com", password="wrong-password", device_id=uuid.uuid4()
            ),
            context=_context(),
        )
    # Ответы идентичны: код, статус, сообщение
    assert no_user.value.code == bad_password.value.code
    assert no_user.value.status_code == bad_password.value.status_code
    assert no_user.value.message == bad_password.value.message


async def test_refresh_rotation_normal(db_session):
    service = _service(db_session)
    login = await service.device_login(
        _device_request(str(uuid.uuid4())), context=_context()
    )

    rotated = await service.refresh(
        RefreshRequest(refresh_token=login.refresh_token), context=_context()
    )
    assert rotated.access_token != login.access_token
    assert rotated.refresh_token != login.refresh_token

    # Старый refresh отозван
    auth = AuthRepository(db_session)
    old = await auth.get_refresh_token_by_hash(hash_token(login.refresh_token))
    assert old is not None and old.revoked_at is not None
    # Новый наследует device_id
    new = await auth.get_active_refresh_token(hash_token(rotated.refresh_token))
    assert new is not None and new.device_id == old.device_id


async def test_refresh_reuse_within_grace_window(db_session):
    service = _service(db_session)
    login = await service.device_login(
        _device_request(str(uuid.uuid4())), context=_context()
    )
    await service.refresh(RefreshRequest(refresh_token=login.refresh_token), context=_context())

    # Повтор того же токена в grace-окне 10 сек — новая пара без family kill
    second = await service.refresh(
        RefreshRequest(refresh_token=login.refresh_token), context=_context()
    )
    assert second.access_token


async def test_refresh_replay_outside_grace_kills_family(db_session):
    service = _service(db_session)
    login = await service.device_login(
        _device_request(str(uuid.uuid4())), context=_context()
    )
    rotated = await service.refresh(
        RefreshRequest(refresh_token=login.refresh_token), context=_context()
    )

    # Сдвигаем revoked_at старого токена за пределы grace-окна
    auth = AuthRepository(db_session)
    old = await auth.get_refresh_token_by_hash(hash_token(login.refresh_token))
    old.revoked_at = datetime.now(UTC) - timedelta(seconds=61)
    await db_session.commit()

    with pytest.raises(InvalidRefreshTokenError):
        await service.refresh(
            RefreshRequest(refresh_token=login.refresh_token), context=_context()
        )

    # Все refresh пользователя отозваны (family kill), включая свежий
    assert await auth.get_active_refresh_token(hash_token(rotated.refresh_token)) is None
    # Событие family-revoke в аудите
    audits = AuditLogRepository(db_session)
    count = await audits.count_recent(
        actions=("auth.refresh.family_revoke",),
        entity_type="user",
        entity_id=str(login.user.id),
        since=datetime.now(UTC) - timedelta(minutes=1),
    )
    assert count == 1


async def test_refresh_unknown_token(db_session):
    service = _service(db_session)
    with pytest.raises(InvalidRefreshTokenError):
        await service.refresh(RefreshRequest(refresh_token="unknown"), context=_context())


async def test_logout_revokes_and_is_idempotent(db_session):
    service = _service(db_session)
    login = await service.device_login(
        _device_request(str(uuid.uuid4())), context=_context()
    )

    first = await service.logout(
        RefreshRequest(refresh_token=login.refresh_token), context=_context()
    )
    auth = AuthRepository(db_session)
    assert await auth.get_active_refresh_token(hash_token(login.refresh_token)) is None

    # Повторный logout — тот же успешный ответ
    second = await service.logout(
        RefreshRequest(refresh_token=login.refresh_token), context=_context()
    )
    assert first.message == second.message

    # Logout с неизвестным токеном — тоже успех
    third = await service.logout(RefreshRequest(refresh_token="unknown"), context=_context())
    assert third.message == first.message
