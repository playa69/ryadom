"""DI-фабрики: сервисы, репозитории, security context, текущий пользователь.

Паттерн UnionApp app/api/deps.py (design.md D3): trusted-proxy XFF для
реального IP, fail-closed 503 для auth при недоступном Redis.
"""

from __future__ import annotations

from ipaddress import ip_address, ip_network
from typing import Annotated
from uuid import UUID

from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from loguru import logger
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import APP_CONFIG
from app.core.db import get_db_session
from app.core.redis import get_redis_client
from app.core.security import TokenValidationError, decode_and_validate_jwt
from app.models.user import User
from app.repositories.audit_log_repository import AuditLogRepository
from app.repositories.auth_repository import AuthRepository
from app.repositories.consent_repository import ConsentRepository
from app.repositories.user_repository import AuthIdentityRepository, UserRepository
from app.services.anti_spam_service import AntiSpamService, RequestSecurityContext
from app.services.auth_service import AuthService
from app.services.consent_service import ConsentService
from app.services.email_code_service import EmailLinkCodeService
from app.services.email_sender import EmailSender, LogEmailSender
from app.services.exceptions import (
    ForbiddenError,
    ServiceUnavailableError,
    TokenExpiredError,
    TokenInvalidError,
)
from app.services.rate_limit_service import (
    NoOpRateLimitBackend,
    RateLimitBackend,
    RedisRateLimitBackend,
)

bearer_scheme = HTTPBearer(auto_error=False)

_WWW_AUTH = {"WWW-Authenticate": "Bearer"}


def _is_trusted_proxy(direct_host: str | None, trusted_proxy_ips: list[str]) -> bool:
    """Проверяет, что прямое соединение — от trusted proxy (plain IP или CIDR).

    Битые записи CIDR и невалидный direct_host пропускаются с warning,
    исключений не бросают.
    """
    if not direct_host or not trusted_proxy_ips:
        return False
    try:
        host_ip = ip_address(direct_host)
    except ValueError:
        logger.warning(f"Невалидный IP прямого соединения {direct_host!r}; XFF не доверяем")
        return False
    for entry in trusted_proxy_ips:
        try:
            if "/" in entry:
                if host_ip in ip_network(entry, strict=False):
                    return True
            elif host_ip == ip_address(entry):
                return True
        except ValueError:
            logger.warning(f"Битая запись trusted proxy {entry!r}; пропускаем")
    return False


def get_request_security_context(request: Request) -> RequestSecurityContext:
    """Security-контекст запроса: реальный IP клиента и User-Agent.

    X-Forwarded-For доверяется только от trusted proxy (settings
    TRUSTED_PROXY_IPS, plain IP или CIDR под-сети кластера). При доверенном
    прокси берётся ПОСЛЕДНИЙ адрес цепочки XFF: доверенный edge-прокси
    (istio-ingressgateway/Envoy) всегда дописывает адрес реального TCP-пира
    последним, клиентские подделки оказываются раньше и игнорируются.
    """
    forwarded_for = request.headers.get("x-forwarded-for")
    real_ip = request.headers.get("x-real-ip")
    user_agent = request.headers.get("user-agent")
    direct_host = request.client.host if request.client is not None else None

    is_trusted_proxy = _is_trusted_proxy(direct_host, APP_CONFIG.app.trusted_proxy_ips)

    if is_trusted_proxy and forwarded_for:
        client_ip = forwarded_for.split(",")[-1].strip()
    elif is_trusted_proxy and real_ip:
        client_ip = real_ip.strip()
    elif direct_host:
        client_ip = direct_host
    else:
        client_ip = "unknown"

    normalized_user_agent = user_agent.strip() if user_agent else None
    return RequestSecurityContext(
        ip_address=client_ip or "unknown",
        user_agent=normalized_user_agent,
    )


async def get_rate_limit_backend() -> RateLimitBackend:
    """Fail-open бэкенд для некритичных лимитов (NoOp без Redis)."""
    client = get_redis_client()
    if client is not None:
        return RedisRateLimitBackend(client)
    return NoOpRateLimitBackend()


