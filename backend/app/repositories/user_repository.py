"""Репозитории пользователей и способов входа (design.md D2)."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.auth_identity import AuthIdentity
from app.models.device import Device
from app.models.user import User


class AuthIdentityRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get_by_kind_identifier(self, kind: str, identifier: str) -> AuthIdentity | None:
        stmt = (
            select(AuthIdentity)
            .where(AuthIdentity.kind == kind, AuthIdentity.identifier == identifier)
            .limit(1)
        )
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def get_for_user(self, user_id: uuid.UUID, kind: str) -> AuthIdentity | None:
        stmt = (
            select(AuthIdentity)
            .where(AuthIdentity.user_id == user_id, AuthIdentity.kind == kind)
            .limit(1)
        )
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def create(
        self,
        *,
        user_id: uuid.UUID,
        kind: str,
        identifier: str,
        secret_hash: str,
    ) -> AuthIdentity:
        identity = AuthIdentity(
            user_id=user_id,
            kind=kind,
            identifier=identifier,
            secret_hash=secret_hash,
        )
        self.session.add(identity)
        await self.session.flush()
        return identity

    async def update_secret_hash(self, identity: AuthIdentity, secret_hash: str) -> AuthIdentity:
        identity.secret_hash = secret_hash
        self.session.add(identity)
        await self.session.flush()
        return identity


class UserRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get_by_id(self, user_id: uuid.UUID) -> User | None:
        stmt = select(User).where(User.id == user_id).limit(1)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def get_by_identity(self, kind: str, identifier: str) -> User | None:
        stmt = (
            select(User)
            .join(AuthIdentity, AuthIdentity.user_id == User.id)
            .where(AuthIdentity.kind == kind, AuthIdentity.identifier == identifier)
            .limit(1)
        )
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def create_with_identity(
        self,
        *,
        kind: str,
        identifier: str,
        secret_hash: str,
        display_name: str | None = None,
    ) -> User:
        user = User(display_name=display_name)
        user.identities.append(
            AuthIdentity(kind=kind, identifier=identifier, secret_hash=secret_hash)
        )
        self.session.add(user)
        await self.session.flush()
        return user

    async def upsert_device(
        self,
        *,
        user_id: uuid.UUID,
        device_id: str,
        platform: str | None = None,
        app_version: str | None = None,
    ) -> Device:
        stmt = (
            select(Device)
            .where(Device.user_id == user_id, Device.device_id == device_id)
            .limit(1)
        )
        result = await self.session.execute(stmt)
        device = result.scalar_one_or_none()
        now = datetime.now(UTC)
        if device is None:
            device = Device(
                user_id=user_id,
                device_id=device_id,
                platform=platform,
                app_version=app_version,
                last_seen_at=now,
            )
        else:
            device.last_seen_at = now
            if platform is not None:
                device.platform = platform
            if app_version is not None:
                device.app_version = app_version
        self.session.add(device)
        await self.session.flush()
        return device
