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
    # Реплика оборвана на полуслове («и…», «потому что»): ответ ждёт столько, не договорит ли человек. 0 — не ждать.
    incomplete_hold_ms: int = Field(validation_alias="INCOMPLETE_HOLD_MS", default=1500, ge=0, le=10_000)
    # Файл SQLite, в который дублируются диалоги: после перезапуска и выката агента они возвращаются. Путь должен лежать на томе
    # пода (в k8s это PVC `agent-data`, /data/dialogs.sqlite3). Пусто — диалоги только в памяти и пропадают при перезапуске
    # (тесты и разработка). Не открылся файл — агент работает в памяти и громко пишет об этом, а не падает.
    db_path: str | None = Field(validation_alias="DIALOG_DB_PATH", default=None)
    # Как часто записывать изменения диалогов на диск, мс (идущие ответы дописываются, поэтому не при каждом слове).
    db_flush_ms: int = Field(validation_alias="DIALOG_DB_FLUSH_MS", default=500, ge=50, le=10_000)


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
    # Читать звук Qwen потоком: прокси отдаёт его кусками, и первый звук идёт раньше (проверено живым замером,
    # см. scripts/latency_probe.py). false — ждать фразу целиком, как раньше.
    qwen_stream: bool = Field(validation_alias="QWEN_TTS_STREAM", default=True)


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


class VoiceSettings(BaseAppSettings):
    """Каким путём идёт голосовой диалог.

    `VOICE_PIPELINE`:
      cascade      распознавание → чат-модель → озвучка (по умолчанию; настраивается `LLM_MODE` и `TTS_MODE`)
      gemini_live  речь в речь через Gemini Live: слушает, отвечает и говорит одна модель (настраивается `GEMINI_*`)
    """

    pipeline: Literal["cascade", "gemini_live"] = Field(validation_alias="VOICE_PIPELINE", default="cascade")


