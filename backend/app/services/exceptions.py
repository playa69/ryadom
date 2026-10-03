"""Доменные исключения сервисного слоя.

Каждое исключение несёт HTTP-статус, код из каталога ErrorCode и опциональные
детали/заголовки; маппинг в ответ выполняет exception handler в app/main.py.
"""

from typing import Any

from app.schemas.errors import ErrorCode, FieldErrorDetail


class AppError(Exception):
    """Базовое доменное исключение с маппингом в HTTP-ответ."""

    status_code: int = 500
    code: ErrorCode = ErrorCode.INTERNAL_ERROR

    def __init__(
        self,
        message: str | None = None,
        *,
        details: dict[str, Any] | list[FieldErrorDetail] | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(message or self.code.value)
        self.message = message
        self.details = details
        self.headers = headers


class TokenExpiredError(AppError):
    status_code = 401
    code = ErrorCode.AUTH_TOKEN_EXPIRED


class TokenInvalidError(AppError):
    status_code = 401
    code = ErrorCode.AUTH_TOKEN_INVALID


class InvalidRefreshTokenError(AppError):
    status_code = 401
    code = ErrorCode.AUTH_REFRESH_TOKEN_INVALID


class InvalidCredentialsError(AppError):
    status_code = 401
    code = ErrorCode.AUTH_INVALID_CREDENTIALS


class InvalidResetTokenError(AppError):
    status_code = 400
    code = ErrorCode.AUTH_RESET_TOKEN_INVALID


class EmailCodeExpiredError(AppError):
    status_code = 400
    code = ErrorCode.AUTH_CODE_EXPIRED


class EmailCodeInvalidError(AppError):
    status_code = 400
    code = ErrorCode.AUTH_CODE_INVALID


class EmailCodeTooManyAttemptsError(AppError):
    status_code = 400
    code = ErrorCode.AUTH_CODE_TOO_MANY_ATTEMPTS


class EmailAlreadyLinkedError(AppError):
    status_code = 409
    code = ErrorCode.AUTH_EMAIL_ALREADY_LINKED


class AgeRestrictedError(AppError):
    status_code = 403
    code = ErrorCode.AGE_RESTRICTED


class ConsentRequiredError(AppError):
    status_code = 403
    code = ErrorCode.CONSENT_REQUIRED


class ForbiddenError(AppError):
    status_code = 403
    code = ErrorCode.FORBIDDEN


class NotFoundError(AppError):
    status_code = 404
    code = ErrorCode.NOT_FOUND


class ConflictError(AppError):
    status_code = 409
    code = ErrorCode.CONFLICT


class ServiceUnavailableError(AppError):
    status_code = 503
    code = ErrorCode.SERVICE_UNAVAILABLE


class RateLimitExceededError(AppError):
    """429 RATE_LIMITED; обязан нести Retry-After."""

    status_code = 429
    code = ErrorCode.RATE_LIMITED

    def __init__(
        self,
        message: str | None = None,
        *,
        retry_after_seconds: int | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        headers = {"Retry-After": str(retry_after_seconds)} if retry_after_seconds else None
        super().__init__(message, details=details, headers=headers)
        self.retry_after_seconds = retry_after_seconds
