# agent/: правила кода

Общие правила репозитория — в корневом `AGENTS.md`. Здесь — как устроен код агента (Python 3.12, FastAPI, uv);
запуск и проверки — скилл `local-dev`.

## Конфигурация

- Переменные окружения читает только `app/core/config.py`; `os.environ` и `os.getenv` в остальном коде не используются.
- Настройки — доменные классы на `BaseAppSettings` (`DialogSettings`, `GeminiSettings`, `BackgroundModelSettings`,
  `LangfuseSettings` и т. д.),
  у каждого поля `Field(validation_alias="ИМЯ_ПЕРЕМЕННОЙ", default=…)`; секреты — `SecretStr`.
- Ошибка в конфиге роняет старт сразу (fail-fast): обязательные поля без умолчания, согласованность значений —
  `@model_validator(mode="after")` в классе настроек.
- Код берёт настройки из синглтона `APP_CONFIG`, а не читает env сам. Производные значения — `@property` в классе
  настроек, не отдельные переменные.
- Новая переменная — поле в своём доменном классе, строка в `agent/.env.example` и, если нужна в проде, ключ в
  `k8s/agent/00-config.yaml` (секрет — в Secret, в репозитории только его имя).
- Тесты задают env в `tests/conftest.py` до импорта приложения: конфиг читается при импорте.

## Логи

- Стандартный `logging`: `logger = logging.getLogger("agent.<область>")` в модуле; формат и уровень задаёт
  `main.py` (`logging.basicConfig`, уровень из `APP_CONFIG`). Вывод — stdout, в кластере его собирает Loki.
- Тексты реплик, почта, имена и другие личные данные в лог не пишутся: только идентификаторы (`user_id`,
  `dialog_id`), длительности, размеры и счётчики. То же в Langfuse: тексты туда не уходят никогда, маскируются в
  `app/core/tracing.py`.
- Метрики — Prometheus, `app/core/metrics.py`; имена `agent_*`.

## Заголовки трассировки

api передаёт агенту пять заголовков (`x-trace-id`, `x-request-time`, `x-client-id`, `x-session-id`, `x-user-id`),
но агент их сейчас не читает и в логи не пишет. Связь между сервисами — по `user_id` и `dialog_id` из пути запроса.

## Прочее

- Комментарии и докстринги — по-русски, о причинах, а не пересказ кода.
- Тесты — pytest без сети и моделей: подделка Gemini Live — `tests/fake_live.py`, подделки озвучки и фоновой модели — в
  `tests/conftest.py`, база — `tests/fake_db.py`. Приложение в тесте собирают `make_app` и `make_client` из `tests/conftest.py`;
  сквозные сценарии клиента — `tests/test_live_scenarios.py` (известные недостатки Live там — `xfail(strict=True)` с причиной
  «ИЗВЕСТНО: …»). Голосового каскада в агенте нет.
