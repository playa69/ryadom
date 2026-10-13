"""Сервис аутентификации (specs/auth, design.md D1–D5).

Device-вход (идемпотентный), email-вход (anti-enumeration), ротация
refresh с family-revoke (grace-окно 10 сек), выход, привязка email по коду,
сброс пароля без раскрытия аккаунта. Security-аудит всех событий +
Prometheus-метрики без PII.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from loguru import logger
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import metrics
from app.core.config import APP_CONFIG
from app.core.security import (
    create_access_token,
    create_password_reset_token,
    create_refresh_token,
    hash_password,
    hash_token,
    verify_password,
)
from app.models.consent import ConsentKind
from app.models.refresh_token import RefreshToken
from app.models.user import User
from app.repositories.audit_log_repository import AuditLogRepository
from app.repositories.auth_repository import AuthRepository
from app.repositories.consent_repository import ConsentRepository
from app.repositories.user_repository import AuthIdentityRepository, UserRepository
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
    UserFlags,
)
from app.services.anti_spam_service import (
    AntiSpamService,
    RequestSecurityContext,
    build_contact_handles,
    normalize_email,
)
from app.services.email_code_service import EmailLinkCodeService
from app.services.email_sender import EmailSender
from app.services.exceptions import (
    EmailAlreadyLinkedError,
    InvalidCredentialsError,
    InvalidRefreshTokenError,
    InvalidResetTokenError,
    RateLimitExceededError,
    ServiceUnavailableError,
)

_PASSWORD_RESET_NEUTRAL_MESSAGE = "Если аккаунт с таким email существует, мы отправили письмо со ссылкой для сброса пароля."


class AuthService:
    def __init__(
        self,
        *,
        session: AsyncSession,
        user_repository: UserRepository,
        identity_repository: AuthIdentityRepository,
        auth_repository: AuthRepository,
        consent_repository: ConsentRepository,
        audit_log_repository: AuditLogRepository,
        anti_spam_service: AntiSpamService,
        email_sender: EmailSender,
        email_code_service: EmailLinkCodeService | None = None,
    ) -> None:
        self.session = session
        self.user_repository = user_repository
        self.identity_repository = identity_repository
        self.auth_repository = auth_repository
        self.consent_repository = consent_repository
        self.audit_log_repository = audit_log_repository
        self.anti_spam_service = anti_spam_service
        self.email_sender = email_sender
        self.email_code_service = email_code_service

    # ------------------------------------------------------------------
    # Вход по устройству (specs/auth «Анонимный вход по устройству»)
    # ------------------------------------------------------------------

    async def device_login(
        self,
        payload: DeviceLoginRequest,
        *,
        context: RequestSecurityContext,
    ) -> AuthResponse:
        decision = await self.anti_spam_service.evaluate_device_login(context=context)
        if not decision.allowed:
            await self._record_rate_limited(
                action="auth.device_login.rate_limited",
                context=context,
                retry_after_seconds=decision.retry_after_seconds,
            )
            metrics.AUTH_RATE_LIMITED_TOTAL.labels(action="device_login").inc()
            raise RateLimitExceededError(
                retry_after_seconds=decision.retry_after_seconds
            )

        device_id = str(payload.device_id)
        device_key = payload.device_key.get_secret_value()
        identity = await self.identity_repository.get_by_kind_identifier(
            "device", device_id
        )

        is_new_user = False
        if identity is not None:
            if not verify_password(device_key, identity.secret_hash):
                await self._record_audit_event(
                    action="auth.device_login.failed",
                    entity_type="device",
                    entity_id=device_id,
                    context=context,
                    extra_payload={"reason": "invalid_device_key"},
                )
                await self.session.commit()
                metrics.AUTH_LOGIN_TOTAL.labels(
                    flow="device", result="invalid_credentials"
                ).inc()
                raise InvalidCredentialsError()
            user = await self.user_repository.get_by_id(identity.user_id)
            if user is None or not user.is_active:
                await self.session.commit()
                metrics.AUTH_LOGIN_TOTAL.labels(
                    flow="device", result="invalid_credentials"
                ).inc()
                raise InvalidCredentialsError()
        else:
            user = await self.user_repository.create_with_identity(
                kind="device",
                identifier=device_id,
                secret_hash=hash_password(device_key),
            )
            is_new_user = True

        await self.user_repository.upsert_device(
            user_id=user.id,
            device_id=device_id,
            platform=payload.platform,
            app_version=payload.app_version,
        )
        token_pair = await self._issue_token_pair(user, device_id=device_id)
        await self._record_audit_event(
            action="auth.device_login.succeeded",
            entity_type="user",
            entity_id=str(user.id),
            actor_user_id=user.id,
            context=context,
            extra_payload={"is_new_user": is_new_user},
        )
        await self.session.commit()
        metrics.AUTH_LOGIN_TOTAL.labels(flow="device", result="success").inc()

        return AuthResponse(
            **token_pair.model_dump(),
            user=await self._build_user_flags(user),
            is_new_user=is_new_user,
        )

    # ------------------------------------------------------------------
    # Вход по email (specs/auth «Вход по email и паролю»)
    # ------------------------------------------------------------------

    async def email_login(
        self,
        payload: EmailLoginRequest,
        *,
        context: RequestSecurityContext,
    ) -> AuthResponse:
        decision = await self.anti_spam_service.evaluate_email_login(context=context)
        if not decision.allowed:
            await self._record_rate_limited(
                action="auth.email_login.rate_limited",
                context=context,
                retry_after_seconds=decision.retry_after_seconds,
            )
            metrics.AUTH_RATE_LIMITED_TOTAL.labels(action="email_login").inc()
            raise RateLimitExceededError(
                retry_after_seconds=decision.retry_after_seconds
            )

        normalized_email = normalize_email(payload.email) or ""
        contact_handles = build_contact_handles(email=normalized_email)
        identity = await self.identity_repository.get_by_kind_identifier(
            "email", normalized_email
        )

        user: User | None = None
        if identity is not None and verify_password(
            payload.password.get_secret_value(), identity.secret_hash
        ):
            candidate = await self.user_repository.get_by_id(identity.user_id)
            if candidate is not None and candidate.is_active:
                user = candidate

        if user is None:
            # Anti-enumeration: одинаковый ответ для нет email/неверный пароль.
            await self._record_audit_event(
                action="auth.email_login.failed",
                entity_type="contact",
                entity_id=contact_handles[0].entity_id if contact_handles else None,
                context=context,
                extra_payload={
                    "email_masked": contact_handles[0].masked_value
                    if contact_handles
                    else None,
                },
            )
            await self.session.commit()
            metrics.AUTH_LOGIN_TOTAL.labels(
                flow="email", result="invalid_credentials"
            ).inc()
            raise InvalidCredentialsError()

        device_id = str(payload.device_id)
        await self.user_repository.upsert_device(
            user_id=user.id,
            device_id=device_id,
            platform=payload.platform,
            app_version=payload.app_version,
        )
        token_pair = await self._issue_token_pair(user, device_id=device_id)
        await self._record_audit_event(
            action="auth.email_login.succeeded",
            entity_type="user",
            entity_id=str(user.id),
            actor_user_id=user.id,
            context=context,
            extra_payload={
                "email_masked": contact_handles[0].masked_value
                if contact_handles
                else None,
            },
        )
        await self.session.commit()
        metrics.AUTH_LOGIN_TOTAL.labels(flow="email", result="success").inc()

        return AuthResponse(
            **token_pair.model_dump(),
            user=await self._build_user_flags(user),
            is_new_user=False,
        )

    # ------------------------------------------------------------------
    # Ротация refresh (specs/auth «Ротация refresh-токенов»)
    # ------------------------------------------------------------------

    async def refresh(
        self,
        payload: RefreshRequest,
        *,
        context: RequestSecurityContext,
    ) -> TokenPair:
        token_hash = hash_token(payload.refresh_token.get_secret_value())
        current_refresh_token = await self.auth_repository.get_active_refresh_token(
            token_hash
        )

        if current_refresh_token is not None:
            user = await self.user_repository.get_by_id(current_refresh_token.user_id)
            if user is None or not user.is_active:
                metrics.AUTH_REFRESH_TOTAL.labels(result="invalid").inc()
                raise InvalidRefreshTokenError()
            metrics.AUTH_REFRESH_TOTAL.labels(result="rotated").inc()
            return await self._issue_rotated_tokens(
                user, current_refresh_token, revoke=True
            )

        revoked_token = await self.auth_repository.get_refresh_token_by_hash(token_hash)
        if revoked_token is not None and revoked_token.revoked_at is not None:
            grace_seconds = APP_CONFIG.jwt.refresh_token_rotation_grace_seconds
            now = datetime.now(UTC)
            within_grace = (
                grace_seconds > 0
                and (now - revoked_token.revoked_at).total_seconds() <= grace_seconds
                and revoked_token.expires_at > now
            )
            if within_grace:
                user = await self.user_repository.get_by_id(revoked_token.user_id)
                if user is not None and user.is_active:
                    logger.warning(
                        f"Повторное использование refresh-токена в grace-окне. user_id={user.id}"
                    )
                    metrics.AUTH_REFRESH_TOTAL.labels(result="grace_rotation").inc()
                    return await self._issue_rotated_tokens(
                        user, revoked_token, revoke=False
                    )
            else:
                # Replay вне grace-окна — компрометация: отзыв всего семейства.
                logger.warning(
                    "Replay refresh-токена вне grace-окна; "
                    f"отзыв всех токенов пользователя {revoked_token.user_id}"
                )
                await self.auth_repository.revoke_refresh_tokens_for_user(
                    revoked_token.user_id
                )
                await self._record_audit_event(
                    action="auth.refresh.family_revoke",
                    entity_type="user",
                    entity_id=str(revoked_token.user_id),
                    actor_user_id=revoked_token.user_id,
                    context=context,
                )
                await self.session.commit()
                metrics.AUTH_FAMILY_REVOKE_TOTAL.inc()
                metrics.AUTH_REFRESH_TOTAL.labels(result="family_revoke").inc()

        metrics.AUTH_REFRESH_TOTAL.labels(result="invalid").inc()
        raise InvalidRefreshTokenError()

    # ------------------------------------------------------------------
    # Выход (specs/auth «Выход») — идемпотентный
    # ------------------------------------------------------------------

    async def logout(
        self,
        payload: RefreshRequest,
        *,
        context: RequestSecurityContext,
    ) -> MessageResponse:
        refresh_token = await self.auth_repository.get_active_refresh_token(
            hash_token(payload.refresh_token.get_secret_value())
        )
        if refresh_token is not None:
            await self.auth_repository.revoke_refresh_token(refresh_token)
            await self._record_audit_event(
                action="auth.logout",
                entity_type="user",
                entity_id=str(refresh_token.user_id),
                actor_user_id=refresh_token.user_id,
                context=context,
            )
            await self.session.commit()
        return MessageResponse(message="Выход выполнен.")

    # ------------------------------------------------------------------
    # Привязка email (specs/auth «Привязка email с подтверждением кодом»)
    # ------------------------------------------------------------------

    async def link_email(
        self,
        user: User,
        payload: EmailLinkRequest,
        *,
        context: RequestSecurityContext,
    ) -> EmailLinkPendingResponse:
        if self.email_code_service is None:
            raise ServiceUnavailableError()

        normalized_email = normalize_email(payload.email) or ""
        contact_handles = build_contact_handles(email=normalized_email)
        decision = await self.anti_spam_service.evaluate_email_link(
            context=context,
            contact_handles=contact_handles,
        )
        if not decision.allowed:
            await self._record_rate_limited(
                action="auth.email_link.rate_limited",
                context=context,
                retry_after_seconds=decision.retry_after_seconds,
            )
            metrics.AUTH_RATE_LIMITED_TOTAL.labels(action="email_link").inc()
            raise RateLimitExceededError(
                retry_after_seconds=decision.retry_after_seconds
            )

        existing = await self.identity_repository.get_by_kind_identifier(
            "email", normalized_email
        )
        if existing is not None and existing.user_id != user.id:
            metrics.AUTH_EMAIL_LINK_TOTAL.labels(
                stage="request", result="already_linked"
            ).inc()
            raise EmailAlreadyLinkedError()

        pending = await self.email_code_service.start(
            user_id=user.id,
            email=normalized_email,
            rate_limit_key=str(user.id),
            send_rate_limit=APP_CONFIG.security.email_link_rate_limit,
            send_rate_window_seconds=APP_CONFIG.security.email_link_rate_limit_window_seconds,
            extra_payload={
                "email": normalized_email,
                "password_hash": hash_password(payload.password.get_secret_value()),
            },
        )
        await self._record_audit_event(
            action="auth.email_link.requested",
            entity_type="user",
            entity_id=str(user.id),
            actor_user_id=user.id,
            context=context,
            extra_payload={
                "email_masked": contact_handles[0].masked_value
                if contact_handles
                else None,
            },
        )
        await self.session.commit()
        metrics.AUTH_EMAIL_LINK_TOTAL.labels(stage="request", result="sent").inc()

        return EmailLinkPendingResponse(
            pending_token=pending.pending_token,
            expires_in=pending.expires_in_seconds,
            email_masked=pending.email_masked,
        )

    async def confirm_email_link(
        self,
        user: User,
        payload: EmailLinkConfirmRequest,
        *,
        context: RequestSecurityContext,
    ) -> EmailLinkConfirmResponse:
        if self.email_code_service is None:
            raise ServiceUnavailableError()

        verified = await self.email_code_service.verify_code(
            pending_token=payload.pending_token,
            code=payload.code,
        )
        email = str(verified.payload["email"])
        password_hash = str(verified.payload["password_hash"])

        existing = await self.identity_repository.get_by_kind_identifier("email", email)
        if existing is not None and existing.user_id != user.id:
            metrics.AUTH_EMAIL_LINK_TOTAL.labels(
                stage="confirm", result="already_linked"
            ).inc()
            raise EmailAlreadyLinkedError()

        own_identity = await self.identity_repository.get_for_user(user.id, "email")
        if own_identity is not None:
            await self.identity_repository.update_secret_hash(
                own_identity, password_hash
            )
        else:
            await self.identity_repository.create(
                user_id=user.id,
                kind="email",
                identifier=email,
                secret_hash=password_hash,
            )

        await self._record_audit_event(
            action="auth.email_link.succeeded",
            entity_type="user",
            entity_id=str(user.id),
            actor_user_id=user.id,
            context=context,
        )
        await self.session.commit()
        metrics.AUTH_EMAIL_LINK_TOTAL.labels(stage="confirm", result="success").inc()

        return EmailLinkConfirmResponse(user=await self._build_user_flags(user))

    # ------------------------------------------------------------------
    # Сброс пароля (specs/auth «Сброс пароля без раскрытия аккаунта»)
    # ------------------------------------------------------------------

    async def request_password_reset(
        self,
        payload: PasswordResetRequest,
        *,
        context: RequestSecurityContext,
    ) -> MessageResponse:
        normalized_email = normalize_email(payload.email) or ""
        contact_handles = build_contact_handles(email=normalized_email)
        decision = await self.anti_spam_service.evaluate_password_reset(
            context=context,
            contact_handles=contact_handles,
        )
        if not decision.allowed:
            await self._record_rate_limited(
                action="auth.password_reset.rate_limited",
                context=context,
                retry_after_seconds=decision.retry_after_seconds,
            )
            metrics.AUTH_RATE_LIMITED_TOTAL.labels(action="password_reset").inc()
            # Тело — то же нейтральное сообщение: не раскрываем существование email.
            raise RateLimitExceededError(
                _PASSWORD_RESET_NEUTRAL_MESSAGE,
                retry_after_seconds=decision.retry_after_seconds,
            )

        # Cooldown записывается даже для несуществующего адреса.
        await self.anti_spam_service.record_password_reset_request(
            contact_handles=contact_handles
        )

        identity = await self.identity_repository.get_by_kind_identifier(
            "email", normalized_email
        )
        user: User | None = None
        if identity is not None:
            candidate = await self.user_repository.get_by_id(identity.user_id)
            if candidate is not None and candidate.is_active:
                user = candidate

        if user is not None:
            await self.auth_repository.invalidate_active_password_reset_tokens(user.id)
            issued = create_password_reset_token()
            await self.auth_repository.create_password_reset_token(
                user_id=user.id,
                token_hash=hash_token(issued.token),
                expires_at=issued.expires_at,
            )
            try:
                # Письмо отправляется до коммита: сбой отправки — откат транзакции.
                await self.email_sender.send_password_reset(
                    email=normalized_email,
                    reset_token=issued.token,
                    expires_at=issued.expires_at,
                )
            except Exception as exc:
                await self.session.rollback()
                logger.error(f"Отправка письма сброса пароля не удалась: {exc}")
                metrics.AUTH_PASSWORD_RESET_REQUESTS_TOTAL.labels(
                    result="send_failed"
                ).inc()
                raise ServiceUnavailableError(
                    "Не удалось отправить письмо. Попробуйте позже."
                ) from exc
            await self._record_audit_event(
                action="auth.password_reset.requested",
                entity_type="user",
                entity_id=str(user.id),
                actor_user_id=user.id,
                context=context,
                extra_payload={
                    "email_masked": contact_handles[0].masked_value
                    if contact_handles
                    else None,
                },
            )

        await self.session.commit()
        metrics.AUTH_PASSWORD_RESET_REQUESTS_TOTAL.labels(
            result="sent" if user is not None else "not_found"
        ).inc()
        return MessageResponse(message=_PASSWORD_RESET_NEUTRAL_MESSAGE)

    async def confirm_password_reset(
        self,
        payload: PasswordResetConfirmRequest,
        *,
        context: RequestSecurityContext,
    ) -> MessageResponse:
        decision = await self.anti_spam_service.evaluate_password_reset_confirm(
            context=context
        )
        if not decision.allowed:
            await self._record_rate_limited(
                action="auth.password_reset_confirm.rate_limited",
                context=context,
                retry_after_seconds=decision.retry_after_seconds,
            )
            metrics.AUTH_RATE_LIMITED_TOTAL.labels(
                action="password_reset_confirm"
            ).inc()
            raise RateLimitExceededError(
                retry_after_seconds=decision.retry_after_seconds
            )

        reset_token = await self.auth_repository.get_active_password_reset_token(
            hash_token(payload.token.get_secret_value())
        )
        identity = None
        if reset_token is not None:
            identity = await self.identity_repository.get_for_user(
                reset_token.user_id, "email"
            )

        if reset_token is None or identity is None:
            await self._record_audit_event(
                action="auth.password_reset.failed",
                entity_type="ip",
                entity_id=context.ip_address,
                context=context,
                extra_payload={"reason": "invalid_or_expired_token"},
            )
            await self.session.commit()
            raise InvalidResetTokenError()

        await self.identity_repository.update_secret_hash(
            identity, hash_password(payload.new_password.get_secret_value())
        )
        await self.auth_repository.mark_password_reset_token_used(reset_token)
        await self.auth_repository.revoke_refresh_tokens_for_user(reset_token.user_id)
        await self._record_audit_event(
            action="auth.password_reset.succeeded",
            entity_type="user",
            entity_id=str(reset_token.user_id),
            actor_user_id=reset_token.user_id,
            context=context,
        )
        await self.session.commit()

        try:
            await self.email_sender.send_password_changed(email=identity.identifier)
        except Exception as exc:  # noqa: BLE001 — письмо best-effort, пароль уже сменён
            logger.error(f"Отправка уведомления о смене пароля не удалась: {exc}")

        return MessageResponse(message="Пароль обновлён.")

    # ------------------------------------------------------------------
    # Внутренние helpers
    # ------------------------------------------------------------------

    async def _issue_token_pair(
        self, user: User, *, device_id: str | None
    ) -> TokenPair:
        access_token = create_access_token(str(user.id))
        refresh_token = create_refresh_token()
        await self.auth_repository.create_refresh_token(
            user_id=user.id,
            token_hash=hash_token(refresh_token.token),
            expires_at=refresh_token.expires_at,
            device_id=device_id,
        )
        return TokenPair(
            access_token=access_token.token,
            expires_in=access_token.expires_in,
            refresh_token=refresh_token.token,
            refresh_expires_in=refresh_token.expires_in,
        )

    async def _issue_rotated_tokens(
        self,
        user: User,
        current_refresh_token: RefreshToken,
        *,
        revoke: bool = True,
    ) -> TokenPair:
        """Выдаёт новую пару и ротирует текущий refresh (наследуя device_id)."""
        if revoke:
            await self.auth_repository.revoke_refresh_token(current_refresh_token)
        token_pair = await self._issue_token_pair(
            user, device_id=current_refresh_token.device_id
        )
        await self.session.commit()
        return token_pair

    async def _build_user_flags(self, user: User) -> UserFlags:
        email_identity = await self.identity_repository.get_for_user(user.id, "email")
        consent_kinds = await self.consent_repository.get_kinds(user.id)
        return UserFlags(
            id=user.id,
            is_anonymous=email_identity is None,
            has_email=email_identity is not None,
            age_confirmed=ConsentKind.AGE_CONFIRMATION in consent_kinds,
            consents_completed=all(kind in consent_kinds for kind in ConsentKind.ALL),
        )

    async def _record_audit_event(
        self,
        *,
        action: str,
        entity_type: str,
        entity_id: str | None,
        context: RequestSecurityContext,
        actor_user_id: UUID | None = None,
        extra_payload: dict[str, Any] | None = None,
    ) -> None:
        await self.audit_log_repository.create(
            action=action,
            entity_type=entity_type,
            entity_id=entity_id,
            actor_user_id=actor_user_id,
            ip=context.ip_address,
            user_agent=context.user_agent,
            payload=extra_payload,
        )

    async def _record_rate_limited(
        self,
        *,
        action: str,
        context: RequestSecurityContext,
        retry_after_seconds: int | None,
    ) -> None:
        await self._record_audit_event(
            action=action,
            entity_type="ip",
            entity_id=context.ip_address,
            context=context,
            extra_payload={"retry_after_seconds": retry_after_seconds},
        )
        await self.session.commit()
