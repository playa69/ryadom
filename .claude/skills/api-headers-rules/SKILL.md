---
name: api-headers-rules
description: Архитектурные правила обязательных HTTP-заголовков API (x-trace-id/rqUId, x-request-time, x-client-id, x-session-id, x-user-id) — извлечение в middleware, хранение в ContextVars, прокидывание в исходящие запросы. Паттерн из usecase-agent/orchestrator (aigw).
whenToUse: Когда пишешь или правишь API-эндпоинты, middleware, HTTP-клиенты к внешним сервисам, или ревьюишь код на предмет сквозной трассировки запросов
---

# Правила обязательных API-заголовков

Паттерн выработан в проектах `usecase-agent` (aigw_service) и `orchestrator` (aigw). Все сервисы монорепо обязаны ему следовать.

## Белый список заголовков

Сервис принимает и обрабатывает ТОЛЬКО эти заголовки (остальные в логи не попадают):

| Заголовок | ContextVar | Поле в логе | Назначение |
|---|---|---|---|
| `x-trace-id` | `x_trace_id_var` | `rqUId` | Сквозной ID запроса — связь логов всех сервисов |
| `x-request-time` | `x_request_time_var` | `rqTime` | Время запроса от вызывающей стороны |
| `x-client-id` | `x_client_id_var` | `systemId` | Идентификатор системы-клиента |
| `x-session-id` | `x_aigw_session_id_var` | `gwSessionId` | Сессия диалога на гейтвее |
| `x-user-id` | `x_user_id_var` | `userId` | Идентификатор пользователя |

## Железные правила

1. **Сервис НЕ генерирует `rqUId` сам.** `rqUId` всегда принимается извне из `x-trace-id`. Если заголовка нет — запрос обрабатывается, но без `rqUId` в логах.
2. **Извлечение — только в middleware**, один раз на входе. Дальше по коду заголовки не читаются и не прокидываются аргументами — только через `ContextVarsContainer`.
3. **Каждый исходящий HTTP-запрос обязан** нести все 5 заголовков с текущими значениями из ContextVars — иначе downstream-логи не свяжутся.
4. **Нельзя хардкодить** значения заголовков — только из контекста.

## Паттерн реализации

### 1. Middleware извлекает заголовки (`api/middleware.py`)

```python
HEADERS_WHITE_LIST_TO_LOG = (
    "x-trace-id",
    "x-request-time",
    "x-client-id",
    "x-session-id",
    "x-user-id",
)

async def log_requests(request: Request, call_next):
    allowed = ((k, request.headers.get(k)) for k in HEADERS_WHITE_LIST_TO_LOG)
    headers_to_log = {k: v for k, v in allowed if v}

    APP_CTX.get_context_vars_container().set_context_vars(
        x_trace_id=headers_to_log.get("x-trace-id", ""),
        x_request_time=headers_to_log.get("x-request-time", ""),
        x_client_id=headers_to_log.get("x-client-id", ""),
        x_aigw_session_id=headers_to_log.get("x-session-id", ""),
        x_user_id=headers_to_log.get("x-user-id", ""),
    )
```

### 2. ContextVars хранит значения (`logger/context_vars.py`)

```python
from contextvars import ContextVar

class ContextVarsContainer:
    def __init__(self):
        self.x_trace_id_var = ContextVar("rquid", default=None)
        self.x_request_time_var = ContextVar("rqtm", default=None)
        self.x_client_id_var = ContextVar("systemId", default=None)
        self.x_aigw_session_id_var = ContextVar("gwSessionId", default=None)
        self.x_user_id_var = ContextVar("userId", default=None)
```

`ContextVar` даёт доступ из любого async-кода запроса без явной передачи аргументов.

### 3. Исходящие запросы (HTTP-клиенты, коннекторы)

```python
headers = {
    "x-trace-id": APP_CTX.get_context_vars_container().context_vars.rqUId or "",
    "x-request-time": APP_CTX.get_context_vars_container().context_vars.rqTime or "",
    "x-client-id": APP_CTX.get_context_vars_container().context_vars.systemId or "",
    "x-session-id": APP_CTX.get_context_vars_container().context_vars.gwSessionId or "",
    "x-user-id": APP_CTX.get_context_vars_container().context_vars.userId or "",
}
```

### 4. Фоновые задачи (вне HTTP-контекста)

`ContextVar` в фоновом потоке/task пуст. Привязывать явно при старте фоновой работы:

```python
logger.bind(rqUId=сохранённое_значение)
```

## Что нельзя делать

- Генерировать новый `rqUId` внутри сервиса (uuid4 и т.п.) — это ломает сквозную трассировку.
- Прокидывать `rqUId` аргументами функций через слои — только ContextVars.
- Логировать заголовки вне белого списка (Authorization, cookie и т.п.) — риск утечки секретов.
- Читать `request.headers` в бизнес-логике — только middleware.

## Референсы с реальным кодом

Файлы из боевых проектов, читай при необходимости деталей:

- `${KIMI_SKILL_DIR}/references/middleware-usecase.py` — middleware usecase-agent целиком (извлечение заголовков, логирование запроса/ответа, метрики, аудит)
- `${KIMI_SKILL_DIR}/references/middleware-orchestrator.py` — middleware оркестратора (маскирование, SSE, JSON-RPC id override)
- `${KIMI_SKILL_DIR}/references/context_vars.py` — `ContextVarsContainer` с ContextVar'ами
- `${KIMI_SKILL_DIR}/references/rest-connector-outgoing-headers.py` — исходящий HTTP-коннектор: прокидывание `x-trace-id` в downstream (см. строку с `headers = {**headers, "x-trace-id": rq_uid}`)
