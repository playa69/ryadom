"""Типизированная конфигурация сервиса agent из переменных окружения.

Единственное место чтения env в приложении (agent/AGENTS.md, «Конфигурация»):
доменные Settings с validation_alias, SecretStr для секретов, fail-fast
валидация, неизменяемый синглтон APP_CONFIG.

Голос — Gemini Live (`GEMINI_*`); текстовая модель прокси программы (`LLM_*`) пишет только фоновые тексты: итоги разговоров и
недели, заметки памяти. Дальше: темп стрима фраз, диалоги в PostgreSQL, память (Cognee), трейсинг ходов и расход моделей в
self-hosted Langfuse.
"""

import logging
from typing import Literal

from dotenv import load_dotenv
from pydantic import Field, SecretStr, model_validator
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
    """Темп фиксированных фраз и предел голосовой реплики."""

    # Слова фиксированных фраз (кризисный ответ, просьба повторить) уходят по одному, как стрим ответа модели.
    stream_delay_ms: int = Field(validation_alias="STREAM_DELAY_MS", default=60, ge=0)
    # Самая длинная голосовая реплика: клиент закрывает её сам на этой же секунде, а всё сверх неё агент
    # отбрасывает, чтобы память соединения не росла без предела (5 минут PCM16 16 кГц — около 9,6 МБ).
    voice_turn_max_seconds: int = Field(validation_alias="VOICE_TURN_MAX_SECONDS", default=300, ge=1, le=600)
    # DSN PostgreSQL, в котором живут диалоги (app/services/dialog_db.py): в k8s это база `agent` в CNPG
    # `ryadom-db`, значение — в Secret `agent-db`. Пусто — диалоги только в памяти процесса и пропадают при
    # перезапуске (разработка); агент не падает и громко пишет об этом в журнал.
    database_url: str | None = Field(validation_alias="DIALOG_DATABASE_URL", default=None)
    # Пул проверяет соединение перед выдачей и заменяет разорванное без перезапуска агента.
    db_pool_min_size: int = Field(validation_alias="DIALOG_DB_POOL_MIN_SIZE", default=1, ge=0)
    db_pool_max_size: int = Field(validation_alias="DIALOG_DB_POOL_MAX_SIZE", default=4, ge=1)
    db_pool_max_idle_seconds: float = Field(validation_alias="DIALOG_DB_POOL_MAX_IDLE_SECONDS", default=300, ge=1)
    db_pool_max_lifetime_seconds: float = Field(
        validation_alias="DIALOG_DB_POOL_MAX_LIFETIME_SECONDS", default=3600, ge=1
    )
    # Как часто записывать изменения диалогов на диск, мс (идущие ответы дописываются, поэтому не при каждом слове).
    db_flush_ms: int = Field(validation_alias="DIALOG_DB_FLUSH_MS", default=500, ge=50, le=10_000)
    # Выгрузка неактивных (только при диске): человек, к которому не обращались столько секунд, уходит из памяти пода, его
    # диалоги остаются на диске и загружаются снова при следующем обращении (около миллисекунды). Живой сокет и незаписанные
    # изменения держат человека в памяти. 0 — не выгружать по сроку.
    idle_evict_seconds: int = Field(validation_alias="DIALOG_IDLE_EVICT_SECONDS", default=1800, ge=0)
    # Мягкий потолок числа людей в памяти: сверх него выгружаются самые давние, не дожидаясь срока (кроме тех, кого держит
    # сокет или незаписанное, и тех, кто обращался за последнюю минуту). 0 — без потолка.
    max_users_in_memory: int = Field(validation_alias="DIALOG_MAX_USERS_IN_MEMORY", default=0, ge=0)
    # Как часто проверять, кого выгрузить, и обновлять метрики памяти (agent_dialog_*_in_memory), секунды.
    evict_interval_seconds: int = Field(validation_alias="DIALOG_EVICT_INTERVAL_SECONDS", default=60, ge=1, le=3600)
    # Автозавершение брошенных диалогов: открытый диалог без живого сокета и без активности столько секунд считается
    # конченным — ставится сводка и диалог уходит в память (извлечение/cognify). 0 — не завершать автоматически.
    idle_end_seconds: int = Field(validation_alias="DIALOG_IDLE_END_SECONDS", default=300, ge=0)
    # Срок хранения разговоров (add-mood-diary, D14): разговор, итог (и документ в Cognee через память) удаляются через столько
    # дней после последнего сообщения. Проход раз в час. 0 — хранить бессрочно (так на проде сейчас).
    retention_days: int = Field(validation_alias="DIALOG_RETENTION_DAYS", default=21, ge=0)
    # Сухой прогон: проход только считает (agent_dialogs_retention_would_delete) и ничего не удаляет. В первом выкате включён.
    retention_dry_run: bool = Field(validation_alias="DIALOG_RETENTION_DRY_RUN", default=True)
    # Сколько ждать модель при подведении итога разговора, секунды (add-mood-diary, D13).
    recap_timeout_seconds: float = Field(validation_alias="RECAP_TIMEOUT_SECONDS", default=20, gt=0, le=120)

    @model_validator(mode="after")
    def _pool_sizes_in_order(self) -> "DialogSettings":
        """Проверяет, что минимальный размер пула не превышает максимальный."""
        if self.db_pool_min_size > self.db_pool_max_size:
            raise ValueError("нужно DIALOG_DB_POOL_MIN_SIZE <= DIALOG_DB_POOL_MAX_SIZE")
        return self


