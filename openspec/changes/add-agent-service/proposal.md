# Proposal: add-agent-service

## Why

В монорепо распланирован backend (5 change'ов: фундамент/auth, сессии/стриминг, профиль, журнал/ритуалы, контент), но вся «думалка» продукта — конвейер реплики (ASR → кризис-классификатор → эмоции → retrieval памяти → LLM → TTS) — пока вписана внутрь backend в change add-backend-sessions-streaming. Под логику агента в k8s уже выделен namespace `agent`, а для LLM получен OpenAI-совместимый ключ с моделями в Cloud.ru (данные в РФ, 152-ФЗ) — вместо GigaChat из первоначального стека. Выносим конвейер реплики в отдельный сервис `agent/`: независимое масштабирование LLM/ASR/TTS нагрузки, изоляция ПДн-обработки и возможность развивать промпты/граф без редеплоя backend.

## What Changes

- **Новый сервис `agent/`** в корне монорепо (Python 3.12, FastAPI, LangGraph): весь конвейер обработки реплики — приём аудио/текста от backend, ASR-стриминг (SaluteSpeech), двухступенчатый кризис-классификатор (высокий recall, `level=red` перекрывает любой режим), классификатор эмоций, retrieval памяти (pgvector + вес давности + «время с последней сессии»), генерация ответа стримом, TTS-стриминг (кэш ритуалов/типовых фраз).
- **LLM — OpenAI-совместимый API на Cloud.ru** (Evolution Foundation Models): чат-стриминг для генерации, дешёвая модель для классификаторов (кризис, эмоции), эмбеддинги для retrieval. Ключ — через секреты k8s (`<CHANGE_ME_*>` плейсхолдеры в git). GigaChat из стека заменяется этим провайдером.
- **LangGraph-граф диалога**: ноды конвейера как граф состояний — режимы `vent`/`chat`/`gestalt_diary`/`recovery`/`rituals` как ветвления промптов и инструментов, кризисная ветвь с приоритетом над всем, инкогнито-режим (без записи в память).
- **Внутренний HTTP API** для backend: стриминговый эндпоинт обработки реплики (SSE/stream: `transcript.*`, `safety.status`, `llm.token/done`, `tts.chunk`, `crisis.intervention`), health/version. Сервис не публикуется наружу — только cluster-internal, авторизация по внутреннему токену.
- **PII-фильтрация (NER)** перед вызовами внешних моделей; Langfuse-трейсинг каждого вызова; деградация в текстовый режим при отказе голосовой цепочки (ASR/TTS), circuit breaker + retry/backoff на все внешние вызовы.
- **Каркас по проектным правилам**: конфиг по env-config-rules, логирование по logging-rules, middleware заголовков по api-headers-rules (проброс rqUId от backend), единый формат ошибок `{"error":{code,message,details}}`.
- **Деплой в ns `agent`**: Dockerfile (multi-stage, uv), k8s-манифесты (Deployment, Service, imagePullSecrets `registry-pull`, образ `cr.yandex/crpsqeamqpuvrkm5tpr9/agent/...`), без HTTPRoute наружу.

**Координация с add-backend-sessions-streaming**: конвейер реплики и интеграции GigaChat/SaluteSpeech выносятся из backend в agent — backend остаётся транспортом (WebSocket/SSE, лимиты канала, reconnect) и вызывает agent по HTTP. Соответствующие design/tasks того change'а будут пересмотрены отдельно (openspec-update-change); требования specs `streaming` по внешнему WS-протоколу не меняются.

Вне scope: консолидация памяти L2/L3 (отдельный change), фоновая суммаризация сессий (остаётся Celery-задачей backend, может вызывать agent), ClickHouse, адаптер под других LLM-провайдеров сверх OpenAI-совместимого интерфейса.

## Capabilities

### New Capabilities

- `agent-core`: оркестрация диалога на LangGraph — конвейер реплики, режимы диалога, кризисный протокол с приоритетом, классификатор эмоций, retrieval памяти, стрим-генерация через OpenAI-совместимый API (Cloud.ru), PII-фильтрация, инкогнито.
- `speech-pipeline`: голосовая цепочка агента — ASR-стриминг (SaluteSpeech) с partial/final транскриптами, TTS-стриминг с кэшем типовых фраз, деградация в текстовый режим при отказе голосовых компонентов.
- `agent-api`: внутренний HTTP-контракт backend → agent — стриминговая обработка реплики с типизированными событиями, авторизация внутренним токеном, health/version, таймауты и коды ошибок, проброс трассировки (rqUId, Langfuse).

### Modified Capabilities

(пусто — утверждённых specs в openspec/specs/ пока нет; пересмотр change add-backend-sessions-streaming выполняется отдельно через его собственные артефакты)

## Impact

- **Новый код**: директория `agent/` в корне монорепо — `app/` (api, graph/ноды, services, clients, core), `tests/`, `Dockerfile`, `pyproject.toml`.
- **API**: внутренний HTTP API agent (не входит в docs/openapi.yaml — он для публичного API; контракт фиксируется в specs `agent-api`).
- **Инфраструктура**: namespace `agent` в k8s twc-sber500 (доступ уже выдан по ONBOARDING.md), новые образы в cr.yandex/crpsqeamqpuvrkm5tpr9/agent/, секрет `agent-llm-key` (Cloud.ru).
- **Зависимости**: LangGraph + openai SDK (новые для монорепо), SaluteSpeech (переезжает из планов backend), pgvector (БД backend, чтение памяти), Redis (кэш TTS, буферы), Langfuse.
- **Существующие change'ы**: add-backend-sessions-streaming — вынос конвейера (openspec-update-change после утверждения этого change'а); стек в openspec/config.yaml — GigaChat заменяется на OpenAI-совместимый API Cloud.ru (обновление контекста).
