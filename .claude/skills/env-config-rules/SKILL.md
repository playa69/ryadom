---
name: env-config-rules
description: Архитектурные правила управления параметрами окружения — pydantic-settings BaseSettings с validation_alias на каждое поле, иерархия доменных Settings, агрегатор Config/APP_CONFIG, JSON-парсинг сложных типов, fail-fast валидация, feature flags, TLS. Паттерн из orchestrator (aigw/config.py).
whenToUse: Когда добавляешь новую настройку/env-переменную, создаёшь конфиг модуля, пишешь config.py сервиса или ревьюишь работу с переменными окружения
---

# Правила управления параметрами окружения

Паттерн из `orchestrator/src/aigw/config.py` и `usecase-agent`. Вся конфигурация сервиса — через типизированные pydantic-settings классы, никаких `os.getenv` по коду.

## Железные правила

1. **Никаких `os.environ` / `os.getenv` вне `config.py`.** Все env читаются в одном месте.
2. **Каждое поле — `Field(validation_alias="ENV_VAR_NAME", default=...)`** с дефолтом, кроме явно обязательных.
3. **Fail-fast:** некорректная конфигурация роняет сервис на старте, а не в рантайме (валидация путей, обязательных значений).
4. **Секреты не хардкодятся** и не попадают в дефолты (кроме пустых строк-заглушек).
5. Конфиг — **неизменяемый синглтон** `APP_CONFIG`, импортируется отовсюду, не пересоздаётся.

## Структура

```python
from dotenv import load_dotenv
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

load_dotenv()  # .env для локальной разработки

class BaseAppSettings(BaseSettings):
    """Базовые настройки, общие для всех доменов."""

    model_config = SettingsConfigDict(env_ignore_empty=True, enable_decoding=False)

    local: bool = Field(validation_alias="LOCAL", default=False)
    debug: bool = Field(validation_alias="DEBUG", default=False)
    tls_cert_filepath: str | None = Field(validation_alias="TLS_CERT_FILEPATH", default=None)
    key_filepath: str | None = Field(validation_alias="KEY_FILEPATH", default=None)
    ca_bundle_filepath: str | None = Field(validation_alias="CA_BUNDLE_FILEPATH", default=None)
```

- `env_ignore_empty=True` — пустая env-строка не затирает дефолт.
- TLS-сертификаты один набор на все интеграции, SSL-контекст собирается методом базового класса.

### Доменные настройки — наследники BaseAppSettings

По одному классу на домен: `AppSettings` (APP_HOST/APP_PORT/TIMEZONE), `LogSettings` (LOG_PATH/LOG_FILE_NAME/...), `GigaChatSettings`, `OrchestratorSettings`, `AdapterSettings`, `FeatureFlags`. Имена env — SCREAMING_SNAKE с префиксом домена (`GIGACHAT_TIMEOUT`, `A2A_SERVER_ENABLED`).

### Агрегатор Config + синглтон

```python
class Config:
    app: AppSettings = AppSettings()
    log: LogSettings = LogSettings()
    gigachat: GigaChatSettings = GigaChatSettings()
    flags: FeatureFlags = FeatureFlags()
    # ... доменные settings модулей подключаются сюда же

APP_CONFIG = Config()
```

В коде: `from aigw.config import APP_CONFIG` → `APP_CONFIG.gigachat.timeout`.

## Обработка сложных типов (dict/list из env)

Env — всегда строка. dict/list передаются JSON-строкой и парсятся валидатором с fallback на дефолт (битый JSON не роняет старт для опциональных полей):

```python
@field_validator("models", mode="before")
@classmethod
def validate_models_field(cls, value, info):
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            parsed = None
        if isinstance(parsed, dict):
            return parsed
    return cls.model_fields[info.field_name].get_default(call_default_factory=True)
```

Числа с ограничениями — через constraints: `Field(default=0.0, ge=0.0, le=2.0)`.

## Fail-fast валидация

```python
@field_validator("private_log_file_path")
@classmethod
def validate_path(cls, value: str) -> str:
    if not os.path.exists(value):
        raise ValueError(f"Path does not exist: {value}!")
    return value
```

Пути к сертификатам/логам проверяются на существование при инициализации — сервис без валидного конфига не стартует вообще.

## Feature flags

Включаемые модули — булевы флаги в отдельном `FeatureFlags`:

```python
class FeatureFlags(BaseAppSettings):
    a2a_server_enabled: bool = Field(default=True, validation_alias="A2A_SERVER_ENABLED")
    database_enabled: bool = Field(default=False, validation_alias="DATABASE_ENABLED")
    langfuse_enabled: bool = Field(default=False, validation_alias="LANGFUSE_ENABLED")
```

Код проверяет флаг, а не наличие env: `if APP_CONFIG.flags.database_enabled: ...`

## Зависимости при старте: `*_IS_HARD_HEALTH`

Для каждой внешней зависимости — флаг критичности её health-check при startup (паттерн usecase-agent):

| Переменная | Дефолт | Поведение |
|---|---|---|
| `GIGACHAT_IS_HARD_HEALTH` | `true` | GigaChat недоступен → приложение падает на старте |
| `PG_IS_HARD_HEALTH` | `true` | PostgreSQL недоступен → падение на старте |
| `LANGFUSE_IS_HARD_HEALTH` | `false` | Langfuse недоступен → стартуем без трейсинга |
| `IDP_IS_HARD_HEALTH` | `false` | IDP недоступен → деградация, но стартуем |

Правило: критичные для бизнес-функции зависимости — `hard` (лучше не стартовать, чем работать сломанным), наблюдаемость и опциональные интеграции — `soft` (стартуем с деградацией). При `hard=true` провал инициализации бросает `RuntimeError` и прерывает весь startup.

## Производные значения — @property, не env

URL'ы, SSL-контексты, уровни лога собираются property из базовых полей, а не заводятся отдельными env:

```python
@property
def base_url(self) -> str:
    return f"{self.protocol}://{self.host.strip()}:{self.port}{self.endpoint}"

@property
def log_lvl(self) -> int:
    return DEBUG if self.debug else INFO
```

## Что нельзя делать

- Читать env напрямую в бизнес-логике, роутерах, коннекторах.
- Заводить env без дефолта без необходимости; если обязательно — падать на старте с понятной ошибкой.
- Дублировать одно значение в нескольких env-переменных.
- Коммитить `.env` с реальными секретами — в репо только `.env.example` с плейсхолдерами.
- Мутировать `APP_CONFIG` в рантайме.

## Референсы с реальным кодом

- `${KIMI_SKILL_DIR}/references/config-orchestrator.py` — config.py оркестратора целиком: `BaseAppSettings`, доменные Settings, JSON-валидаторы, `FeatureFlags`, агрегатор `Config`/`APP_CONFIG`
- `${KIMI_SKILL_DIR}/references/config-usecase.py` — config.py usecase-agent (959 строк): расширенный вариант с настройками PostgreSQL, Langfuse, IDP, PKAP, semantic cache и флагами `*_IS_HARD_HEALTH`