class SpeechSettings(BaseAppSettings):
    """Озвучка фиксированных фраз и звук клиенту (specs/speech-pipeline).

    Фразы (приветствие, кризисный ответ, просьба повторить) озвучивает тот же голос Gemini Live (`GeminiLiveTts`, app/clients/
    gemini_live.py) и запоминает их: клиент ждёт `tts_start` приветствия не дольше 0,9 с, а новая сессия Gemini открывается
    около секунды. Голос ответов модели — `GEMINI_LIVE_VOICE_*`.
    """

    # Голос по роду, `male` или `female`, у тех, кто ещё не выбирал.
    default_voice: Literal["male", "female"] = Field(validation_alias="TTS_DEFAULT_VOICE", default="male")
    tts_frame_interval_ms: int = Field(validation_alias="TTS_FRAME_INTERVAL_MS", default=100, ge=0)
    # Сколько озвученных фраз помнить (по ним же прогреваются приветствия); 0 выключает память.
    tts_cache_items: int = Field(validation_alias="TTS_CACHE_ITEMS", default=64, ge=0)


class BackgroundModelSettings(BaseAppSettings):
    """Фоновая модель: текстовая модель прокси программы (LiteLLM, OpenAI-совместимый) для задач вне голосового пути — итоги
    разговоров, итоги недели, заметки памяти. Голос ведёт Gemini Live, этой моделью агент с человеком не говорит.

    Имена переменных прежние (`LLM_*`, `AGENT_API_TOKEN`): они относятся к фоновой модели, а не к голосу. Нужны
    `AGENT_API_TOKEN` (ключ прокси; принадлежит только агенту) и `LLM_BASE_URL`; без них модели нет: итоги не подводятся,
    заметки не извлекаются, итоги недели отвечают `DIGEST_UNAVAILABLE`, разговор идёт как обычно.
    """

    base_url: str | None = Field(validation_alias="LLM_BASE_URL", default=None)
    api_key: SecretStr | None = Field(validation_alias="AGENT_API_TOKEN", default=None)
    # Русскоязычная модель Сбера: ответ короткий и тёплый (подходит для итога разговора).
    chat_model: str = Field(validation_alias="LLM_CHAT_MODEL", default="gigachat3.5-432b-a28b")
    # Дольше ждать ответ нет смысла: после таймаута итог не подводится (его можно завести вручную).
    timeout_seconds: int = Field(validation_alias="LLM_TIMEOUT_SECONDS", default=15, ge=1)
    max_tokens: int = Field(validation_alias="LLM_MAX_TOKENS", default=200, ge=16)
    temperature: float = Field(validation_alias="LLM_TEMPERATURE", default=0.7, ge=0, le=2)


