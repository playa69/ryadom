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
      auto    по приоритету: SaluteSpeech (если задан ключ) → Qwen TTS (если задан ключ прокси) →
              espeak-ng (если установлен) → без озвучки
      salute  только SaluteSpeech (нет ключа — сервис не стартует)
      qwen    только Qwen TTS через OpenAI-совместимый прокси (нет ключа или адреса — сервис не стартует)
      espeak  только espeak-ng (нет бинарника — сервис не стартует)
      none    без озвучки: приложение читает ответы своим голосом

    Голос выбирается по роду, `male` или `female`; у каждого провайдера он отображается на свои голоса.
    """

    tts_provider: Literal["auto", "salute", "qwen", "espeak", "none"] = Field(validation_alias="TTS_PROVIDER", default="auto")
    default_voice: Literal["male", "female"] = Field(validation_alias="TTS_DEFAULT_VOICE", default="male")
    tts_frame_interval_ms: int = Field(validation_alias="TTS_FRAME_INTERVAL_MS", default=100, ge=0)

    espeak_binary: str = Field(validation_alias="ESPEAK_BINARY", default="espeak-ng")
    espeak_voice_male: str = Field(validation_alias="ESPEAK_VOICE_MALE", default="ru")
    espeak_voice_female: str = Field(validation_alias="ESPEAK_VOICE_FEMALE", default="ru+f2")
    espeak_speed: int = Field(validation_alias="ESPEAK_SPEED", default=150, ge=80, le=450)

    salute_auth_key: SecretStr | None = Field(validation_alias="SALUTE_SPEECH_AUTH_KEY", default=None)
    salute_scope: str = Field(validation_alias="SALUTE_SPEECH_SCOPE", default="SALUTE_SPEECH_PERS")
    salute_voice_male: str = Field(validation_alias="SALUTE_SPEECH_VOICE_MALE", default="Bys_24000")
    salute_voice_female: str = Field(validation_alias="SALUTE_SPEECH_VOICE_FEMALE", default="Nec_24000")
    salute_timeout_seconds: int = Field(validation_alias="SALUTE_SPEECH_TIMEOUT_SECONDS", default=15, ge=1)
    # Сертификаты Сбера подписаны российским корневым УЦ: путь к его пакету, если системного хранилища мало.
    salute_ca_bundle: str | None = Field(validation_alias="SALUTE_SPEECH_CA_BUNDLE", default=None)

    # Qwen TTS через OpenAI-совместимый прокси (POST {base_url}/audio/speech). У модели свои голоса и форматы:
    # голоса loongjohn и longanhuan_v3.6, форматы mp3 и pcm; агенту нужен pcm (PCM16, 24 кГц, моно).
    qwen_base_url: str | None = Field(validation_alias="QWEN_TTS_BASE_URL", default=None)
    qwen_api_key: SecretStr | None = Field(validation_alias="QWEN_TTS_API_KEY", default=None)
    qwen_model: str = Field(validation_alias="QWEN_TTS_MODEL", default="qwen/qwen-audio-3.0-tts-flash")
    qwen_voice_male: str = Field(validation_alias="QWEN_TTS_VOICE_MALE", default="loongjohn")
    qwen_voice_female: str = Field(validation_alias="QWEN_TTS_VOICE_FEMALE", default="longanhuan_v3.6")
    qwen_timeout_seconds: int = Field(validation_alias="QWEN_TTS_TIMEOUT_SECONDS", default=30, ge=1)


class Config:
    """Агрегатор доменных настроек. Неизменяемый синглтон — не мутировать."""

    app: AppSettings = AppSettings()
    security: SecuritySettings = SecuritySettings()
    dialog: DialogSettings = DialogSettings()
    speech: SpeechSettings = SpeechSettings()


APP_CONFIG = Config()