async def get_auth_rate_limit_backend() -> RateLimitBackend:
    """Fail-closed бэкенд для auth-контуров: без Redis — 503 (design.md D3).

    Лучше отказ, чем перебор без лимитов.
    """
    client = get_redis_client()
    if client is None:
        raise ServiceUnavailableError()
    return RedisRateLimitBackend(client)


async def get_anti_spam_service(
    backend: Annotated[RateLimitBackend, Depends(get_auth_rate_limit_backend)],
) -> AntiSpamService:
    return AntiSpamService(rate_limit_backend=backend)


def get_email_sender() -> EmailSender:
    """Реализация-заглушка v0 (design.md D5); провайдер — точка расширения."""
    return LogEmailSender()


async def get_auth_service(
    session: Annotated[AsyncSession, Depends(get_db_session)],
    anti_spam_service: Annotated[AntiSpamService, Depends(get_anti_spam_service)],
    email_sender: Annotated[EmailSender, Depends(get_email_sender)],
) -> AuthService:
    return AuthService(
        session=session,
        user_repository=UserRepository(session),
        identity_repository=AuthIdentityRepository(session),
        auth_repository=AuthRepository(session),
        consent_repository=ConsentRepository(session),
        audit_log_repository=AuditLogRepository(session),
        anti_spam_service=anti_spam_service,
        email_sender=email_sender,
    )


async def get_email_link_auth_service(
    session: Annotated[AsyncSession, Depends(get_db_session)],
    anti_spam_service: Annotated[AntiSpamService, Depends(get_anti_spam_service)],
    email_sender: Annotated[EmailSender, Depends(get_email_sender)],
) -> AuthService:
    """AuthService с флоу email-кодов; без Redis — 503 (коды негде хранить)."""
    client = get_redis_client()
    if client is None:
        raise ServiceUnavailableError()
    return AuthService(
        session=session,
        user_repository=UserRepository(session),
        identity_repository=AuthIdentityRepository(session),
        auth_repository=AuthRepository(session),
        consent_repository=ConsentRepository(session),
        audit_log_repository=AuditLogRepository(session),
        anti_spam_service=anti_spam_service,
        email_sender=email_sender,
        email_code_service=EmailLinkCodeService(
            redis=client,
            rate_limit_backend=RedisRateLimitBackend(client),
            send_code=email_sender.send_email_link_code,
        ),
    )


async def get_consent_service(
    session: Annotated[AsyncSession, Depends(get_db_session)],
) -> ConsentService:
    return ConsentService(
        session=session,
        consent_repository=ConsentRepository(session),
        audit_log_repository=AuditLogRepository(session),
    )


async def get_current_user(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
    session: Annotated[AsyncSession, Depends(get_db_session)],
) -> User:
    """Валидирует Bearer access-токен и возвращает пользователя.

    401 AUTH_TOKEN_EXPIRED — истёкший токен; 401 AUTH_TOKEN_INVALID —
    битый/подделанный/без токена.
    """
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise TokenInvalidError("Требуется авторизация. Войдите в аккаунт.", headers=_WWW_AUTH)

    try:
        payload = decode_and_validate_jwt(credentials.credentials)
        user_id = UUID(payload.sub)
    except TokenValidationError as exc:
        if "expired" in str(exc).lower():
            raise TokenExpiredError(headers=_WWW_AUTH) from exc
        raise TokenInvalidError(headers=_WWW_AUTH) from exc
    except ValueError as exc:
        raise TokenInvalidError(headers=_WWW_AUTH) from exc

    user = await UserRepository(session).get_by_id(user_id)
    if user is None:
        raise TokenInvalidError("Пользователь не найден. Войдите снова.", headers=_WWW_AUTH)
    if not user.is_active:
        raise ForbiddenError("Аккаунт деактивирован. Обратитесь в поддержку.")

    return user