class GeminiSettings(BaseAppSettings):
    """Gemini Live: речь в речь по WebSocket через SDK google-genai, единственный голосовой путь агента.

    Без `GEMINI_API_KEY` сервис не стартует. Из России Google отвечает «User location is not supported»: тогда
    `GEMINI_BASE_URL` указывает на прослойку в поддерживаемой стране (WebSocket-релей к generativelanguage.googleapis.com).
    """

    api_key: SecretStr | None = Field(validation_alias="GEMINI_API_KEY", default=None)
    # Адрес Gemini API (https://… или http://…, SDK сам берёт wss://… для Live). Пусто — напрямую в Google.
    base_url: str | None = Field(validation_alias="GEMINI_BASE_URL", default=None)
    # Токен релея (agent/relay): уходит заголовком X-Relay-Token на GEMINI_BASE_URL, релей без него отвечает 403.
    relay_token: SecretStr | None = Field(validation_alias="GEMINI_RELAY_TOKEN", default=None)
    live_model: str = Field(validation_alias="GEMINI_LIVE_MODEL", default="gemini-3.8-live")
    # Голос выбирается по роду (`male`/`female`) или по имени из профиля (app/core/voices.py); названия — встроенные голоса Gemini.
    voice_male: str = Field(validation_alias="GEMINI_LIVE_VOICE_MALE", default="Charon")
    voice_female: str = Field(validation_alias="GEMINI_LIVE_VOICE_FEMALE", default="Kore")
    connect_timeout_seconds: int = Field(validation_alias="GEMINI_CONNECT_TIMEOUT_SECONDS", default=15, ge=1)
    # Сколько ждать расшифровку реплики, прежде чем отдать человеку ответ: до этого момента агент проверяет реплику на кризис.
    transcript_wait_ms: int = Field(validation_alias="GEMINI_TRANSCRIPT_WAIT_MS", default=1000, ge=0, le=5000)
    # Подсказка языка расшифровки речи человека (коды BCP-47 через запятую). Без неё Gemini определяет язык сам, и короткое
    # слово («устала») расшифровывается как испанское или английское, а ошибочная расшифровка попадает в историю и
    # закрепляет чужой язык. Пусто — подсказка не отправляется.
    input_languages: str = Field(validation_alias="GEMINI_INPUT_LANGUAGES", default="ru-RU")
    # Ответ, от которого нет событий дольше этого, считается оборванным.
    idle_timeout_seconds: int = Field(validation_alias="GEMINI_IDLE_TIMEOUT_SECONDS", default=15, ge=1)
    # Модель промолчала на голосовую реплику (ход без звука и текста): столько ждём, не продолжит ли человек, прежде чем
    # попросить модель ответить в свежей сессии. В проде так молчали ~8% ходов, и человек часто продолжал через 2–6 с.
    silence_nudge_ms: int = Field(validation_alias="GEMINI_SILENCE_NUDGE_MS", default=2000, ge=0, le=10000)
    # Сколько последних сообщений диалога модель получает текстом при новой сессии (после смены сессии, переподключения и смены
    # голоса). 0 — весь диалог.
    history_messages: int = Field(validation_alias="GEMINI_HISTORY_MESSAGES", default=40, ge=0)
    # Экономия на контексте: Gemini оплачивает весь контекст сессии на каждый ход, а голос человека и ответа копится в нём
    # аудио-токенами (на стенде +300 токенов на ход, аудио дороже текста). Поэтому агент меняет сессию на свежую и кладёт в неё
    # прошлые реплики текстом (history_config.initial_history_in_client_content): аудио в контексте остаётся только текущей
    # реплики, а память о разговоре сохраняется. Старая сессия закрывается. Возобновления сессии по handle нет (handle вернул бы
    # накопленное аудио), сжатие контекста остаётся страховкой на случай очень длинной истории.
    # Как часто менять сессию. Каждое открытие Google считает в лимите токенов в минуту (TPM) целиком (промпт + история), а ход
    # в уже открытой сессии — только приращением (замер 13.10: 8 диалогов × 8 ходов, смена каждый ход ≈ 1,95K токенов TPM на
    # ход, раз в 4 хода ≈ 0,7K, без смены ≈ 0,36K). Зато накопленное аудио оплачивается заново на каждый ход, поэтому сессию
    # меняем не каждый ход, а когда прошло столько ходов или аудио в контексте дошло до GEMINI_ROTATE_AUDIO_TOKENS. 1 — после
    # каждого ответа.
    rotate_every: int = Field(validation_alias="GEMINI_ROTATE_EVERY", default=4, ge=1, le=100)
    # Порог «долга аудио»: input_audio последнего хода на текущей сессии (usage_metadata). Длинные реплики копят аудио быстрее
    # четырёх коротких, и сессию тогда меняем раньше. 0 — смотреть только на число ходов.
    rotate_audio_tokens: int = Field(validation_alias="GEMINI_ROTATE_AUDIO_TOKENS", default=1500, ge=0)
    # «Размышление» модели перед ответом (токены): -1 (по умолчанию) — параметр не отправляется, решает Google; 0 — выключено
    # (замер на gemini-3.8-live: первый звук на ~0,2 с быстрее, ответы короткие и тёплые, рассуждать нечем); >0 — предел.
    # Кризисы модель не решает: их ловит агент.
    thinking_budget: int = Field(validation_alias="GEMINI_THINKING_BUDGET", default=-1, ge=-1)
    # Цвет шарика по тону человека (REQ-VOICE-10): отдельный запрос к текстовой модели по расшифровке реплики (имя модели).
    # Включён по умолчанию, работает с ключом Gemini; пустое имя отключает. Идёт параллельно ответу и
    # ему не мешает; вызов функции внутри сессии Live замерен и отвергнут (ответ терялся).
    mood_classifier: str = Field(validation_alias="GEMINI_MOOD_CLASSIFIER", default="gemini-3.5-flash-lite")
    mood_classifier_timeout_seconds: float = Field(validation_alias="GEMINI_MOOD_CLASSIFIER_TIMEOUT_SECONDS", default=2.5, gt=0)
    # Пауза без новых слов расшифровки, после которой реплика уходит на классификацию.
    mood_debounce_ms: int = Field(validation_alias="GEMINI_MOOD_DEBOUNCE_MS", default=300, ge=0)
    # Длинный разговор: когда контекст сессии подходит к пределу, Google сам сжимает его скользящим окном (самое старое
    # уходит, начало разговора и промпт остаются), и сессия не обрывается. Сжатие включено всегда: без него голосовая сессия
    # живёт ~15 минут. Ниже — пороги сжатия.
    # При каком размере контекста (токены) сжимать; 0 — решает Google (около 80% окна модели).
    compression_trigger_tokens: int = Field(validation_alias="GEMINI_COMPRESSION_TRIGGER_TOKENS", default=0, ge=0)
    # До какого размера сжимать (токены); 0 — решает Google.
    compression_target_tokens: int = Field(validation_alias="GEMINI_COMPRESSION_TARGET_TOKENS", default=0, ge=0)
    # Лимит входных токенов в минуту (TPM) проекта Google: агент сам ведёт окно в 60 с по usage_metadata ходов
    # (app/services/gemini_budget.py) и только меряет его (метрики, журнал); поведение разговоров окно не меняет. 0 — учёт
    # выключен целиком. Прод (Tier 2): 400000.
    tpm_limit: int = Field(validation_alias="GEMINI_TPM_LIMIT", default=0, ge=0)
    # Начальная пауза после отказа Google по квоте (1011), с: растёт вдвое с каждой новой ошибкой до 60 с, сбрасывается после
    # удачных ходов. В паузе новые сессии Gemini не открываются (открытие заведомо получит тот же отказ); 0 — паузы нет.
    quota_cooldown_seconds: float = Field(validation_alias="GEMINI_QUOTA_COOLDOWN_SECONDS", default=5, ge=0, le=60)
    # Открытие сессии Google считает в TPM сразу, по размеру контекста и щедрее настоящих токенов (эксперимент: ≈ байты UTF-8
    # системной инструкции и истории / 4). Оценка открытия = байты / 4 × этот коэффициент; 0 — открытия не считать.
    tpm_open_factor: float = Field(validation_alias="GEMINI_TPM_OPEN_FACTOR", default=1.0, ge=0, le=10)

    @property
    def input_language_codes(self) -> list[str]:
        """Коды языков расшифровки из `GEMINI_INPUT_LANGUAGES`: без пустых и повторов."""
        codes = [code.strip() for code in self.input_languages.split(",")]
        return list(dict.fromkeys(code for code in codes if code))


