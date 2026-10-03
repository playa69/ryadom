"""Репозиторий согласий пользователя (specs/auth «Согласия»)."""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.consent import Consent, ConsentKind


class ConsentRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def upsert(self, *, user_id: UUID, kind: str, version: str) -> Consent:
        stmt = (
            select(Consent)
            .where(Consent.user_id == user_id, Consent.kind == kind)
            .limit(1)
        )
        result = await self.session.execute(stmt)
        consent = result.scalar_one_or_none()
        if consent is None:
            consent = Consent(user_id=user_id, kind=kind, version=version)
        else:
            consent.version = version
            consent.accepted_at = datetime.now(UTC)
        self.session.add(consent)
        await self.session.flush()
        return consent

    async def get_kinds(self, user_id: UUID) -> set[str]:
        stmt = select(Consent.kind).where(Consent.user_id == user_id)
        result = await self.session.execute(stmt)
        return set(result.scalars().all())

    async def has_all_required(self, user_id: UUID) -> bool:
        kinds = await self.get_kinds(user_id)
        return all(kind in kinds for kind in ConsentKind.ALL)
