"""Юнит-тесты сброса пароля и EmailSender-протокола (задачи 4.7, 4.8)."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest

from app.core.security import hash_password, hash_token, verify_password
from app.repositories.audit_log_repository import AuditLogRepository
from app.repositories.auth_repository import AuthRepository
from app.repositories.consent_repository import ConsentRepository
from app.repositories.user_repository import AuthIdentityRepository, UserRepository
from app.schemas.auth import PasswordResetConfirmRequest, PasswordResetRequest
from app.services.anti_spam_service import (
    AntiSpamService,
    RequestSecurityContext,
    build_contact_handles,
)
from app.services.auth_service import _PASSWORD_RESET_NEUTRAL_MESSAGE, AuthService
from app.services.exceptions import InvalidResetTokenError, ServiceUnavailableError
from app.services.rate_limit_service import InMemoryRateLimitBackend
from tests.conftest import SpyEmailSender


def _context() -> RequestSecurityContext:
    return RequestSecurityContext(ip_address="10.0.0.1", user_agent="pytest/1.0")


class FailingEmailSender(SpyEmailSender):
    async def send_password_reset(
        self, *, email: str, reset_token: str, expires_at
    ) -> None:
        raise RuntimeError("SMTP down")


def _service(db_session, sender, backend=None) -> AuthService:
    return AuthService(
        session=db_session,
        user_repository=UserRepository(db_session),
        identity_repository=AuthIdentityRepository(db_session),
        auth_repository=AuthRepository(db_session),
        consent_repository=ConsentRepository(db_session),
        audit_log_repository=AuditLogRepository(db_session),
        anti_spam_service=AntiSpamService(
            rate_limit_backend=backend or InMemoryRateLimitBackend()
        ),
        email_sender=sender,
    )


async def _make_email_user(
    db_session, email="reset@example.com", password="old-password-1"
):
    users = UserRepository(db_session)
    identities = AuthIdentityRepository(db_session)
    user = await users.create_with_identity(
        kind="device", identifier=str(uuid.uuid4()), secret_hash=hash_password("dk")
    )
    await identities.create(
        user_id=user.id,
        kind="email",
        identifier=email,
        secret_hash=hash_password(password),
    )
    await db_session.commit()
    return user


async def test_request_reset_existing_email_sends_and_stores_hash(db_session):
    await _make_email_user(db_session)
    sender = SpyEmailSender()
    service = _service(db_session, sender)

    response = await service.request_password_reset(
        PasswordResetRequest(email="reset@example.com"), context=_context()
    )
    assert response.message == _PASSWORD_RESET_NEUTRAL_MESSAGE
    assert len(sender.password_resets) == 1
    sent = sender.password_resets[0]
    assert sent["email"] == "reset@example.com"

    # В БД — только хэш токена
    auth = AuthRepository(db_session)
    stored = await auth.get_active_password_reset_token(hash_token(sent["reset_token"]))
    assert stored is not None
    assert stored.token_hash != sent["reset_token"]


async def test_request_reset_unknown_email_same_response_cooldown_written(db_session):
    sender = SpyEmailSender()
    backend = InMemoryRateLimitBackend()
    service = _service(db_session, sender, backend)

    response = await service.request_password_reset(
        PasswordResetRequest(email="ghost@example.com"), context=_context()
    )
    # Ответ идентичен успешному случаю, письмо не отправлено
    assert response.message == _PASSWORD_RESET_NEUTRAL_MESSAGE
    assert sender.password_resets == []

    # Cooldown по хэшу email записан даже для несуществующего адреса
    (handle,) = build_contact_handles(email="ghost@example.com")
    assert await backend.check_cooldown(
        f"cooldown:password_reset_contact:{handle.entity_id}"
    )


async def test_request_reset_invalidates_previous_tokens(db_session):
    await _make_email_user(db_session)
    sender = SpyEmailSender()
    service = _service(db_session, sender)

    await service.request_password_reset(
        PasswordResetRequest(email="reset@example.com"), context=_context()
    )
    first_token = sender.password_resets[0]["reset_token"]

    # Снимаем cooldown, чтобы второй запрос прошёл (юнит-уровень)
    backend = InMemoryRateLimitBackend()
    service2 = _service(db_session, sender, backend)
    await service2.request_password_reset(
        PasswordResetRequest(email="reset@example.com"), context=_context()
    )
    second_token = sender.password_resets[1]["reset_token"]

    auth = AuthRepository(db_session)
    assert await auth.get_active_password_reset_token(hash_token(first_token)) is None
    assert (
        await auth.get_active_password_reset_token(hash_token(second_token)) is not None
    )


async def test_email_send_failure_rolls_back_transaction(db_session):
    """Сбой отправки письма до коммита — откат: токен не остаётся в БД."""
    await _make_email_user(db_session)
    sender = FailingEmailSender()
    service = _service(db_session, sender)

    with pytest.raises(ServiceUnavailableError):
        await service.request_password_reset(
            PasswordResetRequest(email="reset@example.com"), context=_context()
        )

    auth = AuthRepository(db_session)
    # Токен не сохранён — транзакция откачена
    assert await auth.get_active_password_reset_token(hash_token("anything")) is None
    from sqlalchemy import select

    from app.models.password_reset_token import PasswordResetToken

    result = await db_session.execute(select(PasswordResetToken))
    assert result.scalars().all() == []


async def test_confirm_reset_updates_password_and_revokes_refresh(db_session):
    user = await _make_email_user(db_session)
    sender = SpyEmailSender()
    service = _service(db_session, sender)

    # Активная сессия этого же пользователя
    auth = AuthRepository(db_session)
    refresh_value = "user-refresh-token"
    await auth.create_refresh_token(
        user_id=user.id,
        token_hash=hash_token(refresh_value),
        expires_at=datetime.now(UTC) + timedelta(days=30),
    )
    await db_session.commit()
    assert await auth.get_active_refresh_token(hash_token(refresh_value)) is not None

    await service.request_password_reset(
        PasswordResetRequest(email="reset@example.com"), context=_context()
    )
    reset_token = sender.password_resets[0]["reset_token"]

    response = await service.confirm_password_reset(
        PasswordResetConfirmRequest(token=reset_token, new_password="new-password-9"),
        context=_context(),
    )
    assert response.message

    # Пароль обновлён (argon2id)
    identities = AuthIdentityRepository(db_session)
    identity = await identities.get_by_kind_identifier("email", "reset@example.com")
    assert verify_password("new-password-9", identity.secret_hash)
    assert not verify_password("old-password-1", identity.secret_hash)

    # Токен использован, все refresh отозваны
    assert await auth.get_active_password_reset_token(hash_token(reset_token)) is None
    assert await auth.get_active_refresh_token(hash_token(refresh_value)) is None

    # Письмо-уведомление отправлено
    assert sender.password_changed == [{"email": "reset@example.com"}]


async def test_confirm_reset_invalid_token(db_session):
    sender = SpyEmailSender()
    service = _service(db_session, sender)
    with pytest.raises(InvalidResetTokenError):
        await service.confirm_password_reset(
            PasswordResetConfirmRequest(
                token="no-such-token", new_password="new-password-9"
            ),
            context=_context(),
        )


async def test_confirm_reset_used_token(db_session):
    await _make_email_user(db_session)
    sender = SpyEmailSender()
    backend = InMemoryRateLimitBackend()
    service = _service(db_session, sender, backend)
    await service.request_password_reset(
        PasswordResetRequest(email="reset@example.com"), context=_context()
    )
    reset_token = sender.password_resets[0]["reset_token"]
    await service.confirm_password_reset(
        PasswordResetConfirmRequest(token=reset_token, new_password="new-password-9"),
        context=_context(),
    )
    with pytest.raises(InvalidResetTokenError):
        await service.confirm_password_reset(
            PasswordResetConfirmRequest(
                token=reset_token, new_password="another-pass-1"
            ),
            context=_context(),
        )
