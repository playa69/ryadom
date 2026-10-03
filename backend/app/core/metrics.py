"""Prometheus-метрики auth-контура (без PII в labels)."""

from __future__ import annotations

from prometheus_client import Counter

AUTH_LOGIN_TOTAL = Counter(
    "backend_auth_login_total",
    "Входы пользователей по флоу и результату.",
    labelnames=("flow", "result"),
)

AUTH_REFRESH_TOTAL = Counter(
    "backend_auth_refresh_total",
    "Обновления пар токенов по результату.",
    labelnames=("result",),
)

AUTH_PASSWORD_RESET_REQUESTS_TOTAL = Counter(
    "backend_auth_password_reset_requests_total",
    "Запросы сброса пароля по результату.",
    labelnames=("result",),
)

AUTH_EMAIL_LINK_TOTAL = Counter(
    "backend_auth_email_link_total",
    "Операции привязки email по результату.",
    labelnames=("stage", "result"),
)

AUTH_FAMILY_REVOKE_TOTAL = Counter(
    "backend_auth_family_revoke_total",
    "Отзывы семейства refresh-токенов при replay вне grace-окна.",
)

AUTH_RATE_LIMITED_TOTAL = Counter(
    "backend_auth_rate_limited_total",
    "Срабатывания антиспама auth-контуров по action.",
    labelnames=("action",),
)
