"""Репозиторий токенов (1:1 UnionApp app/repositories/auth_repository.py)."""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.password_reset_token import PasswordResetToken
from app.models.refresh_token import RefreshToken


class AuthRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def create_refresh_token(
        self,
        *,
        user_id: UUID,
        token_hash: str,
        expires_at: datetime,
        device_id: str | None = None,
    ) -> RefreshToken:
        refresh_token = RefreshToken(
            user_id=user_id,
            token_hash=token_hash,
            device_id=device_id,
            expires_at=expires_at,
        )
        self.session.add(refresh_token)
        await self.session.flush()
        return refresh_token

    async def get_active_refresh_token(self, token_hash: str) -> RefreshToken | None:
        now = datetime.now(UTC)
        stmt = (
            select(RefreshToken)
            .where(
                RefreshToken.token_hash == token_hash,
                RefreshToken.revoked_at.is_(None),
                RefreshToken.expires_at > now,
            )
            .limit(1)
        )
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def get_refresh_token_by_hash(self, token_hash: str) -> RefreshToken | None:
        stmt = (
            select(RefreshToken).where(RefreshToken.token_hash == token_hash).limit(1)
        )
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def revoke_refresh_token(
        self,
        refresh_token: RefreshToken,
        *,
        revoked_at: datetime | None = None,
    ) -> RefreshToken:
        refresh_token.revoked_at = revoked_at or datetime.now(UTC)
        self.session.add(refresh_token)
        await self.session.flush()
        return refresh_token

    async def revoke_refresh_tokens_for_user(self, user_id: UUID) -> None:
        revoked_at = datetime.now(UTC)
        await self.session.execute(
            update(RefreshToken)
            .where(
                RefreshToken.user_id == user_id,
                RefreshToken.revoked_at.is_(None),
            )
            .values(revoked_at=revoked_at)
        )
        await self.session.flush()

    async def create_password_reset_token(
        self,
        *,
        user_id: UUID,
        token_hash: str,
        expires_at: datetime,
    ) -> PasswordResetToken:
        reset_token = PasswordResetToken(
            user_id=user_id,
            token_hash=token_hash,
            expires_at=expires_at,
        )
        self.session.add(reset_token)
        await self.session.flush()
        return reset_token

    async def get_active_password_reset_token(
        self, token_hash: str
    ) -> PasswordResetToken | None:
        now = datetime.now(UTC)
        stmt = (
            select(PasswordResetToken)
            .where(
                PasswordResetToken.token_hash == token_hash,
                PasswordResetToken.used_at.is_(None),
                PasswordResetToken.expires_at > now,
            )
            .limit(1)
        )
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def invalidate_active_password_reset_tokens(self, user_id: UUID) -> None:
        used_at = datetime.now(UTC)
        await self.session.execute(
            update(PasswordResetToken)
            .where(
                PasswordResetToken.user_id == user_id,
                PasswordResetToken.used_at.is_(None),
                PasswordResetToken.expires_at > used_at,
            )
            .values(used_at=used_at)
        )
        await self.session.flush()

    async def mark_password_reset_token_used(
        self,
        reset_token: PasswordResetToken,
    ) -> PasswordResetToken:
        reset_token.used_at = datetime.now(UTC)
        self.session.add(reset_token)
        await self.session.flush()
        return reset_token