class MemorySettings(BaseAppSettings):
    """Память агента о человеке (`app/memory/`): заметки в PostgreSQL (слой 1) и поиск по прошлым разговорам в Cognee (слой 2).

    Включена ли память у человека и согласие хранятся в базе агента (`memory_settings`), а не в окружении: пауза переживает
    перезапуск. Заметки извлекаются по ходу разговора всегда, когда есть фоновая модель и память включена у человека. Вызовы
    Cognee — REST с Bearer сервисного пользователя.
    """

    # Адрес Cognee API и сервисный пользователь (multi-user access control — вызовы с Bearer).
    cognee_base_url: str | None = Field(validation_alias="COGNEE_BASE_URL", default=None)
    cognee_email: str | None = Field(validation_alias="COGNEE_SERVICE_EMAIL", default=None)
    cognee_password: SecretStr | None = Field(validation_alias="COGNEE_SERVICE_PASSWORD", default=None)
    # Заметки о человеке (слой 1, PROTEUS-242): лимит живых заметок на человека. Срока давности у заметок нет.
    notes_max: int = Field(validation_alias="MEMORY_NOTES_MAX", default=200, ge=1)
    # Сколько токенов блока памяти уходит в голосовую модель.
    brief_max_tokens: int = Field(validation_alias="MEMORY_BRIEF_MAX_TOKENS", default=1200, ge=100)
    # Модель извлечения заметок по ходу разговора (по умолчанию LLM_CHAT_MODEL).
    notes_model: str | None = Field(validation_alias="MEMORY_NOTES_MODEL", default=None)
    # UUID через запятую: если задан, включить память могут только эти люди (закрытая бета).
    allowlist: str = Field(validation_alias="MEMORY_ALLOWLIST", default="")

    @property
    def allowed_users(self) -> frozenset[str]:
        return frozenset(item.strip().lower() for item in self.allowlist.split(",") if item.strip())


