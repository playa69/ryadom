"""Криптография и токены (перенос UnionApp app/core/security.py, design.md D1).

JWT HS256 с TTL 15 мин (claims sub/type=access/iat/exp, без claim login,
без jti), opaque refresh 48 байт энтропии, reset-токен 32 байта,
argon2id для паролей и ключей устройств, SHA-256 хэши токенов.
"""

from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from typing import Any, Mapping
from uuid import uuid4

import jwt
from pwdlib import PasswordHash
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.core.config import APP_CONFIG

password_hasher = PasswordHash.recommended()
REFRESH_TOKEN_BYTES = 48
PASSWORD_RESET_TOKEN_BYTES = 32


class JWTTokenType(StrEnum):
    ACCESS = "access"


@dataclass(frozen=True, slots=True)
class IssuedToken:
    token: str
    expires_at: datetime
    expires_in: int


class JWTPayload(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="allow")

    sub: str = Field(min_length=1)
    exp: datetime
    iat: datetime
    token_type: JWTTokenType = Field(alias="type")


class TokenValidationError(ValueError):
    """Токен не прошёл проверку подлинности."""


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _build_expiration(
    issued_at: datetime,
    default_ttl: timedelta,
    expires_delta: timedelta | None = None,
) -> tuple[datetime, int]:
    ttl = expires_delta or default_ttl
    expires_at = issued_at + ttl
    return expires_at, int(ttl.total_seconds())


def hash_password(password: str) -> str:
    return password_hasher.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    return password_hasher.verify(password, password_hash)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def create_access_token(
    subject: str,
    expires_delta: timedelta | None = None,
    additional_claims: Mapping[str, Any] | None = None,
) -> IssuedToken:
    settings = APP_CONFIG.jwt
    issued_at = _utc_now()
    expires_at, expires_in = _build_expiration(
        issued_at,
        timedelta(minutes=settings.access_token_expire_minutes),
        expires_delta=expires_delta,
    )

    payload: dict[str, Any] = {
        "sub": subject,
        "type": JWTTokenType.ACCESS.value,
        # jti: без него два access-токена одного пользователя, выпущенные
        # в пределах одной секунды, побайтово совпадают (iat/exp — секунды).
        "jti": uuid4().hex,
        "iat": issued_at,
        "exp": expires_at,
    }
    if additional_claims:
        payload.update(additional_claims)

    token = jwt.encode(
        payload,
        settings.secret_key.get_secret_value(),
        algorithm=settings.algorithm,
    )
    return IssuedToken(token=token, expires_at=expires_at, expires_in=expires_in)


def create_refresh_token(expires_delta: timedelta | None = None) -> IssuedToken:
    settings = APP_CONFIG.jwt
    issued_at = _utc_now()
    expires_at, expires_in = _build_expiration(
        issued_at,
        timedelta(days=settings.refresh_token_expire_days),
        expires_delta=expires_delta,
    )
    token = secrets.token_urlsafe(REFRESH_TOKEN_BYTES)
    return IssuedToken(token=token, expires_at=expires_at, expires_in=expires_in)


def create_password_reset_token(expires_delta: timedelta | None = None) -> IssuedToken:
    settings = APP_CONFIG.jwt
    issued_at = _utc_now()
    expires_at, expires_in = _build_expiration(
        issued_at,
        timedelta(minutes=settings.password_reset_token_expire_minutes),
        expires_delta=expires_delta,
    )
    token = secrets.token_urlsafe(PASSWORD_RESET_TOKEN_BYTES)
    return IssuedToken(token=token, expires_at=expires_at, expires_in=expires_in)


def decode_and_validate_jwt(
    token: str,
    expected_type: JWTTokenType = JWTTokenType.ACCESS,
) -> JWTPayload:
    settings = APP_CONFIG.jwt
    try:
        payload = jwt.decode(
            token,
            settings.secret_key.get_secret_value(),
            algorithms=[settings.algorithm],
            options={"require": ["exp", "sub", "type"]},
        )
    except jwt.ExpiredSignatureError as exc:
        raise TokenValidationError("Token has expired.") from exc
    except jwt.InvalidTokenError as exc:
        raise TokenValidationError("Token is invalid.") from exc

    try:
        validated_payload = JWTPayload.model_validate(payload)
    except ValidationError as exc:
        raise TokenValidationError("Token payload is invalid.") from exc

    if validated_payload.token_type != expected_type:
        raise TokenValidationError(f"Unexpected token type: expected '{expected_type.value}'.")

    return validated_payload
