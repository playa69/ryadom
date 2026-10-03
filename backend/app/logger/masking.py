"""Маскирование PII перед записью в лог."""

import re

_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")


def mask_email(email: str) -> str:
    """Маскирует local-part и домен email: ``us***r@ex***e.com``."""
    local_part, _, domain = email.partition("@")
    masked_local = _mask_token(local_part)
    masked_domain = _mask_token(domain)
    return f"{masked_local}@{masked_domain}" if domain else masked_local


def mask_pii_in_text(text: str) -> str:
    """Маскирует все email-адреса в произвольном тексте."""
    return _EMAIL_RE.sub(lambda m: mask_email(m.group(0)), text)


def _mask_token(value: str) -> str:
    if not value:
        return "***"
    if len(value) <= 2:
        return "*" * len(value)
    if len(value) <= 4:
        return f"{value[0]}{'*' * (len(value) - 1)}"
    return f"{value[:2]}{'*' * (len(value) - 3)}{value[-1]}"
