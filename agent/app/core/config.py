"""Типизированная конфигурация сервиса agent из переменных окружения.

Единственное место чтения env в приложении (.agents/skills/env-config-rules):
доменные Settings с validation_alias, SecretStr для секретов, fail-fast
валидация, неизменяемый синглтон APP_CONFIG, флаги *_IS_HARD_HEALTH.
"""

import logging
import os

from dotenv import load_dotenv
from pydantic import Field, SecretStr
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
    port: int = Field(validation_alias="APP_PORT", default=8001)
    timezone: str = Field(validation_alias="TIMEZONE", default="Europe/Moscow")
    version: str = Field(validation_alias="APP_VERSION", default="0.1.0")


class LogSettings(BaseAppSettings):
    """Настройки логирования (три sink'а + ротация + маскирование)."""

    log_path: str = Field(validation_alias="LOG_PATH", default="./logs")
    log_file_name: str = Field(validation_alias="LOG_FILE_NAME", default="app.log")
    metric_path: str = Field(validation_alias="METRIC_PATH", default="./logs")
    metric_file_name: str = Field(validation_alias="METRIC_FILE_NAME", default="app-metric.log")
    audit_log_path: str = Field(validation_alias="AUDIT_LOG_PATH", default="./logs")
    audit_log_file_name: str = Field(validation_alias="AUDIT_LOG_FILE_NAME", default="events.log")
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


class LLMSettings(BaseAppSettings):
    """Настройки OpenAI-совместимого LLM API (Cloud.ru, design D3)."""

    base_url: str = Field(validation_alias="LLM_BASE_URL", default="https://foundation-models.api.cloud.ru/v1")
    api_key: SecretStr = Field(validation_alias="LLM_API_KEY")
    chat_model: str = Field(validation_alias="LLM_CHAT_MODEL")
    classifier_model: str = Field(validation_alias="LLM_CLASSIFIER_MODEL")
    embedding_model: str = Field(validation_alias="LLM_EMBEDDING_MODEL")
    timeout_seconds: int = Field(validation_alias="LLM_TIMEOUT_SECONDS", default=30, ge=1)
    is_hard_health: bool = Field(validation_alias="LLM_IS_HARD_HEALTH", default=True)


class SaluteSpeechSettings(BaseAppSettings):
    """Настройки SaluteSpeech (ASR/TTS стриминг)."""

    auth_key: SecretStr = Field(validation_alias="SALUTE_SPEECH_AUTH_KEY")
    scope: str = Field(validation_alias="SALUTE_SPEECH_SCOPE", default="SALUTE_SPEECH_PERS")
    timeout_seconds: int = Field(validation_alias="SALUTE_SPEECH_TIMEOUT_SECONDS", default=30, ge=1)
    is_hard_health: bool = Field(validation_alias="SALUTE_SPEECH_IS_HARD_HEALTH", default=False)
    default_voice: str = Field(validation_alias="SALUTE_SPEECH_DEFAULT_VOICE", default="May_24000")


class PostgresSettings(BaseAppSettings):
    """Настройки PostgreSQL (БД backend, read-only retrieval памяти, design D6)."""

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
    """Настройки Redis (Sentinel): TTS-кэш."""

    enabled: bool = Field(validation_alias="REDIS_ENABLED", default=True)
    sentinel_host: str = Field(validation_alias="REDIS_SENTINEL_HOST", default="redis")
    sentinel_port: int = Field(validation_alias="REDIS_SENTINEL_PORT", default=26379)
    master_name: str = Field(validation_alias="REDIS_MASTER_NAME", default="mymaster")
    password: SecretStr | None = Field(validation_alias="REDIS_PASSWORD", default=None)
    is_hard_health: bool = Field(validation_alias="REDIS_IS_HARD_HEALTH", default=True)


class SecuritySettings(BaseAppSettings):
    """Внутренняя авторизация и лимиты обработки хода (specs/agent-api)."""

    internal_token: SecretStr = Field(validation_alias="AGENT_INTERNAL_TOKEN")
    turn_timeout_seconds: int = Field(validation_alias="TURN_TIMEOUT_SECONDS", default=60, ge=1)


class LangfuseSettings(BaseAppSettings):
    """Настройки Langfuse-трейсинга."""

    host: str = Field(validation_alias="LANGFUSE_HOST", default="http://localhost:3000")
    public_key: str = Field(validation_alias="LANGFUSE_PUBLIC_KEY")
    secret_key: SecretStr = Field(validation_alias="LANGFUSE_SECRET_KEY")


class Config:
    """Агрегатор доменных настроек. Неизменяемый синглтон — не мутировать."""

    app: AppSettings = AppSettings()
    log: LogSettings = LogSettings()
    llm: LLMSettings = LLMSettings()
    salute_speech: SaluteSpeechSettings = SaluteSpeechSettings()
    pg: PostgresSettings = PostgresSettings()
    redis: RedisSettings = RedisSettings()
    security: SecuritySettings = SecuritySettings()
    langfuse: LangfuseSettings = LangfuseSettings()


APP_CONFIG = Config()
