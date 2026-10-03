"""Антиспам auth-контуров (design.md D3, specs/auth «Rate-limit и антиспам»).

Action'ы: device_login, email_login, email_link, password_reset,
password_reset_confirm. Все пороги и окна — из конфига (SecuritySettings).
Счётчики — sliding window через RateLimitBackend, cooldown — блокировка с TTL.
"""

from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass
from typing import Literal

from app.core.config import APP_CONFIG, SecuritySettings
from app.services.rate_limit_service import RateLimitBackend

DEVICE_LOGIN_ACTION = "auth.device_login"
EMAIL_LOGIN_ACTION = "auth.email_login"
EMAIL_LINK_ACTION = "auth.email_link"
PASSWORD_RESET_ACTION = "auth.password_reset"
PASSWORD_RESET_CONFIRM_ACTION = "auth.password_reset_confirm"


@dataclass(slots=True, frozen=True)
class RequestSecurityContext:
    ip_address: str
    user_agent: str | None = None


@dataclass(slots=True, frozen=True)
class ContactHandle:
    kind: Literal["email"]
    normalized_value: str
    masked_value: str
    entity_id: str


@dataclass(slots=True, frozen=True)
class AntiSpamDecision:
    allowed: bool
    reason: Literal["ok", "ip_rate_limit", "contact_cooldown"]
    retry_after_seconds: int | None = None
    blocked_contact: ContactHandle | None = None


def build_contact_handles(*, email: str | None = None) -> tuple[ContactHandle, ...]:
    """Нормализует контакт и строит handle с маской и хэшем (для ключей/аудита)."""
    handles: list[ContactHandle] = []
    normalized_email = normalize_email(email)
    if normalized_email is not None:
        handles.append(
            ContactHandle(
                kind="email",
                normalized_value=normalized_email,
                masked_value=mask_contact_email(normalized_email),
                entity_id=_hash_contact("email", normalized_email),
            )
        )
    return tuple(handles)


def normalize_email(email: str | None) -> str | None:
    if email is None:
        return None
    normalized = email.strip().lower()
    return normalized or None


def mask_contact_email(email: str) -> str:
    local_part, _, domain = email.partition("@")
    masked_local = _mask_token(local_part)
    masked_domain = _mask_token(domain)
    return f"{masked_local}@{masked_domain}" if domain else masked_local


