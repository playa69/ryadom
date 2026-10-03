"""Юнит-тесты согласий и security-аудита (задачи 4.9, 4.10)."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from app.models.audit_log import AuditLog
from app.repositories.audit_log_repository import AuditLogRepository
from app.repositories.consent_repository import ConsentRepository
from app.repositories.user_repository import UserRepository
from app.schemas.auth import ConsentsRequest, DeviceLoginRequest
from app.services.anti_spam_service import RequestSecurityContext
from app.services.consent_service import ConsentService
from app.services.exceptions import AgeRestrictedError, ConsentRequiredError


def _context() -> RequestSecurityContext:
    return RequestSecurityContext(ip_address="10.0.0.1", user_agent="pytest/1.0")


def _consent_service(db_session) -> ConsentService:
    return ConsentService(
        session=db_session,
        consent_repository=ConsentRepository(db_session),
        audit_log_repository=AuditLogRepository(db_session),
    )


async def _make_user(db_session):
    users = UserRepository(db_session)
    user = await users.create_with_identity(
        kind="device", identifier=str(uuid.uuid4()), secret_hash="h"
    )
    await db_session.commit()
    return user


async def test_accept_all_consents(db_session):
    user = await _make_user(db_session)
    service = _consent_service(db_session)
    response = await service.accept_consents(
        user,
        ConsentsRequest(
            age_confirmed=True,
            disclaimer_accepted=True,
            offer_accepted=True,
            offer_version="2026-09-01",
        ),
        context=_context(),
    )
    assert response.consents_completed is True
    assert response.accepted_at is not None

    consents = ConsentRepository(db_session)
    assert await consents.has_all_required(user.id)


async def test_age_not_confirmed_rejected_nothing_recorded(db_session):
    user = await _make_user(db_session)
    service = _consent_service(db_session)
    with pytest.raises(AgeRestrictedError):
        await service.accept_consents(
            user,
            ConsentsRequest(
                age_confirmed=False,
                disclaimer_accepted=True,
                offer_accepted=True,
                offer_version="2026-09-01",
            ),
            context=_context(),
        )
    consents = ConsentRepository(db_session)
    assert await consents.get_kinds(user.id) == set()


async def test_disclaimer_or_offer_not_accepted(db_session):
    user = await _make_user(db_session)
    service = _consent_service(db_session)
    with pytest.raises(ConsentRequiredError):
        await service.accept_consents(
            user,
            ConsentsRequest(
                age_confirmed=True,
                disclaimer_accepted=False,
                offer_accepted=True,
                offer_version="2026-09-01",
            ),
            context=_context(),
        )


async def test_audit_event_written_on_login(db_session):
    """Фиксация входа: IP/UA в записи, секретов и токенов в payload нет."""
    from app.repositories.auth_repository import AuthRepository
    from app.repositories.user_repository import AuthIdentityRepository
    from app.services.anti_spam_service import AntiSpamService
    from app.services.auth_service import AuthService
    from app.services.rate_limit_service import InMemoryRateLimitBackend
    from tests.conftest import SpyEmailSender

    device_key = "super-secret-device-key"
    service = AuthService(
        session=db_session,
        user_repository=UserRepository(db_session),
        identity_repository=AuthIdentityRepository(db_session),
        auth_repository=AuthRepository(db_session),
        consent_repository=ConsentRepository(db_session),
        audit_log_repository=AuditLogRepository(db_session),
        anti_spam_service=AntiSpamService(rate_limit_backend=InMemoryRateLimitBackend()),
        email_sender=SpyEmailSender(),
    )
    login = await service.device_login(
        DeviceLoginRequest(device_id=uuid.uuid4(), device_key=device_key),
        context=_context(),
    )

    result = await db_session.execute(select(AuditLog))
    events = result.scalars().all()
    assert len(events) == 1
    event = events[0]
    assert event.action == "auth.device_login.succeeded"
    assert event.ip == "10.0.0.1"
    assert event.user_agent == "pytest/1.0"
    assert event.actor_user_id == login.user.id

    # Секреты и токены не попадают в аудит
    raw_payload = str(event.payload)
    assert device_key not in raw_payload
    assert login.refresh_token not in raw_payload
    assert login.access_token not in raw_payload
