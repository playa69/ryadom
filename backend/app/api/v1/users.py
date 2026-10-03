"""Роутер users (операции docs/openapi.yaml, тег users)."""

from typing import Annotated

from fastapi import APIRouter, Depends

from app.api.deps import (
    get_consent_service,
    get_current_user,
    get_request_security_context,
)
from app.models.user import User
from app.schemas.auth import ConsentsRequest, ConsentsResponse
from app.services.anti_spam_service import RequestSecurityContext
from app.services.consent_service import ConsentService

router = APIRouter(prefix="/users", tags=["users"])


@router.post("/me/consents", operation_id="acceptConsents")
async def accept_consents(
    payload: ConsentsRequest,
    context: Annotated[RequestSecurityContext, Depends(get_request_security_context)],
    current_user: Annotated[User, Depends(get_current_user)],
    consent_service: Annotated[ConsentService, Depends(get_consent_service)],
) -> ConsentsResponse:
    return await consent_service.accept_consents(current_user, payload, context=context)
