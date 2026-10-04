# Proposal: add-agent-service

## Why

В монорепо распланирован backend (5 change'ов: фундамент/auth, сессии/стриминг, профиль, журнал/ритуалы, контент), но вся «думалка» продукта — конвейер реплики (ASR → кризис-классификатор → эмоции → retrieval памяти → LLM → TTS) — пока вписана внутрь backend в change add-backend-sessions-streaming. Под логику агента в k8s уже выделен namespace `agent`, а для LLM получен OpenAI-совместимый ключ с моделями в Cloud.ru (данные в РФ, 152-ФЗ) — вместо GigaChat из первоначального стека. Выносим конвейер реплики в отдельный сервис `agent/`: независимое масштабирование LLM/ASR/TTS нагрузки, изоляция ПДн-обработки и возможность развивать промпты/граф без редеплоя backend.

## What Changes

- **Новый сервис `agent/`** в корне монорепо (Python 3.12, FastAPI, LangGraph): весь конвейер обработки реплики — приём аудио/текста от вызывающей стороны (шлюз), ASR-стриминг (SaluteSpeech), двухступенчатый кризис-классификатор (высокий recall, `level=red` перекрывает любой режим), классификатор эмоций, retrieval памяти (pgvector + вес давности + «время с последнего диалога»), генерация ответа стримом, TTS-стриминг (кэш ритуалов/типовых фраз, приветствие). Agent также владеет диалогами: хранит сообщения, сводки и память в собственной БД `agent`, проверяет принадлежность диалога пользователю и стирает данные по `DELETE /v1/users/{userId}`.
- **LLM — OpenAI-совместимый API на Cloud.ru** (Evolution Foundation Models): чат-стриминг для генерации, дешёвая модель для классификаторов (кризис, эмоции), эмбеддинги для retrieval. Ключ — через секреты k8s (`<CHANGE_ME_*>` плейсхолдеры в git). GigaChat из стека заменяется этим провайдером.
- **LangGraph-граф диалога**: ноды конвейера как граф состояний — режимы `vent`/`chat`/`gestalt_diary`/`recovery`/`rituals` как ветвления промптов и инструментов, кризисная ветвь с приоритетом над всем; инкогнито-режим (без записи в память) — когда у приложения появится экран для него. В контракте v1 передаётся только один режим (`vent`).
- **Внутренний API для вызывающей стороны**: диалог как ресурс agent — REST (`POST/GET /v1/users/{userId}/dialogs…`: начать или возобновить, журнал, история, завершить, стереть пользователя) и один WebSocket на диалог для текста и голоса (JSON-кадры `user_message`, `assistant_delta`, `safety`, …, голос — двоичные кадры PCM16), health/version. Сервис не публикуется наружу — только cluster-internal, авторизация по обязательному внутреннему токену.
- **PII-фильтрация (NER)** перед вызовами внешних моделей; Langfuse-трейсинг каждого вызова; деградация в текстовый режим при отказе голосовой цепочки (ASR/TTS), circuit breaker + retry/backoff на все внешние вызовы.
- **Каркас по проектным правилам**: конфиг по env-config-rules, логирование по logging-rules, middleware заголовков по api-headers-rules (проброс rqUId от backend), единый формат ошибок `{"error":{code,message,details}}`.
- **Деплой в ns `agent`**: Dockerfile (multi-stage, uv), k8s-манифесты (Deployment, Service, imagePullSecrets `registry-pull`, образ `cr.yandex/crpsqeamqpuvrkm5tpr9/agent/...`), без HTTPRoute наружу.

**Координация с add-backend-sessions-streaming**: конвейер реплики и интеграции GigaChat/SaluteSpeech выносятся из backend в agent, а вместе с ним — хранение диалогов, сообщений и сводок (подробности и отвергнутая альтернатива — design D2 и D6). Вызывающая сторона остаётся тонким транспортом (аккаунты, лимиты канала, reconnect) и ходит в agent по диалоговому API. Соответствующие design/tasks того change'а будут пересмотрены отдельно (openspec-update-change); открытый вопрос — кто именно вызывающая сторона (см. design, Open Questions).

Вне scope: консолидация памяти L2/L3 (отдельный change), фоновые задачи backend (push-уведомления, ритуалы по расписанию), ClickHouse, адаптер под других LLM-провайдеров сверх OpenAI-совместимого интерфейса. Сводку диалога (`title`, `themes`) agent строит сам при завершении диалога.

## Capabilities

### New Capabilities

- `agent-core`: оркестрация диалога на LangGraph — конвейер реплики, режимы диалога, кризисный протокол с приоритетом, классификатор эмоций, retrieval памяти, стрим-генерация через OpenAI-совместимый API (Cloud.ru), PII-фильтрация, инкогнито.
- `speech-pipeline`: голосовая цепочка агента — ASR-стриминг (SaluteSpeech) с partial/final транскриптами, TTS-стриминг с кэшем типовых фраз, деградация в текстовый режим при отказе голосовых компонентов.
- `agent-api`: внутренний контракт вызывающая сторона → agent — диалоги как ресурс agent (REST + WebSocket на диалог, текст и голос PCM16), проверка принадлежности диалога (`404`), история как источник истины после обрыва, работа нескольких реплик и остановка пода, обязательный внутренний токен, health/version, таймауты и коды ошибок, проброс трассировки (rqUId, Langfuse).

### Modified Capabilities

(пусто — утверждённых specs в openspec/specs/ пока нет; пересмотр change add-backend-sessions-streaming выполняется отдельно через его собственные артефакты)

## Impact

- **Новый код**: директория `agent/` в корне монорепо — `app/` (api, graph/ноды, services, clients, core), `tests/`, `Dockerfile`, `pyproject.toml`.
- **API**: внутренний HTTP API agent (не входит в docs/openapi.yaml — он для публичного API; контракт фиксируется в specs `agent-api`).
- **Инфраструктура**: namespace `agent` в k8s twc-sber500 (доступ уже выдан по ONBOARDING.md), новые образы в cr.yandex/crpsqeamqpuvrkm5tpr9/agent/, секрет `agent-llm-key` (Cloud.ru).
- **Зависимости**: LangGraph + openai SDK (новые для монорепо), SaluteSpeech (переезжает из планов backend), pgvector (собственная БД `agent`: диалоги, сообщения, память), Redis (кэш TTS, буферы), Langfuse.
- **Существующие change'ы**: add-backend-sessions-streaming — вынос конвейера (openspec-update-change после утверждения этого change'а); стек в openspec/config.yaml — GigaChat заменяется на OpenAI-совместимый API Cloud.ru (обновление контекста).
