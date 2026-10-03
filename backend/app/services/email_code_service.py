"""Флоу привязки email по 6-значному коду (design.md D4).

Перенос механизма UnionApp CabinetEmailCodeService с namespace ``email_link``:
- ``email_link:pending:{pending_token}`` → JSON-payload с TTL
- ``email_link:user:{user_id}`` → активный pending_token (один код на аккаунт)
- ``email_link:send:`` → rate-limit отправки

TTL 600 сек, max 5 попыток, single-use, compare_digest, код не логируется.
"""

from __future__ import annotations

import json
import secrets
from dataclasses import dataclass
from typing import Any
from uuid import UUID, uuid4

from loguru import logger
from redis.asyncio.client import Redis
from redis.exceptions import RedisError

from app.core.config import APP_CONFIG, EmailCodeSettings
from app.services.exceptions import (
    EmailCodeExpiredError,
    EmailCodeInvalidError,
    EmailCodeTooManyAttemptsError,
    RateLimitExceededError,
    ServiceUnavailableError,
)
from app.services.rate_limit_service import RateLimitBackend

PENDING_KEY_PREFIX = "email_link:pending:"
USER_KEY_PREFIX = "email_link:user:"
SEND_RATE_KEY_PREFIX = "email_link:send:"


@dataclass(frozen=True, slots=True)
class EmailLinkPendingCode:
    pending_token: UUID
    expires_in_seconds: int
    email_masked: str


@dataclass(frozen=True, slots=True)
class EmailLinkVerifiedCode:
    user_id: UUID
    payload: dict[str, Any]


def mask_email_local(email: str) -> str:
    """Маскирует local-part email: ``u***r@example.com`` (для ответа клиенту)."""
    local, separator, domain = email.partition("@")
    if not separator or not local:
        return email
    return f"{local[0]}***{local[-1]}@{domain}"


class EmailLinkCodeService:
    """Выдача и проверка одноразовых 6-значных кодов привязки email."""

    def __init__(
        self,
        *,
        redis: Redis,
        rate_limit_backend: RateLimitBackend,
        send_code,
        settings: EmailCodeSettings | None = None,
    ) -> None:
        self.redis = redis
        self.rate_limit_backend = rate_limit_backend
        self.send_code = send_code
        self.settings = settings or APP_CONFIG.email_code

    async def start(
        self,
        *,
        user_id: UUID,
        email: str,
        rate_limit_key: str,
        send_rate_limit: int,
        send_rate_window_seconds: int,
        extra_payload: dict[str, Any] | None = None,
    ) -> EmailLinkPendingCode:
        """Генерирует код, сохраняет в Redis и отправляет на email.

        Raises:
            RateLimitExceededError: превышен лимит отправки кодов.
            ServiceUnavailableError: Redis или отправка письма недоступны.
        """
        settings = self.settings
        try:
            _, allowed = await self.rate_limit_backend.check_and_increment(
                f"{SEND_RATE_KEY_PREFIX}{rate_limit_key}",
                send_rate_window_seconds,
                send_rate_limit,
            )
        except RedisError as exc:
            logger.error(f"Rate-limit бэкенд email-кодов недоступен: {exc}")
            raise ServiceUnavailableError() from exc
        if not allowed:
            raise RateLimitExceededError(
                retry_after_seconds=send_rate_window_seconds,
            )

        code = f"{secrets.randbelow(1_000_000):06d}"
        pending_token = uuid4()
        pending_key = f"{PENDING_KEY_PREFIX}{pending_token}"
        user_key = f"{USER_KEY_PREFIX}{user_id}"

        try:
            # Один активный код на аккаунт: удаляем предыдущий pending.
            previous_token = await self.redis.get(user_key)
            if previous_token:
                await self.redis.delete(f"{PENDING_KEY_PREFIX}{previous_token}")

            payload_data: dict[str, Any] = {
                "user_id": str(user_id),
                "code": code,
                "attempts": 0,
            }
            if extra_payload:
                payload_data.update(extra_payload)
            await self.redis.set(pending_key, json.dumps(payload_data), ex=settings.code_ttl_seconds)
            await self.redis.set(user_key, str(pending_token), ex=settings.code_ttl_seconds)
        except RedisError as exc:
            logger.error(f"Хранилище email-кодов недоступно: {exc}")
            raise ServiceUnavailableError() from exc

        try:
            await self.send_code(email=email, code=code)
        except Exception as exc:
            logger.error(f"Отправка email-кода пользователю {user_id} не удалась: {exc}")
            try:
                await self.redis.delete(pending_key, user_key)
            except RedisError:
                logger.warning(f"Не удалось очистить ключи email-кода пользователя {user_id}")
            raise ServiceUnavailableError("Не удалось отправить письмо с кодом. Попробуйте позже.") from exc

        return EmailLinkPendingCode(
            pending_token=pending_token,
            expires_in_seconds=settings.code_ttl_seconds,
            email_masked=mask_email_local(email),
        )

    async def verify_code(self, *, pending_token: UUID, code: str) -> EmailLinkVerifiedCode:
        """Проверяет код; при успехе удаляет ключи (single-use).

        Raises:
            EmailCodeExpiredError: pending-запись не найдена (TTL/использован).
            EmailCodeTooManyAttemptsError: попытки исчерпаны, код инвалидирован.
            EmailCodeInvalidError: код не совпал (details.remaining_attempts).
            ServiceUnavailableError: Redis недоступен.
        """
        settings = self.settings
        pending_key = f"{PENDING_KEY_PREFIX}{pending_token}"
        try:
            raw = await self.redis.get(pending_key)
        except RedisError as exc:
            logger.error(f"Хранилище email-кодов недоступно: {exc}")
            raise ServiceUnavailableError() from exc
        if raw is None:
            raise EmailCodeExpiredError()

        try:
            data = json.loads(raw)
            user_id = UUID(data["user_id"])
            attempts = int(data["attempts"])
            stored_code = str(data["code"])
        except (ValueError, KeyError, TypeError) as exc:
            logger.error(f"Повреждённая pending-запись email-кода {pending_token}: {exc}")
            raise EmailCodeExpiredError() from exc

        user_key = f"{USER_KEY_PREFIX}{user_id}"
        max_attempts = settings.max_attempts

        if attempts >= max_attempts:
            await self._delete_keys(pending_key, user_key)
            raise EmailCodeTooManyAttemptsError()

        if not secrets.compare_digest(stored_code, code):
            attempts += 1
            if attempts >= max_attempts:
                await self._delete_keys(pending_key, user_key)
                raise EmailCodeTooManyAttemptsError()
            data["attempts"] = attempts
            try:
                ttl = await self.redis.ttl(pending_key)
                await self.redis.set(
                    pending_key,
                    json.dumps(data),
                    ex=ttl if ttl > 0 else None,
                )
            except RedisError as exc:
                logger.error(f"Хранилище email-кодов недоступно: {exc}")
                raise ServiceUnavailableError() from exc
            raise EmailCodeInvalidError(details={"remaining_attempts": max_attempts - attempts})

        await self._delete_keys(pending_key, user_key)
        return EmailLinkVerifiedCode(user_id=user_id, payload=data)

    async def _delete_keys(self, pending_key: str, user_key: str) -> None:
        try:
            await self.redis.delete(pending_key, user_key)
        except RedisError:
            logger.warning(f"Не удалось удалить ключи email-кода {pending_key}")
