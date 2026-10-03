"""Роутер auth (8 операций docs/openapi.yaml, тег auth)."""

from typing import Annotated

from fastapi import APIRouter, Depends

from app.api.deps import (
    get_auth_service,
    get_current_user,
    get_email_link_auth_service,
    get_request_security_context,
)
from app.models.user import User
from app.schemas.auth import (
    AuthResponse,
    DeviceLoginRequest,
    EmailLinkConfirmRequest,
    EmailLinkConfirmResponse,
    EmailLinkPendingResponse,
    EmailLinkRequest,
    EmailLoginRequest,
    MessageResponse,
    PasswordResetConfirmRequest,
    PasswordResetRequest,
    RefreshRequest,
    TokenPair,
)
from app.services.anti_spam_service import RequestSecurityContext
from app.services.auth_service import AuthService

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/device", operation_id="deviceLogin")
async def device_login(
    payload: DeviceLoginRequest,
    context: Annotated[RequestSecurityContext, Depends(get_request_security_context)],
    auth_service: Annotated[AuthService, Depends(get_auth_service)],
) -> AuthResponse:
    return await auth_service.device_login(payload, context=context)


@router.post("/email/link", operation_id="linkEmail")
async def link_email(
    payload: EmailLinkRequest,
    context: Annotated[RequestSecurityContext, Depends(get_request_security_context)],
    current_user: Annotated[User, Depends(get_current_user)],
    auth_service: Annotated[AuthService, Depends(get_email_link_auth_service)],
) -> EmailLinkPendingResponse:
    return await auth_service.link_email(current_user, payload, context=context)


@router.post("/email/link/confirm", operation_id="confirmEmailLink")
async def confirm_email_link(
    payload: EmailLinkConfirmRequest,
    context: Annotated[RequestSecurityContext, Depends(get_request_security_context)],
    current_user: Annotated[User, Depends(get_current_user)],
    auth_service: Annotated[AuthService, Depends(get_email_link_auth_service)],
) -> EmailLinkConfirmResponse:
    return await auth_service.confirm_email_link(current_user, payload, context=context)


@router.post("/email/login", operation_id="emailLogin")
async def email_login(
    payload: EmailLoginRequest,
    context: Annotated[RequestSecurityContext, Depends(get_request_security_context)],
    auth_service: Annotated[AuthService, Depends(get_auth_service)],
) -> AuthResponse:
    return await auth_service.email_login(payload, context=context)


@router.post("/refresh", operation_id="refreshTokens")
async def refresh_tokens(
    payload: RefreshRequest,
    context: Annotated[RequestSecurityContext, Depends(get_request_security_context)],
    auth_service: Annotated[AuthService, Depends(get_auth_service)],
) -> TokenPair:
    return await auth_service.refresh(payload, context=context)


@router.post("/logout", operation_id="logout")
async def logout(
    payload: RefreshRequest,
    context: Annotated[RequestSecurityContext, Depends(get_request_security_context)],
    current_user: Annotated[User, Depends(get_current_user)],
    auth_service: Annotated[AuthService, Depends(get_auth_service)],
) -> MessageResponse:
    return await auth_service.logout(payload, context=context)


@router.post("/password-reset/request", operation_id="requestPasswordReset")
async def request_password_reset(
    payload: PasswordResetRequest,
    context: Annotated[RequestSecurityContext, Depends(get_request_security_context)],
    auth_service: Annotated[AuthService, Depends(get_auth_service)],
) -> MessageResponse:
    return await auth_service.request_password_reset(payload, context=context)


@router.post("/password-reset/confirm", operation_id="confirmPasswordReset")
async def confirm_password_reset(
    payload: PasswordResetConfirmRequest,
    context: Annotated[RequestSecurityContext, Depends(get_request_security_context)],
    auth_service: Annotated[AuthService, Depends(get_auth_service)],
) -> MessageResponse:
    return await auth_service.confirm_password_reset(payload, context=context)
