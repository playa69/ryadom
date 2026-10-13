---
name: logging-rules
description: Архитектурные правила формирования логов — loguru + ContextVars + patcher, JSON-модели Log/Metric/Event, три файловых sink'а (app.log, app-metric.log, events.log), маскирование PII, правила для фоновых задач и эндпоинтов-исключений. Паттерн из usecase-agent/orchestrator (aigw logger).
whenToUse: Когда пишешь логирование в сервисе, добавляешь метрики/аудит-события, настраиваешь loguru, или ревьюишь чистоту и формат логов
---

# Правила формирования логов

Паттерн из `usecase-agent` (`aigw_service/logger/`) и `orchestrator` (`aigw/logger/`). Стек: **loguru** + `ContextVars` + патчер записей.

## Три типа логов — три файла

| Тип | Файл (env) | Когда пишется |
|---|---|---|
| Обычный лог | `app.log` (`LOG_PATH`/`LOG_FILE_NAME`) | Все сообщения приложения |
| Метрики | `app-metric.log` (`METRIC_PATH`/`METRIC_FILE_NAME`) | Счётчики запросов/ответов, duration |
| Аудит | `events.log` (`AUDIT_LOG_PATH`/`AUDIT_LOG_FILE_NAME`) | Бизнес-события (`BusinessRequestReceived`, `BusinessRequestFinished`) |

Ротация — `LOG_ROTATION` (дефолт `10 MB`). Уровень — `DEBUG` env (`DEBUG=true` → DEBUG, иначе INFO).

## Поток записи лога

```
middleware (заголовки → ContextVars)
    ↓
код пишет logger.info("...", target=...) 
    ↓
LoguruPatcher: подмешивает контекст из ContextVars в каждую запись
    ↓
сериализация в JSON-модель (Log / Metric / Event) → sink
```

### LoguruPatcher (`logger/logger.py`)

Патчер обогачает КАЖДУЮ запись полями контекста — руками их нигде не передаём:

```python
class LoguruPatcher:
    def patching(self, record: dict):
        ctx = self.context_vars_container.context_vars
        # Fallback: фоновый поток без ContextVar, но с явным bind
        if not ctx.rqUId and record["extra"].get("rqUId"):
            ctx.rqUId = record["extra"]["rqUId"]

        target = record["extra"].get("target")
        if target == "metric":
            log_record = Metric(rqUId=ctx.rqUId, metric_name=..., metric_value=...)
        elif target == "audit-event":
            log_record = Event(name=..., createdAt=int(time() * 1000), params=[...])
        else:
            log_record = Log(levelName=..., asctime=..., moduleName=..., funcName=...,
                             message=..., rqUId=ctx.rqUId, rqTime=ctx.rqTime,
                             systemId=ctx.systemId, gwSessionId=ctx.gwSessionId,
                             userId=ctx.userId, args=...)
        record["extra"]["serialized"] = dataclass_as_json_str(log_record)
```

## Форматы вывода

**Консоль (stdout):** тот же JSON, что и в `app.log` (`{extra[serialized]}`), по всем target'ам (log/metric/audit) — в k8s stdout забирает сборщик логов (Alloy → Loki), поэтому человекочитаемый текст в stdout не пишем.

Стандартный `logging` (uvicorn и пр.) перехватывается `InterceptHandler`'ом на root-логгере и тоже уходит в loguru → JSON. Access-лог uvicorn отключается через `--log-config` (логгеры `uvicorn.*` без handlers, `uvicorn.access` на WARNING): запросы логирует middleware с rqUId и исключениями служебных эндпоинтов, дубли не нужны.

**app.log (JSON, одна строка = одна запись):**
```json
{"levelName":"INFO","asctime":"...","moduleName":"...","funcName":"...","message":"...","rqUId":"trace-abc-123","rqTime":"...","systemId":"...","gwSessionId":"...","userId":"...","args":null}
```

**app-metric.log:**
```json
{"rqUId":"trace-abc-123","metric_name":"aigw_service_requests_total","metric_value":1}
```

**events.log:**
```json
{"name":"BusinessRequestReceived","createdAt":1713607339000,"params":[{"name":"request-Id","value":"trace-abc-123"}]}
```

## Как писать в коде

```python
# Обычный лог — ничего лишнего, контекст подмешается сам
logger.info("Запрос обработан")

# Метрика
logger.bind(target="metric", metric_name="aigw_service_process_duration_ms", metric_value=123).info("")

# Аудит
logger.bind(target="audit-event", audit_event_name="BusinessRequestFinished").info("")

# Фоновая задача (нет ContextVar) — явная привязка rqUId
logger.bind(rqUId=saved_rquid).info("Фоновая обработка")
```

## Маскирование — обязательно

- Тексты сообщений пользователей (`message.parts[].text`) → `"***"`.
- `message.metadata` → только список ключей `{"_keys": [...]}`.
- PII (email, телефоны, ИНН, ФИО) маскируются функциями `mask_pii_*` до записи в лог.
- Флаг `MASK_ENABLED` (дефолт `true`) выключается только для локальной отладки.
- Middleware логирует body запроса/ответа только в маскированном виде.

## Эндпоинты-исключения

Служебные эндпоинты полностью не логируются (шум):

```python
NON_LOGGED_ENDPOINTS = ("/like", "/dislike", "/health", "/info", "/openapi.json", "/docs", "/")
```

## Правила

1. **Контекст (rqUId и пр.) никогда не передаётся в `logger.*` руками** в HTTP-контексте — это работа патчера.
2. Warning/ошибки фреймворков и спам в логах — это баги кода, а не фон: чинить источник, а не глушить уровень.
3. Streaming/SSE-ответы: не трогать `body_iterator`, логировать без body.
4. Метрики и аудит — только через `bind(target=...)`, не писать их в обычный лог.
5. Каждое сообщение лога — осмысленное, на понятном языке, без дампов структур целиком.

## Референсы с реальным кодом

- `${KIMI_SKILL_DIR}/references/logger.py` — `LoguruPatcher` и `LoggerConfigurator` usecase-agent целиком (патчер, sink'и, ротация)
- `${KIMI_SKILL_DIR}/references/log-models.py` — датаклассы `ContextLog`, `Log`, `Metric`, `Event`/`EventParam`
- `${KIMI_SKILL_DIR}/references/logger-utils.py` — утилиты сериализации (`dataclass_as_json_str` и пр.)
- `${KIMI_SKILL_DIR}/references/uvicorn_logging_config.py` — конфиг логов uvicorn, чтобы его записи шли в том же формате
- `${KIMI_SKILL_DIR}/references/request-trace-orchestrator.py` — request trace оркестратора (трейсинг запроса по этапам)
