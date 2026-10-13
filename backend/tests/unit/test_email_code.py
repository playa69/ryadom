"""Юнит-тесты флоу привязки email по коду (задача 4.6)."""

import json
import uuid

import pytest

from app.core.config import APP_CONFIG
from app.repositories.audit_log_repository import AuditLogRepository
from app.repositories.auth_repository import AuthRepository
from app.repositories.consent_repository import ConsentRepository
from app.repositories.user_repository import AuthIdentityRepository, UserRepository
from app.schemas.auth import EmailLinkConfirmRequest, EmailLinkRequest
from app.services.anti_spam_service import AntiSpamService, RequestSecurityContext
from app.services.auth_service import AuthService
from app.services.email_code_service import (
    PENDING_KEY_PREFIX,
    EmailLinkCodeService,
    mask_email_local,
)
from app.services.exceptions import (
    EmailAlreadyLinkedError,
    EmailCodeExpiredError,
    EmailCodeInvalidError,
    EmailCodeTooManyAttemptsError,
    RateLimitExceededError,
)
from app.services.rate_limit_service import RedisRateLimitBackend
from tests.conftest import SpyEmailSender


def _context() -> RequestSecurityContext:
    return RequestSecurityContext(ip_address="10.0.0.1", user_agent="pytest/1.0")


def _code_service(fake_redis, sender: SpyEmailSender) -> EmailLinkCodeService:
    return EmailLinkCodeService(
        redis=fake_redis,
        rate_limit_backend=RedisRateLimitBackend(fake_redis),
        send_code=sender.send_email_link_code,
    )


async def _read_pending_code(fake_redis, pending_token) -> str:
    raw = await fake_redis.get(f"{PENDING_KEY_PREFIX}{pending_token}")
    return json.loads(raw)["code"]


async def test_start_sends_code_and_returns_pending(fake_redis):
    sender = SpyEmailSender()
    service = _code_service(fake_redis, sender)
    pending = await service.start(
        user_id=uuid.uuid4(),
        email="User@Example.com",
        rate_limit_key="user-1",
        send_rate_limit=5,
        send_rate_window_seconds=3600,
    )
    assert pending.expires_in_seconds == APP_CONFIG.email_code.code_ttl_seconds
    assert pending.email_masked == mask_email_local("User@Example.com")
    assert len(sender.link_codes) == 1
    code = sender.link_codes[0]["code"]
    assert len(code) == 6 and code.isdigit()


async def test_one_active_code_per_user(fake_redis):
    sender = SpyEmailSender()
    service = _code_service(fake_redis, sender)
    user_id = uuid.uuid4()
    first = await service.start(
        user_id=user_id,
        email="a@b.co",
        rate_limit_key="u",
        send_rate_limit=10,
        send_rate_window_seconds=3600,
    )
    second = await service.start(
        user_id=user_id,
        email="a@b.co",
        rate_limit_key="u",
        send_rate_limit=10,
        send_rate_window_seconds=3600,
    )
    # Первый код инвалидирован
    with pytest.raises(EmailCodeExpiredError):
        await service.verify_code(pending_token=first.pending_token, code="000000")
    assert await _read_pending_code(fake_redis, second.pending_token)


async def test_send_rate_limit(fake_redis):
    sender = SpyEmailSender()
    service = _code_service(fake_redis, sender)
    with pytest.raises(RateLimitExceededError) as exc_info:
        for _ in range(3):
            await service.start(
                user_id=uuid.uuid4(),
                email="a@b.co",
                rate_limit_key="same-user",
                send_rate_limit=2,
                send_rate_window_seconds=3600,
            )
    assert exc_info.value.retry_after_seconds == 3600


async def test_verify_success_single_use(fake_redis):
    sender = SpyEmailSender()
    service = _code_service(fake_redis, sender)
    pending = await service.start(
        user_id=uuid.uuid4(),
        email="a@b.co",
        rate_limit_key="u",
        send_rate_limit=5,
        send_rate_window_seconds=3600,
        extra_payload={"email": "a@b.co"},
    )
    code = sender.link_codes[0]["code"]
    verified = await service.verify_code(pending_token=pending.pending_token, code=code)
    assert verified.payload["email"] == "a@b.co"
    # Повторное использование — код уже инвалидирован
    with pytest.raises(EmailCodeExpiredError):
        await service.verify_code(pending_token=pending.pending_token, code=code)


