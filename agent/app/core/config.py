"""Типизированная конфигурация сервиса agent из переменных окружения.

Единственное место чтения env в приложении (.agents/skills/env-config-rules):
доменные Settings с validation_alias, SecretStr для секретов, fail-fast
валидация, неизменяемый синглтон APP_CONFIG.

Упрощённая версия: только то, что нужно шаблонному агенту (токен, озвучка, темп стрима).
Настройки LLM, БД, Redis и Langfuse вернутся вместе с полноценным агентом.
"""

import logging
from typing import Literal

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
    version: str = Field(validation_alias="APP_VERSION", default="0.1.0")


class SecuritySettings(BaseAppSettings):
    """Внутренняя авторизация (specs/agent-api «Внутренняя авторизация»).

    Обязательна: без токена сервис не стартует. Это тот же секрет, что у вызывающей стороны
    лежит в `AGENT_API_TOKEN`.
    """

    internal_token: SecretStr = Field(validation_alias="AGENT_INTERNAL_TOKEN", min_length=1)


class DialogSettings(BaseAppSettings):
    """Темп ответа: слова уходят по одному, как стрим настоящей модели."""

    stream_delay_ms: int = Field(validation_alias="STREAM_DELAY_MS", default=60, ge=0)


class SpeechSettings(BaseAppSettings):
    """Озвучка ответов агента (specs/speech-pipeline).

    `TTS_PROVIDER`:
      auto    SaluteSpeech, если задан ключ; иначе espeak-ng, если он установлен; иначе без озвучки
      salute  только SaluteSpeech (нет ключа — сервис не стартует)
      espeak  только espeak-ng (нет бинарника — сервис не стартует)
      none    без озвучки: приложение читает ответы своим голосом
    """

    tts_provider: Literal["auto", "salute", "espeak", "none"] = Field(validation_alias="TTS_PROVIDER", default="auto")
    tts_frame_interval_ms: int = Field(validation_alias="TTS_FRAME_INTERVAL_MS", default=100, ge=0)

    espeak_binary: str = Field(validation_alias="ESPEAK_BINARY", default="espeak-ng")
    espeak_voice: str = Field(validation_alias="ESPEAK_VOICE", default="ru")
    espeak_speed: int = Field(validation_alias="ESPEAK_SPEED", default=150, ge=80, le=450)

    salute_auth_key: SecretStr | None = Field(validation_alias="SALUTE_SPEECH_AUTH_KEY", default=None)
    salute_scope: str = Field(validation_alias="SALUTE_SPEECH_SCOPE", default="SALUTE_SPEECH_PERS")
    salute_voice: str = Field(validation_alias="SALUTE_SPEECH_VOICE", default="May_24000")
    salute_timeout_seconds: int = Field(validation_alias="SALUTE_SPEECH_TIMEOUT_SECONDS", default=15, ge=1)
    # Сертификаты Сбера подписаны российским корневым УЦ: путь к его пакету, если системного хранилища мало.
    salute_ca_bundle: str | None = Field(validation_alias="SALUTE_SPEECH_CA_BUNDLE", default=None)


class Config:
    """Агрегатор доменных настроек. Неизменяемый синглтон — не мутировать."""

    app: AppSettings = AppSettings()
    security: SecuritySettings = SecuritySettings()
    dialog: DialogSettings = DialogSettings()
    speech: SpeechSettings = SpeechSettings()


APP_CONFIG = Config()
