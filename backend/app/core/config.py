"""Типизированная конфигурация сервиса из переменных окружения.

Единственное место чтения env в приложении (.agents/skills/env-config-rules):
доменные Settings с validation_alias, SecretStr для секретов, fail-fast
валидация, неизменяемый синглтон APP_CONFIG, флаги *_IS_HARD_HEALTH.
"""

import json
import logging
import os
from typing import Any

from dotenv import load_dotenv
from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

load_dotenv()


class BaseAppSettings(BaseSettings):
    """Базовые настройки, общие для всех доменов."""

    model_config = SettingsConfigDict(env_ignore_empty=True, enable_decoding=False)

    local: bool = Field(validation_alias="LOCAL", default=False)
    debug: bool = Field(validation_alias="DEBUG", default=False)

    @property
    def log_lvl(self) -> int:
        return logging.DEBUG if self.debug else logging.INFO


class AppSettings(BaseAppSettings):
    """Общие настройки приложения."""

    host: str = Field(validation_alias="APP_HOST", default="0.0.0.0")
    port: int = Field(validation_alias="APP_PORT", default=8000)
    timezone: str = Field(validation_alias="TIMEZONE", default="Europe/Moscow")
    version: str = Field(validation_alias="APP_VERSION", default="0.1.0")
    trusted_proxy_ips: list[str] = Field(
        validation_alias="TRUSTED_PROXY_IPS", default_factory=list
    )

    @field_validator("trusted_proxy_ips", mode="before")
    @classmethod
    def validate_trusted_proxy_ips(cls, value: Any) -> Any:
        if isinstance(value, list):
            return value
        if isinstance(value, str):
            try:
                parsed = json.loads(value)
            except json.JSONDecodeError:
                parsed = None
            if isinstance(parsed, list):
                return [str(item) for item in parsed]
        return cls.model_fields["trusted_proxy_ips"].get_default(
            call_default_factory=True
        )


class LogSettings(BaseAppSettings):
    """Настройки логирования (три sink'а + ротация + маскирование)."""

    log_path: str = Field(validation_alias="LOG_PATH", default="./logs")
    log_file_name: str = Field(validation_alias="LOG_FILE_NAME", default="app.log")
    metric_path: str = Field(validation_alias="METRIC_PATH", default="./logs")
    metric_file_name: str = Field(
        validation_alias="METRIC_FILE_NAME", default="app-metric.log"
    )
    audit_log_path: str = Field(validation_alias="AUDIT_LOG_PATH", default="./logs")
    audit_log_file_name: str = Field(
        validation_alias="AUDIT_LOG_FILE_NAME", default="events.log"
    )
    log_rotation: str = Field(validation_alias="LOG_ROTATION", default="10 MB")
    mask_enabled: bool = Field(validation_alias="MASK_ENABLED", default=True)

    @property
    def log_file_path(self) -> str:
        return os.path.join(self.log_path, self.log_file_name)

    @property
    def metric_file_path(self) -> str:
        return os.path.join(self.metric_path, self.metric_file_name)

    @property
    def audit_file_path(self) -> str:
        return os.path.join(self.audit_log_path, self.audit_log_file_name)


class PostgresSettings(BaseAppSettings):
    """Настройки PostgreSQL."""

    host: str = Field(validation_alias="PG_HOST", default="localhost")
    port: int = Field(validation_alias="PG_PORT", default=5432)
    db: str = Field(validation_alias="PG_DB", default="backend")
    user: str = Field(validation_alias="PG_USER", default="developer")
    password: SecretStr = Field(validation_alias="PG_PASSWORD")
    is_hard_health: bool = Field(validation_alias="PG_IS_HARD_HEALTH", default=True)

    @property
    def sqlalchemy_database_uri(self) -> str:
        return (
            f"postgresql+asyncpg://{self.user}:{self.password.get_secret_value()}"
            f"@{self.host}:{self.port}/{self.db}"
        )


class RedisSettings(BaseAppSettings):
    """Настройки Redis (Sentinel)."""

    enabled: bool = Field(validation_alias="REDIS_ENABLED", default=True)
    sentinel_host: str = Field(validation_alias="REDIS_SENTINEL_HOST", default="redis")
    sentinel_port: int = Field(validation_alias="REDIS_SENTINEL_PORT", default=26379)
    master_name: str = Field(validation_alias="REDIS_MASTER_NAME", default="mymaster")
    password: SecretStr | None = Field(validation_alias="REDIS_PASSWORD", default=None)
    is_hard_health: bool = Field(validation_alias="REDIS_IS_HARD_HEALTH", default=True)


