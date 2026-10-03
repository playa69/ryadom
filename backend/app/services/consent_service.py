"""Фиксация согласий (specs/auth «Согласия и подтверждение возраста»)."""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from app.core import metrics
from app.models.consent import ConsentKind
from app.models.user import User
from app.repositories.audit_log_repository import AuditLogRepository
from app.repositories.consent_repository import ConsentRepository
from app.schemas.auth import ConsentsRequest, ConsentsResponse
from app.services.anti_spam_service import RequestSecurityContext
from app.services.exceptions import AgeRestrictedError, ConsentRequiredError


class ConsentService:
    def __init__(
        self,
        *,
        session: AsyncSession,
        consent_repository: ConsentRepository,
        audit_log_repository: AuditLogRepository,
    ) -> None:
        self.session = session
        self.consent_repository = consent_repository
        self.audit_log_repository = audit_log_repository

    async def accept_consents(
        self,
        user: User,
        payload: ConsentsRequest,
        *,
        context: RequestSecurityContext,
    ) -> ConsentsResponse:
        if not payload.age_confirmed:
            # 403 AGE_RESTRICTED, согласия не фиксируются.
            raise AgeRestrictedError()
        if not payload.disclaimer_accepted or not payload.offer_accepted:
            raise ConsentRequiredError(
                "Для использования сервиса нужно принять дисклеймер и оферту."
            )

        await self.consent_repository.upsert(
            user_id=user.id, kind=ConsentKind.AGE_CONFIRMATION, version="1"
        )
        await self.consent_repository.upsert(
            user_id=user.id, kind=ConsentKind.DISCLAIMER, version="1"
        )
        await self.consent_repository.upsert(
            user_id=user.id, kind=ConsentKind.OFFER, version=payload.offer_version
        )
        await self.audit_log_repository.create(
            action="auth.consents.accepted",
            entity_type="user",
            entity_id=str(user.id),
            actor_user_id=user.id,
            ip=context.ip_address,
            user_agent=context.user_agent,
            payload={"offer_version": payload.offer_version},
        )
        await self.session.commit()
        metrics.AUTH_LOGIN_TOTAL.labels(flow="consents", result="accepted").inc()

        return ConsentsResponse(consents_completed=True, accepted_at=datetime.now(UTC))