async def test_verify_wrong_code_remaining_attempts(fake_redis):
    sender = SpyEmailSender()
    service = _code_service(fake_redis, sender)
    pending = await service.start(
        user_id=uuid.uuid4(),
        email="a@b.co",
        rate_limit_key="u",
        send_rate_limit=5,
        send_rate_window_seconds=3600,
    )
    real_code = sender.link_codes[0]["code"]
    wrong_code = "000000" if real_code != "000000" else "111111"
    with pytest.raises(EmailCodeInvalidError) as exc_info:
        await service.verify_code(pending_token=pending.pending_token, code=wrong_code)
    max_attempts = APP_CONFIG.email_code.max_attempts
    assert exc_info.value.details == {"remaining_attempts": max_attempts - 1}


async def test_verify_too_many_attempts_invalidates(fake_redis):
    sender = SpyEmailSender()
    service = _code_service(fake_redis, sender)
    pending = await service.start(
        user_id=uuid.uuid4(),
        email="a@b.co",
        rate_limit_key="u",
        send_rate_limit=5,
        send_rate_window_seconds=3600,
    )
    real_code = sender.link_codes[0]["code"]
    wrong_code = "000000" if real_code != "000000" else "111111"
    max_attempts = APP_CONFIG.email_code.max_attempts
    for _ in range(max_attempts - 1):
        with pytest.raises(EmailCodeInvalidError):
            await service.verify_code(
                pending_token=pending.pending_token, code=wrong_code
            )
    with pytest.raises(EmailCodeTooManyAttemptsError):
        await service.verify_code(pending_token=pending.pending_token, code=wrong_code)
    # После исчерпания попыток даже верный код не принимается
    with pytest.raises(EmailCodeExpiredError):
        await service.verify_code(pending_token=pending.pending_token, code=real_code)


async def test_link_and_confirm_email_full_flow(db_session, fake_redis):
    sender = SpyEmailSender()
    service = AuthService(
        session=db_session,
        user_repository=UserRepository(db_session),
        identity_repository=AuthIdentityRepository(db_session),
        auth_repository=AuthRepository(db_session),
        consent_repository=ConsentRepository(db_session),
        audit_log_repository=AuditLogRepository(db_session),
        anti_spam_service=AntiSpamService(
            rate_limit_backend=RedisRateLimitBackend(fake_redis)
        ),
        email_sender=sender,
        email_code_service=_code_service(fake_redis, sender),
    )
    users = UserRepository(db_session)
    user = await users.create_with_identity(
        kind="device", identifier=str(uuid.uuid4()), secret_hash="h"
    )
    await db_session.commit()

    pending = await service.link_email(
        user,
        EmailLinkRequest(email="new@example.com", password="password-123"),
        context=_context(),
    )
    assert pending.expires_in == 600
    assert "new@example.com" != pending.email_masked
    assert pending.email_masked.startswith("n***w@")

    code = sender.link_codes[0]["code"]
    confirmed = await service.confirm_email_link(
        user,
        EmailLinkConfirmRequest(pending_token=pending.pending_token, code=code),
        context=_context(),
    )
    assert confirmed.user.has_email is True
    assert confirmed.user.is_anonymous is False

    # Пароль применён — вход по email работает
    from app.core.security import verify_password

    identities = AuthIdentityRepository(db_session)
    identity = await identities.get_by_kind_identifier("email", "new@example.com")
    assert identity is not None
    assert verify_password("password-123", identity.secret_hash)


async def test_link_email_conflict_other_account(db_session, fake_redis):
    sender = SpyEmailSender()
    service = AuthService(
        session=db_session,
        user_repository=UserRepository(db_session),
        identity_repository=AuthIdentityRepository(db_session),
        auth_repository=AuthRepository(db_session),
        consent_repository=ConsentRepository(db_session),
        audit_log_repository=AuditLogRepository(db_session),
        anti_spam_service=AntiSpamService(
            rate_limit_backend=RedisRateLimitBackend(fake_redis)
        ),
        email_sender=sender,
        email_code_service=_code_service(fake_redis, sender),
    )
    users = UserRepository(db_session)
    identities = AuthIdentityRepository(db_session)
    other = await users.create_with_identity(
        kind="device", identifier=str(uuid.uuid4()), secret_hash="h"
    )
    await identities.create(
        user_id=other.id, kind="email", identifier="taken@example.com", secret_hash="h"
    )
    user = await users.create_with_identity(
        kind="device", identifier=str(uuid.uuid4()), secret_hash="h"
    )
    await db_session.commit()

    with pytest.raises(EmailAlreadyLinkedError):
        await service.link_email(
            user,
            EmailLinkRequest(email="taken@example.com", password="password-123"),
            context=_context(),
        )
    # Письмо не отправлено
    assert sender.link_codes == []