class MemoryReclaimSettings(BaseAppSettings):
    """Возврат памяти процесса системе (app/core/reclaim.py).

    После нагрузки память процесса не опускалась: освобождённое Python и glibc держат у себя, а остатки закрытых соединений
    ждут редкой полной сборки мусора. Раз в `MEMORY_RECLAIM_SECONDS` агент собирает мусор и отдаёт свободные страницы кучи
    системе (`malloc_trim`, только Linux с glibc; в других ОС этот шаг пропускается).
    """

    # Как часто возвращать память, секунды. 0 — не возвращать (заморозка стартовых объектов для сборщика остаётся).
    seconds: int = Field(validation_alias="MEMORY_RECLAIM_SECONDS", default=60, ge=0)


class LangfuseSettings(BaseAppSettings):
    """Langfuse (self-hosted, ns `infra`, тот же RU-кластер, что и БД диалогов): трейсинг LLM-ходов и приёмник расхода моделей.

    По умолчанию всё выключено: агент работает как раньше (NullTracer, приёмника нет). При `LANGFUSE_ENABLED=true`
    оба ключа обязательны — без них сервис не стартует (fail-fast). Ключи проекта (pk-lf/sk-lf) лежат в Secret
    `agent-secrets`, в ConfigMap их быть не должно.

    Трейсинг (`app/core/tracing.py`): трасса на каждый ход. `LANGFUSE_TRACE_TEXT=false` (по умолчанию) — уходят число символов
    и слов, длительность речи, токены и задержки, сами тексты маскируются; `true` — тексты реплик людей и агента уходят в
    Langfuse, только для локальной отладки (в проде нельзя).

    Приёмник расхода (`app/services/langfuse_usage.py`, README «Расход моделей»): только числа, без текстов, отдельная трасса
    `model-usage`. Расход ходов уже есть в трассах трейсинга, поэтому приёмник включается отдельно (`LANGFUSE_USAGE_SINK=true`):
    при включённых обоих расход в Langfuse задвоится.
    """

    enabled: bool = Field(validation_alias="LANGFUSE_ENABLED", default=False)
    host: str = Field(validation_alias="LANGFUSE_HOST", default="http://langfuse-web.infra.svc.cluster.local:3000")
    public_key: SecretStr | None = Field(validation_alias="LANGFUSE_PUBLIC_KEY", default=None)
    secret_key: SecretStr | None = Field(validation_alias="LANGFUSE_SECRET_KEY", default=None)
    trace_text: bool = Field(validation_alias="LANGFUSE_TRACE_TEXT", default=False)
    usage_sink: bool = Field(validation_alias="LANGFUSE_USAGE_SINK", default=False)
    flush_seconds: float = Field(validation_alias="LANGFUSE_FLUSH_SECONDS", default=5, ge=0.2, le=60)
    timeout_seconds: int = Field(validation_alias="LANGFUSE_TIMEOUT_SECONDS", default=5, ge=1, le=30)

    @model_validator(mode="after")
    def _keys_required_when_enabled(self) -> "LangfuseSettings":
        if self.enabled and not (self._key(self.public_key) and self._key(self.secret_key)):
            raise ValueError("LANGFUSE_ENABLED=true, но не заданы LANGFUSE_PUBLIC_KEY и LANGFUSE_SECRET_KEY")
        host = self.host.strip()
        if host and not host.startswith(("http://", "https://")):
            raise ValueError("LANGFUSE_HOST должен начинаться с http:// или https://")
        return self

    @staticmethod
    def _key(value: SecretStr | None) -> str:
        return value.get_secret_value().strip() if value is not None else ""

    @property
    def usage_sink_active(self) -> bool:
        """Приёмник расхода работает, только если включён Langfuse и отдельно приёмник."""
        return bool(self.enabled and self.usage_sink and self.host.strip())


class Config:
    """Агрегатор доменных настроек. Неизменяемый синглтон — не мутировать."""

    app: AppSettings = AppSettings()
    security: SecuritySettings = SecuritySettings()
    dialog: DialogSettings = DialogSettings()
    speech: SpeechSettings = SpeechSettings()
    background_model: BackgroundModelSettings = BackgroundModelSettings()
    gemini: GeminiSettings = GeminiSettings()
    langfuse: LangfuseSettings = LangfuseSettings()
    memory: MemorySettings = MemorySettings()
    memory_reclaim: MemoryReclaimSettings = MemoryReclaimSettings()


APP_CONFIG = Config()