class GeminiSettings(BaseAppSettings):
    """Gemini Live (`VOICE_PIPELINE=gemini_live`): речь в речь по WebSocket через SDK google-genai.

    Нужен только в этом режиме; без `GEMINI_API_KEY` сервис в нём не стартует. Из России Google отвечает «User location is
    not supported»: тогда `GEMINI_BASE_URL` указывает на прослойку в поддерживаемой стране (WebSocket-релей к
    generativelanguage.googleapis.com).
    """

    api_key: SecretStr | None = Field(validation_alias="GEMINI_API_KEY", default=None)
    # Адрес Gemini API (https://… или http://…, SDK сам берёт wss://… для Live). Пусто — напрямую в Google.
    base_url: str | None = Field(validation_alias="GEMINI_BASE_URL", default=None)
    # Токен релея (agent/relay): уходит заголовком X-Relay-Token на GEMINI_BASE_URL, релей без него отвечает 403.
    relay_token: SecretStr | None = Field(validation_alias="GEMINI_RELAY_TOKEN", default=None)
    live_model: str = Field(validation_alias="GEMINI_LIVE_MODEL", default="gemini-3.8-live")
    # Голос выбирается по роду, как у остальных провайдеров; названия — встроенные голоса Gemini.
    voice_male: str = Field(validation_alias="GEMINI_LIVE_VOICE_MALE", default="Charon")
    voice_female: str = Field(validation_alias="GEMINI_LIVE_VOICE_FEMALE", default="Kore")
    connect_timeout_seconds: int = Field(validation_alias="GEMINI_CONNECT_TIMEOUT_SECONDS", default=15, ge=1)
    # Сколько ждать расшифровку реплики, прежде чем отдать человеку ответ: до этого момента агент проверяет реплику на кризис.
    transcript_wait_ms: int = Field(validation_alias="GEMINI_TRANSCRIPT_WAIT_MS", default=1000, ge=0, le=5000)
    # Ответ, от которого нет событий дольше этого, считается оборванным.
    idle_timeout_seconds: int = Field(validation_alias="GEMINI_IDLE_TIMEOUT_SECONDS", default=15, ge=1)
    # Сколько последних сообщений диалога модель получает текстом при новой сессии (после каждого ответа при
    # GEMINI_TEXT_CONTEXT, а также после переподключения и смены голоса). 0 — весь диалог.
    history_messages: int = Field(validation_alias="GEMINI_HISTORY_MESSAGES", default=40, ge=0)
    # Экономия на контексте: Gemini оплачивает весь контекст сессии на каждый ход, а голос человека и ответа копится в нём
    # аудио-токенами (на стенде +300 токенов на ход, аудио дороже текста). Поэтому после каждого ответа агент открывает
    # свежую сессию и кладёт в неё прошлые реплики текстом (history_config.initial_history_in_client_content): аудио в
    # контексте остаётся только текущей реплики, а память о разговоре сохраняется. Старая сессия закрывается. Возобновление
    # сессии по handle при включённой опции не используется (handle вернул бы накопленное аудио), сжатие контекста остаётся
    # страховкой на случай очень длинной истории.
    text_context: bool = Field(validation_alias="GEMINI_TEXT_CONTEXT", default=True)
    # «Размышление» модели перед ответом (токены): -1 (по умолчанию) — параметр не отправляется, решает Google; 0 — выключено
    # (замер на gemini-3.8-live: первый звук на ~0,2 с быстрее, ответы короткие и тёплые, рассуждать нечем); >0 — предел.
    # Кризисы модель не решает: их ловит агент.
    thinking_budget: int = Field(validation_alias="GEMINI_THINKING_BUDGET", default=-1, ge=-1)
    # Длинный разговор: когда контекст сессии подходит к пределу, Google сам сжимает его скользящим окном (самое старое
    # уходит, начало разговора и промпт остаются), и сессия не обрывается. Без сжатия голосовая сессия живёт ~15 минут.
    compression: bool = Field(validation_alias="GEMINI_COMPRESSION", default=True)
    # При каком размере контекста (токены) сжимать; 0 — решает Google (около 80% окна модели).
    compression_trigger_tokens: int = Field(validation_alias="GEMINI_COMPRESSION_TRIGGER_TOKENS", default=0, ge=0)
    # До какого размера сжимать (токены); 0 — решает Google.
    compression_target_tokens: int = Field(validation_alias="GEMINI_COMPRESSION_TARGET_TOKENS", default=0, ge=0)
    # Соединение живёт ограниченно (Google шлёт предупреждение GoAway): при возобновлении сессии по handle контекст
    # разговора переживает переподключение. Без handle (или если он не принят) модель получает последние сообщения текстом.
    session_resumption: bool = Field(validation_alias="GEMINI_SESSION_RESUMPTION", default=True)


class MemoryReclaimSettings(BaseAppSettings):
    """Возврат памяти процесса системе (app/core/reclaim.py).

    После нагрузки память процесса не опускалась: освобождённое Python и glibc держат у себя, а остатки закрытых соединений
    ждут редкой полной сборки мусора. Раз в `MEMORY_RECLAIM_SECONDS` агент собирает мусор и отдаёт свободные страницы кучи
    системе (`malloc_trim`, только Linux с glibc; в других ОС этот шаг пропускается).
    """

    # Как часто возвращать память, секунды. 0 — не возвращать (заморозка стартовых объектов для сборщика остаётся).
    seconds: int = Field(validation_alias="MEMORY_RECLAIM_SECONDS", default=60, ge=0)


class Config:
    """Агрегатор доменных настроек. Неизменяемый синглтон — не мутировать."""

    app: AppSettings = AppSettings()
    security: SecuritySettings = SecuritySettings()
    dialog: DialogSettings = DialogSettings()
    speech: SpeechSettings = SpeechSettings()
    llm: LlmSettings = LlmSettings()
    voice: VoiceSettings = VoiceSettings()
    gemini: GeminiSettings = GeminiSettings()
    memory_reclaim: MemoryReclaimSettings = MemoryReclaimSettings()


APP_CONFIG = Config()