class AntiSpamService:
    def __init__(
        self,
        *,
        rate_limit_backend: RateLimitBackend,
        settings: SecuritySettings | None = None,
    ) -> None:
        self.rate_limit_backend = rate_limit_backend
        self.settings = settings or APP_CONFIG.security

    # ------------------------------------------------------------------
    # Оценка до обработки
    # ------------------------------------------------------------------

    async def evaluate_device_login(self, *, context: RequestSecurityContext) -> AntiSpamDecision:
        """POST /auth/device — 20/час по IP."""
        return await self._evaluate_ip_limit(
            ip_address=context.ip_address,
            action=DEVICE_LOGIN_ACTION,
            max_attempts=self.settings.device_login_rate_limit,
            window_seconds=self.settings.device_login_rate_limit_window_seconds,
        )

    async def evaluate_email_login(self, *, context: RequestSecurityContext) -> AntiSpamDecision:
        """POST /auth/email/login — 10/5 мин по IP."""
        return await self._evaluate_ip_limit(
            ip_address=context.ip_address,
            action=EMAIL_LOGIN_ACTION,
            max_attempts=self.settings.email_login_rate_limit,
            window_seconds=self.settings.email_login_rate_limit_window_seconds,
        )

    async def evaluate_email_link(
        self,
        *,
        context: RequestSecurityContext,
        contact_handles: tuple[ContactHandle, ...],
    ) -> AntiSpamDecision:
        """Привязка email — 5 кодов/час по IP и на хэш email."""
        ip_decision = await self._evaluate_ip_limit(
            ip_address=context.ip_address,
            action=EMAIL_LINK_ACTION,
            max_attempts=self.settings.email_link_rate_limit,
            window_seconds=self.settings.email_link_rate_limit_window_seconds,
        )
        if not ip_decision.allowed:
            return ip_decision
        return await self._evaluate_contact_limit(
            action=EMAIL_LINK_ACTION,
            contact_handles=contact_handles,
            max_attempts=self.settings.email_link_rate_limit,
            window_seconds=self.settings.email_link_rate_limit_window_seconds,
        )

    async def evaluate_password_reset(
        self,
        *,
        context: RequestSecurityContext,
        contact_handles: tuple[ContactHandle, ...],
    ) -> AntiSpamDecision:
        """POST /auth/password-reset/request — 1/21 час по IP и по хэшу email."""
        ip_decision = await self._evaluate_ip_limit(
            ip_address=context.ip_address,
            action=PASSWORD_RESET_ACTION,
            max_attempts=self.settings.password_reset_rate_limit,
            window_seconds=self.settings.password_reset_rate_limit_window_seconds,
        )
        if not ip_decision.allowed:
            return ip_decision
        return await self._evaluate_contact_cooldown(
            entity_type="password_reset_contact",
            contact_handles=contact_handles,
        )

    async def evaluate_password_reset_confirm(
        self, *, context: RequestSecurityContext
    ) -> AntiSpamDecision:
        """POST /auth/password-reset/confirm — 10/5 мин по IP."""
        return await self._evaluate_ip_limit(
            ip_address=context.ip_address,
            action=PASSWORD_RESET_CONFIRM_ACTION,
            max_attempts=self.settings.password_reset_confirm_rate_limit,
            window_seconds=self.settings.password_reset_confirm_rate_limit_window_seconds,
        )

    # ------------------------------------------------------------------
    # Запись после операции
    # ------------------------------------------------------------------

    async def record_password_reset_request(
        self,
        *,
        contact_handles: tuple[ContactHandle, ...],
    ) -> None:
        """Ставит cooldown по хэшу email после запроса сброса.

        Вызывается независимо от существования аккаунта (anti-enumeration).
        """
        for handle in contact_handles:
            contact_key = f"cooldown:password_reset_contact:{handle.entity_id}"
            await self.rate_limit_backend.set_cooldown(
                contact_key, self.settings.password_reset_cooldown_seconds
            )

    # ------------------------------------------------------------------
    # Внутренние helpers
    # ------------------------------------------------------------------

    async def _evaluate_ip_limit(
        self,
        *,
        ip_address: str,
        action: str,
        max_attempts: int,
        window_seconds: int,
    ) -> AntiSpamDecision:
        key = f"rl:{action}:ip:{ip_address}"
        count, allowed = await self.rate_limit_backend.check_and_increment(
            key, window_seconds, max_attempts
        )
        if allowed:
            return AntiSpamDecision(allowed=True, reason="ok")

        last_ts = await self.rate_limit_backend.get_last_attempt_timestamp(key)
        retry_after = _calculate_retry_after_from_timestamp(
            last_ts=last_ts,
            window_seconds=window_seconds,
        )
        return AntiSpamDecision(
            allowed=False,
            reason="ip_rate_limit",
            retry_after_seconds=retry_after,
        )

    async def _evaluate_contact_limit(
        self,
        *,
        action: str,
        contact_handles: tuple[ContactHandle, ...],
        max_attempts: int,
        window_seconds: int,
    ) -> AntiSpamDecision:
        for contact_handle in contact_handles:
            key = f"rl:{action}:contact:{contact_handle.entity_id}"
            count, allowed = await self.rate_limit_backend.check_and_increment(
                key, window_seconds, max_attempts
            )
            if not allowed:
                last_ts = await self.rate_limit_backend.get_last_attempt_timestamp(key)
                retry_after = _calculate_retry_after_from_timestamp(
                    last_ts=last_ts,
                    window_seconds=window_seconds,
                )
                return AntiSpamDecision(
                    allowed=False,
                    reason="contact_cooldown",
                    retry_after_seconds=retry_after,
                    blocked_contact=contact_handle,
                )
        return AntiSpamDecision(allowed=True, reason="ok")

    async def _evaluate_contact_cooldown(
        self,
        *,
        entity_type: str,
        contact_handles: tuple[ContactHandle, ...],
    ) -> AntiSpamDecision:
        for contact_handle in contact_handles:
            key = f"cooldown:{entity_type}:{contact_handle.entity_id}"
            if await self.rate_limit_backend.check_cooldown(key):
                ttl = await self.rate_limit_backend.get_cooldown_ttl(key)
                return AntiSpamDecision(
                    allowed=False,
                    reason="contact_cooldown",
                    retry_after_seconds=ttl,
                    blocked_contact=contact_handle,
                )
        return AntiSpamDecision(allowed=True, reason="ok")


def _calculate_retry_after_from_timestamp(
    *,
    last_ts: float | None,
    window_seconds: int,
) -> int:
    if last_ts is None:
        return max(1, window_seconds)
    elapsed = int(time.time() - last_ts)
    return max(1, window_seconds - elapsed)


def _hash_contact(kind: str, value: str) -> str:
    return hashlib.sha256(f"{kind}:{value}".encode("utf-8")).hexdigest()


def _mask_token(value: str) -> str:
    if not value:
        return "***"
    if len(value) <= 2:
        return "*" * len(value)
    if len(value) <= 4:
        return f"{value[0]}{'*' * (len(value) - 1)}"
    return f"{value[:2]}{'*' * (len(value) - 3)}{value[-1]}"
