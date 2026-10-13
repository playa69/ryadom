"""Репозиторий security-аудита (specs/auth «Security-аудит auth-событий»)."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.audit_log import AuditLog


class AuditLogRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def create(
        self,
        *,
        action: str,
        entity_type: str,
        entity_id: str | None = None,
        actor_user_id: UUID | None = None,
        ip: str | None = None,
        user_agent: str | None = None,
        payload: dict[str, Any] | None = None,
    ) -> AuditLog:
        audit_log = AuditLog(
            actor_user_id=actor_user_id,
            action=action,
            entity_type=entity_type,
            entity_id=entity_id,
            ip=ip,
            user_agent=user_agent,
            payload=payload,
        )
        self.session.add(audit_log)
        await self.session.flush()
        return audit_log

    async def count_recent(
        self,
        *,
        actions: Sequence[str],
        entity_type: str,
        entity_id: str,
        since: datetime,
    ) -> int:
        stmt = select(func.count(AuditLog.id)).where(
            AuditLog.action.in_(tuple(actions)),
            AuditLog.entity_type == entity_type,
            AuditLog.entity_id == entity_id,
            AuditLog.created_at >= since,
        )
        result = await self.session.execute(stmt)
        return int(result.scalar_one())

    async def get_last_event_at(
        self,
        *,
        actions: Sequence[str],
        entity_type: str,
        entity_id: str,
        since: datetime,
    ) -> datetime | None:
        stmt = (
            select(AuditLog.created_at)
            .where(
                AuditLog.action.in_(tuple(actions)),
                AuditLog.entity_type == entity_type,
                AuditLog.entity_id == entity_id,
                AuditLog.created_at >= since,
            )
            .order_by(desc(AuditLog.created_at))
            .limit(1)
        )
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()
