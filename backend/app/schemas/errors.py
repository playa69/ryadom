"""Единый формат ошибок API (specs/backend-foundation «Единый формат ошибок»).

Все ошибки возвращаются как ``{"error": {"code", "message", "details"}}``.
Коды — SCREAMING_SNAKE из каталога спецификации.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Any

from pydantic import Field

from app.schemas.base import APIModel


class ErrorCode(StrEnum):
    """Машиночитаемые коды ошибок (каталог specs/backend-foundation)."""

    AUTH_TOKEN_EXPIRED = "AUTH_TOKEN_EXPIRED"
    AUTH_TOKEN_INVALID = "AUTH_TOKEN_INVALID"
    AUTH_REFRESH_TOKEN_INVALID = "AUTH_REFRESH_TOKEN_INVALID"
    AUTH_INVALID_CREDENTIALS = "AUTH_INVALID_CREDENTIALS"
    AUTH_RESET_TOKEN_INVALID = "AUTH_RESET_TOKEN_INVALID"
    AUTH_CODE_EXPIRED = "AUTH_CODE_EXPIRED"
    AUTH_CODE_INVALID = "AUTH_CODE_INVALID"
    AUTH_CODE_TOO_MANY_ATTEMPTS = "AUTH_CODE_TOO_MANY_ATTEMPTS"
    AUTH_EMAIL_ALREADY_LINKED = "AUTH_EMAIL_ALREADY_LINKED"
    AGE_RESTRICTED = "AGE_RESTRICTED"
    CONSENT_REQUIRED = "CONSENT_REQUIRED"
    FORBIDDEN = "FORBIDDEN"
    VALIDATION_ERROR = "VALIDATION_ERROR"
    NOT_FOUND = "NOT_FOUND"
    SESSION_NOT_FOUND = "SESSION_NOT_FOUND"
    ENTRY_NOT_FOUND = "ENTRY_NOT_FOUND"
    FACT_NOT_FOUND = "FACT_NOT_FOUND"
    RITUAL_NOT_FOUND = "RITUAL_NOT_FOUND"
    NEWS_NOT_FOUND = "NEWS_NOT_FOUND"
    SESSION_TRANSCRIPTS_DISABLED = "SESSION_TRANSCRIPTS_DISABLED"
    SESSION_ALREADY_FINISHED = "SESSION_ALREADY_FINISHED"
    CONFLICT = "CONFLICT"
    RATE_LIMITED = "RATE_LIMITED"
    SERVICE_UNAVAILABLE = "SERVICE_UNAVAILABLE"
    INTERNAL_ERROR = "INTERNAL_ERROR"


class FieldErrorDetail(APIModel):
    """Ошибка валидации конкретного поля."""

    field: str = Field(description="Имя поля (как в запросе клиента)")
    message: str = Field(description="Человекочитаемое сообщение об ошибке")
    code: str = Field(default="invalid", description="Тип ошибки")


class ErrorDetail(APIModel):
    """Тело ошибки: машиночитаемый код, RU-сообщение, детали."""

    code: ErrorCode
    message: str
    details: dict[str, Any] | list[FieldErrorDetail] | None = None


class ErrorResponse(APIModel):
    """Конверт ошибки: ``{"error": {...}}``."""

    error: ErrorDetail

    @classmethod
    def from_code(
        cls,
        code: ErrorCode,
        message: str | None = None,
        details: dict[str, Any] | list[FieldErrorDetail] | None = None,
    ) -> ErrorResponse:
        """Создаёт ответ-ошибку по коду с RU-сообщением по умолчанию."""
        if message is None:
            message = _DEFAULT_MESSAGES.get(code, "Произошла ошибка")
        return cls(error=ErrorDetail(code=code, message=message, details=details))


_DEFAULT_MESSAGES: dict[ErrorCode, str] = {
    ErrorCode.AUTH_TOKEN_EXPIRED: "Сессия истекла. Обновите токен или войдите снова",
    ErrorCode.AUTH_TOKEN_INVALID: "Недействительный токен. Войдите в аккаунт",
    ErrorCode.AUTH_REFRESH_TOKEN_INVALID: "Сессия завершена. Требуется повторный вход",
    ErrorCode.AUTH_INVALID_CREDENTIALS: "Неверные учётные данные",
    ErrorCode.AUTH_RESET_TOKEN_INVALID: "Ссылка для сброса пароля недействительна или истекла",
    ErrorCode.AUTH_CODE_EXPIRED: "Код истёк или уже использован. Запросите новый",
    ErrorCode.AUTH_CODE_INVALID: "Неверный код",
    ErrorCode.AUTH_CODE_TOO_MANY_ATTEMPTS: "Превышено число попыток. Запросите новый код",
    ErrorCode.AUTH_EMAIL_ALREADY_LINKED: "Этот email уже привязан к другому аккаунту",
    ErrorCode.AGE_RESTRICTED: "Сервис доступен только пользователям старше 18 лет",
    ErrorCode.CONSENT_REQUIRED: "Требуется принятие условий использования",
    ErrorCode.FORBIDDEN: "Доступ запрещён",
    ErrorCode.VALIDATION_ERROR: "Ошибка валидации данных",
    ErrorCode.NOT_FOUND: "Запрашиваемый ресурс не найден",
    ErrorCode.SESSION_NOT_FOUND: "Сессия не найдена",
    ErrorCode.ENTRY_NOT_FOUND: "Запись не найдена",
    ErrorCode.FACT_NOT_FOUND: "Факт не найден",
    ErrorCode.RITUAL_NOT_FOUND: "Ритуал не найден",
    ErrorCode.NEWS_NOT_FOUND: "Новость не найдена",
    ErrorCode.SESSION_TRANSCRIPTS_DISABLED: "Хранение транскриптов отключено",
    ErrorCode.SESSION_ALREADY_FINISHED: "Сессия уже завершена",
    ErrorCode.CONFLICT: "Конфликт данных",
    ErrorCode.RATE_LIMITED: "Слишком много попыток. Попробуйте позже",
    ErrorCode.SERVICE_UNAVAILABLE: "Сервис временно недоступен. Попробуйте позже",
    ErrorCode.INTERNAL_ERROR: "Внутренняя ошибка сервера",
}
