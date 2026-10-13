"""Юнит-тесты AntiSpamService (задача 4.3): evaluate_* и anti-enumeration cooldown."""

from app.core.config import SecuritySettings
from app.services.anti_spam_service import (
    AntiSpamService,
    RequestSecurityContext,
    build_contact_handles,
)
from app.services.rate_limit_service import InMemoryRateLimitBackend


def _service(**overrides) -> tuple[AntiSpamService, InMemoryRateLimitBackend]:
    settings = SecuritySettings()
    for key, value in overrides.items():
        setattr(settings, key, value)
    backend = InMemoryRateLimitBackend()
    return AntiSpamService(rate_limit_backend=backend, settings=settings), backend


def _context(ip: str = "1.2.3.4") -> RequestSecurityContext:
    return RequestSecurityContext(ip_address=ip, user_agent="ua")


async def test_evaluate_device_login_limit():
    service, _ = _service(
        device_login_rate_limit=2, device_login_rate_limit_window_seconds=60
    )
    assert (await service.evaluate_device_login(context=_context())).allowed
    assert (await service.evaluate_device_login(context=_context())).allowed
    decision = await service.evaluate_device_login(context=_context())
    assert not decision.allowed
    assert decision.reason == "ip_rate_limit"
    assert 0 < decision.retry_after_seconds <= 60


async def test_evaluate_device_login_per_ip_isolated():
    service, _ = _service(device_login_rate_limit=1)
    assert (await service.evaluate_device_login(context=_context("1.1.1.1"))).allowed
    assert (await service.evaluate_device_login(context=_context("2.2.2.2"))).allowed
    assert not (
        await service.evaluate_device_login(context=_context("1.1.1.1"))
    ).allowed


async def test_evaluate_email_login_limit():
    service, _ = _service(
        email_login_rate_limit=1, email_login_rate_limit_window_seconds=300
    )
    assert (await service.evaluate_email_login(context=_context())).allowed
    decision = await service.evaluate_email_login(context=_context())
    assert not decision.allowed
    assert 0 < decision.retry_after_seconds <= 300


async def test_evaluate_email_link_ip_and_contact():
    handles = build_contact_handles(email="User@Example.com")
    service, _ = _service(
        email_link_rate_limit=10, email_link_rate_limit_window_seconds=3600
    )
    service.settings.email_link_rate_limit = 2
    assert (
        await service.evaluate_email_link(context=_context(), contact_handles=handles)
    ).allowed
    assert (
        await service.evaluate_email_link(context=_context(), contact_handles=handles)
    ).allowed
    decision = await service.evaluate_email_link(
        context=_context(), contact_handles=handles
    )
    assert not decision.allowed


async def test_evaluate_email_link_contact_limit_separate_from_ip():
    # Контактный лимит срабатывает даже при разных IP
    handles = build_contact_handles(email="same@example.com")
    service, _ = _service(
        email_link_rate_limit=1, email_link_rate_limit_window_seconds=3600
    )
    assert (
        await service.evaluate_email_link(
            context=_context("1.1.1.1"), contact_handles=handles
        )
    ).allowed
    decision = await service.evaluate_email_link(
        context=_context("2.2.2.2"), contact_handles=handles
    )
    assert not decision.allowed
    assert decision.reason == "contact_cooldown"
    assert decision.blocked_contact is not None


async def test_evaluate_password_reset_ip_limit():
    handles = build_contact_handles(email="a@b.co")
    service, _ = _service(
        password_reset_rate_limit=1, password_reset_rate_limit_window_seconds=100
    )
    assert (
        await service.evaluate_password_reset(
            context=_context(), contact_handles=handles
        )
    ).allowed
    # Другой email, но тот же IP — всё равно блок (лимит по IP)
    other = build_contact_handles(email="c@d.co")
    decision = await service.evaluate_password_reset(
        context=_context(), contact_handles=other
    )
    assert not decision.allowed
    assert decision.reason == "ip_rate_limit"


async def test_record_password_reset_request_sets_cooldown_for_unknown_email():
    """Anti-enumeration: cooldown пишется даже для несуществующего адреса."""
    handles = build_contact_handles(email="ghost@nowhere.tld")
    service, _ = _service(
        password_reset_rate_limit=100,
        password_reset_rate_limit_window_seconds=100,
        password_reset_cooldown_seconds=75600,
    )
    await service.record_password_reset_request(contact_handles=handles)
    decision = await service.evaluate_password_reset(
        context=_context(), contact_handles=handles
    )
    assert not decision.allowed
    assert decision.reason == "contact_cooldown"
    assert decision.retry_after_seconds > 0


async def test_evaluate_password_reset_confirm_limit():
    service, _ = _service(
        password_reset_confirm_rate_limit=2,
        password_reset_confirm_rate_limit_window_seconds=300,
    )
    assert (await service.evaluate_password_reset_confirm(context=_context())).allowed
    assert (await service.evaluate_password_reset_confirm(context=_context())).allowed
    assert not (
        await service.evaluate_password_reset_confirm(context=_context())
    ).allowed


def test_build_contact_handles_normalizes_and_masks():
    (handle,) = build_contact_handles(email="  User.Name@Example.COM ")
    assert handle.normalized_value == "user.name@example.com"
    assert "user.name" not in handle.masked_value
    assert "example.com" not in handle.masked_value
    assert len(handle.entity_id) == 64  # sha256 hex


def test_build_contact_handles_empty():
    assert build_contact_handles(email=None) == ()
    assert build_contact_handles(email="  ") == ()
