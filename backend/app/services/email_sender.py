"""Отправка email — за протоколом EmailSender (design.md D5).

Сервисный слой зависит только от протокола. В v0 — реализация-заглушка
LogEmailSender (masked-получатель в лог + аудит-событие); production-провайдер
подключается конфигурацией без смены бизнес-логики.
"""

from __future__ import annotations

from datetime import datetime
from typing import Protocol

from loguru import logger

from app.logger.masking import mask_email


class EmailSender(Protocol):
    """Интерфейс отправки auth-писем."""

    async def send_email_link_code(self, *, email: str, code: str) -> None:
        """Письмо с 6-значным кодом привязки email."""
        ...

    async def send_password_reset(self, *, email: str, reset_token: str, expires_at: datetime) -> None:
        """Письмо со ссылкой сброса пароля."""
        ...

    async def send_password_changed(self, *, email: str) -> None:
        """Уведомление об изменении пароля."""
        ...


class LogEmailSender:
    """Заглушка: пишет masked-получателя в лог и аудит-событие."""

    async def send_email_link_code(self, *, email: str, code: str) -> None:
        logger.info(f"Email-заглушка: код привязки отправлен на {mask_email(email)}")
        logger.bind(
            target="audit-event",
            audit_event_name="EmailLinkCodeSent",
            audit_params={"email": mask_email(email)},
        ).info("")

    async def send_password_reset(self, *, email: str, reset_token: str, expires_at: datetime) -> None:
        logger.info(f"Email-заглушка: письмо сброса пароля отправлено на {mask_email(email)}")
        logger.bind(
            target="audit-event",
            audit_event_name="PasswordResetEmailSent",
            audit_params={"email": mask_email(email), "expires_at": expires_at.isoformat()},
        ).info("")

    async def send_password_changed(self, *, email: str) -> None:
        logger.info(f"Email-заглушка: уведомление о смене пароля отправлено на {mask_email(email)}")
        logger.bind(
            target="audit-event",
            audit_event_name="PasswordChangedEmailSent",
            audit_params={"email": mask_email(email)},
        ).info("")
