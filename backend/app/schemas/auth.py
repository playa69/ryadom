"""Pydantic-схемы auth + consents (1:1 docs/openapi.yaml)."""

from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import EmailStr, Field, SecretStr

from app.schemas.base import APIModel


class MessageResponse(APIModel):
    message: str


class DeviceLoginRequest(APIModel):
    device_id: UUID
    device_key: SecretStr
    platform: Literal["ios", "android"] | None = None
    app_version: str | None = None


class EmailLinkRequest(APIModel):
    email: EmailStr
    password: SecretStr = Field(min_length=8)


class EmailLinkPendingResponse(APIModel):
    pending_token: UUID
    expires_in: int
    email_masked: str


class EmailLinkConfirmRequest(APIModel):
    pending_token: UUID
    code: str = Field(pattern=r"^[0-9]{6}$")


class UserFlags(APIModel):
    id: UUID
    is_anonymous: bool
    has_email: bool
    age_confirmed: bool = False
    consents_completed: bool = False


class EmailLinkConfirmResponse(APIModel):
    user: UserFlags


class EmailLoginRequest(APIModel):
    email: EmailStr
    password: SecretStr
    device_id: UUID
    device_key: SecretStr | None = None
    platform: Literal["ios", "android"] | None = None
    app_version: str | None = None


class RefreshRequest(APIModel):
    refresh_token: SecretStr


class PasswordResetRequest(APIModel):
    email: EmailStr


class PasswordResetConfirmRequest(APIModel):
    token: SecretStr
    new_password: SecretStr = Field(min_length=8)


class TokenPair(APIModel):
    access_token: str
    token_type: Literal["bearer"] = "bearer"
    expires_in: int
    refresh_token: str
    refresh_expires_in: int


class AuthResponse(TokenPair):
    user: UserFlags
    is_new_user: bool


class ConsentsRequest(APIModel):
    age_confirmed: bool
    disclaimer_accepted: bool
    offer_accepted: bool
    offer_version: str


class ConsentsResponse(APIModel):
    consents_completed: bool
    accepted_at: datetime