class JWTSettings(BaseAppSettings):
    """Настройки токенов доступа."""

    secret_key: SecretStr = Field(validation_alias="JWT_SECRET_KEY")
    algorithm: str = Field(validation_alias="JWT_ALGORITHM", default="HS256")
    access_token_expire_minutes: int = Field(
        validation_alias="ACCESS_TOKEN_EXPIRE_MINUTES", default=15, ge=1
    )
    refresh_token_expire_days: int = Field(
        validation_alias="REFRESH_TOKEN_EXPIRE_DAYS", default=30, ge=1
    )
    refresh_token_rotation_grace_seconds: int = Field(
        validation_alias="REFRESH_TOKEN_ROTATION_GRACE_SECONDS", default=10, ge=0
    )
    password_reset_token_expire_minutes: int = Field(
        validation_alias="PASSWORD_RESET_TOKEN_EXPIRE_MINUTES", default=30, ge=1
    )


class EmailCodeSettings(BaseAppSettings):
    """Настройки флоу привязки email по 6-значному коду."""

    code_ttl_seconds: int = Field(
        validation_alias="EMAIL_LINK_CODE_TTL_SECONDS", default=600, ge=60
    )
    max_attempts: int = Field(
        validation_alias="EMAIL_LINK_MAX_ATTEMPTS", default=5, ge=1
    )


class SecuritySettings(BaseAppSettings):
    """Лимиты антиспама auth-контуров (specs/auth «Rate-limit и антиспам»)."""

    device_login_rate_limit: int = Field(
        validation_alias="SECURITY_DEVICE_LOGIN_RATE_LIMIT", default=20, ge=1
    )
    device_login_rate_limit_window_seconds: int = Field(
        validation_alias="SECURITY_DEVICE_LOGIN_RATE_LIMIT_WINDOW_SECONDS",
        default=3600,
        ge=1,
    )
    email_login_rate_limit: int = Field(
        validation_alias="SECURITY_EMAIL_LOGIN_RATE_LIMIT", default=10, ge=1
    )
    email_login_rate_limit_window_seconds: int = Field(
        validation_alias="SECURITY_EMAIL_LOGIN_RATE_LIMIT_WINDOW_SECONDS",
        default=300,
        ge=1,
    )
    email_link_rate_limit: int = Field(
        validation_alias="SECURITY_EMAIL_LINK_RATE_LIMIT", default=5, ge=1
    )
    email_link_rate_limit_window_seconds: int = Field(
        validation_alias="SECURITY_EMAIL_LINK_RATE_LIMIT_WINDOW_SECONDS",
        default=3600,
        ge=1,
    )
    password_reset_rate_limit: int = Field(
        validation_alias="SECURITY_PASSWORD_RESET_RATE_LIMIT", default=1, ge=1
    )
    password_reset_rate_limit_window_seconds: int = Field(
        validation_alias="SECURITY_PASSWORD_RESET_RATE_LIMIT_WINDOW_SECONDS",
        default=75600,
        ge=1,
    )
    password_reset_cooldown_seconds: int = Field(
        validation_alias="SECURITY_PASSWORD_RESET_COOLDOWN_SECONDS", default=75600, ge=1
    )
    password_reset_confirm_rate_limit: int = Field(
        validation_alias="SECURITY_PASSWORD_RESET_CONFIRM_RATE_LIMIT", default=10, ge=1
    )
    password_reset_confirm_rate_limit_window_seconds: int = Field(
        validation_alias="SECURITY_PASSWORD_RESET_CONFIRM_RATE_LIMIT_WINDOW_SECONDS",
        default=300,
        ge=1,
    )


class Config:
    """Агрегатор доменных настроек. Неизменяемый синглтон — не мутировать."""

    app: AppSettings = AppSettings()
    log: LogSettings = LogSettings()
    pg: PostgresSettings = PostgresSettings()
    redis: RedisSettings = RedisSettings()
    jwt: JWTSettings = JWTSettings()
    email_code: EmailCodeSettings = EmailCodeSettings()
    security: SecuritySettings = SecuritySettings()


APP_CONFIG = Config()
