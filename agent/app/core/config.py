"""Типизированная конфигурация сервиса agent из переменных окружения.

Единственное место чтения env в приложении (.agents/skills/env-config-rules):
доменные Settings с validation_alias, SecretStr для секретов, fail-fast
валидация, неизменяемый синглтон APP_CONFIG.

Упрощённая версия: токен, озвучка, чат и распознавание через прокси, темп стрима.
Настройки БД, Redis и Langfuse вернутся вместе с полноценным агентом.
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
    приложение отправляет агенту (в Secret'ах кластера он лежит под именем `AGENT_INTERNAL_TOKEN`).
    """

    internal_token: SecretStr = Field(validation_alias="AGENT_INTERNAL_TOKEN", min_length=1)


class DialogSettings(BaseAppSettings):
    """Темп ответа и предел голосовой реплики."""

    # Слова уходят по одному, как стрим настоящей модели.
    stream_delay_ms: int = Field(validation_alias="STREAM_DELAY_MS", default=60, ge=0)
    # Самая длинная голосовая реплика: клиент закрывает её сам на этой же секунде, а всё сверх неё агент
    # отбрасывает, чтобы память соединения не росла без предела (5 минут PCM16 16 кГц — около 9,6 МБ).
    voice_turn_max_seconds: int = Field(validation_alias="VOICE_TURN_MAX_SECONDS", default=300, ge=1, le=600)


class SpeechSettings(BaseAppSettings):
    """Озвучка ответов агента (specs/speech-pipeline).

    `TTS_MODE`, чем озвучивать (недостающий ключ или бинарник — сервис не стартует):
      qwen          Qwen TTS через OpenAI-совместимый прокси: нужны `AGENT_API_TOKEN` (ключ прокси) и
                    `QWEN_TTS_BASE_URL` (по умолчанию)
      salutespeech  SaluteSpeech: нужен `SALUTE_SPEECH_AUTH_KEY` (ключ авторизации Сбера)
      espeak        локальный espeak-ng, ключей не нужно (для разработки)
      none          без озвучки: приложение читает ответы своим голосом (для разработки и тестов)

    Голос выбирается по роду, `male` или `female`; у каждого провайдера он отображается на свои голоса.
    """

    mode: Literal["qwen", "salutespeech", "espeak", "none"] = Field(validation_alias="TTS_MODE", default="qwen")
    default_voice: Literal["male", "female"] = Field(validation_alias="TTS_DEFAULT_VOICE", default="male")
    tts_frame_interval_ms: int = Field(validation_alias="TTS_FRAME_INTERVAL_MS", default=100, ge=0)
    # Сколько озвученных фраз помнить (по ним же прогреваются приветствия); 0 выключает память.
    tts_cache_items: int = Field(validation_alias="TTS_CACHE_ITEMS", default=64, ge=0)

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
    # Ключ прокси хранится в AGENT_API_TOKEN: он принадлежит только агенту и наружу не уходит. Не путать с
    # AGENT_INTERNAL_TOKEN, которым вызывающая сторона (api приложения) представляется самому агенту.
    qwen_api_key: SecretStr | None = Field(validation_alias="AGENT_API_TOKEN", default=None)
    qwen_model: str = Field(validation_alias="QWEN_TTS_MODEL", default="qwen/qwen-audio-3.0-tts-flash")
    qwen_voice_male: str = Field(validation_alias="QWEN_TTS_VOICE_MALE", default="loongjohn")
    qwen_voice_female: str = Field(validation_alias="QWEN_TTS_VOICE_FEMALE", default="longanhuan_v3.6")
    qwen_timeout_seconds: int = Field(validation_alias="QWEN_TTS_TIMEOUT_SECONDS", default=30, ge=1)


class LlmSettings(BaseAppSettings):
    """Чат и распознавание речи через OpenAI-совместимый прокси программы (LiteLLM).

    `LLM_MODE`:
      proxy     ответы пишет чат-модель, голос распознаёт whisper: нужны `AGENT_API_TOKEN` (тот же ключ прокси,
                что у озвучки) и `LLM_BASE_URL` (по умолчанию)
      template  без моделей: шаблонные ответы, а голосовая реплика превращается в `[голосовая реплика, N с]`
                (для разработки и тестов)
    """

    mode: Literal["proxy", "template"] = Field(validation_alias="LLM_MODE", default="proxy")
    base_url: str | None = Field(validation_alias="LLM_BASE_URL", default=None)
    api_key: SecretStr | None = Field(validation_alias="AGENT_API_TOKEN", default=None)
    # Русскоязычная модель Сбера: первый токен за ~0,6 с, ответ короткий и тёплый (сравнение — в README).
    chat_model: str = Field(validation_alias="LLM_CHAT_MODEL", default="gigachat3.5-432b-a28b")
    stt_model: str = Field(validation_alias="STT_MODEL", default="whisper-large-v3")
    # Дольше ждать ответ нет смысла: после таймаута агент отвечает шаблоном.
    timeout_seconds: int = Field(validation_alias="LLM_TIMEOUT_SECONDS", default=15, ge=1)
    # Распознавание ждёт дольше чата: реплика бывает до VOICE_TURN_MAX_SECONDS, и whisper на ней работает заметное время.
    stt_timeout_seconds: int = Field(validation_alias="STT_TIMEOUT_SECONDS", default=120, ge=1)
    # Сколько последних сообщений диалога видит модель.
    history_messages: int = Field(validation_alias="LLM_HISTORY_MESSAGES", default=12, ge=1)
    max_tokens: int = Field(validation_alias="LLM_MAX_TOKENS", default=200, ge=16)
    temperature: float = Field(validation_alias="LLM_TEMPERATURE", default=0.7, ge=0, le=2)


class Config:
    """Агрегатор доменных настроек. Неизменяемый синглтон — не мутировать."""

    app: AppSettings = AppSettings()
    security: SecuritySettings = SecuritySettings()
    dialog: DialogSettings = DialogSettings()
    speech: SpeechSettings = SpeechSettings()
    llm: LlmSettings = LlmSettings()


APP_CONFIG = Config()
