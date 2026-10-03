# Design: add-agent-service

## Context

Backend «Слышу Рядом» распланирован (5 change'ов в openspec/changes/), но конвейер реплики в add-backend-sessions-streaming пока вписан внутрь backend с GigaChat. Фактические вводные изменились: получен OpenAI-совместимый ключ, модели крутятся в Cloud.ru (Evolution Foundation Models, endpoint `https://foundation-models.api.cloud.ru/v1`, данные в РФ), а в k8s выделен namespace `agent`. Требования — см. specs `agent-core`, `speech-pipeline`, `agent-api` этого change'а.

## Goals / Non-Goals

**Goals:**

- Отдельный сервис `agent/` в монорепо: весь конвейер реплики (ASR → safety → эмоции → retrieval → LLM → TTS) за внутренним HTTP/WS API.
- LLM — только OpenAI-совместимый интерфейс (Cloud.ru), без привязки к GigaChat SDK.
- Кризисная ветвь — детерминированная и быстрая, не зависящая от генеративной модели.
- Независимый деплой/масштабирование agent в одноимённом namespace.

**Non-Goals:**

- Консолидация памяти L2/L3 и фоновая суммаризация (отдельные change'ы; agent лишь возвращает артефакты для записи).
- Публичный API agent (наружу смотрит только backend).
- Замена SaluteSpeech как голосового провайдера.
- Переписывание уже распланированного backend (координация — через openspec-update-change для add-backend-sessions-streaming).

## Decisions

### D1: Отдельный сервис, а не библиотека в backend

`agent/` — самостоятельное FastAPI-приложение с собственным Dockerfile, деплоится в ns `agent`. Альтернатива — Python-пакет, импортируемый backend'ом: проще на старте, но связывает релизы, мешает масштабировать LLM/ASR/TTS-поды отдельно от API-подов и размазывает ПДн-обработку по двум контурам. Выбран сервис: в ONBOARDING.md ns `agent` уже выделен именно под «сервисы логики агента».

### D2: Транспорт backend → agent: SSE для текста, WebSocket для голоса

Текстовые ходы — `POST /internal/v1/turns` со стримом SSE (event-stream из типизированных событий). Голосовые — внутренний WebSocket `/internal/v1/turns/ws` (backend проксирует аудио-чанки клиента, agent стримит события). Альтернативы: gRPC (нет в стеке, лишняя toolchain-сложность); chunked-upload поверх HTTP (полудуплекс — нет partial-транскриптов, пока пользователь говорит); единый WS для всего (усложняет текстовый путь и SSE-fallback backend'а). Типы событий общие для обоих транспортов — backend маппит их 1:1 в клиентский WS-протокол из specs `streaming`.

### D3: LLM-провайдер — OpenAI-совместимый API Cloud.ru через официальный `openai` SDK

Один клиент `CloudRuLLMClient` поверх `openai.AsyncOpenAI(base_url=..., api_key=...)`: chat completions со `stream=True` для генерации, отдельные модели из конфига для кризис/эмоции-классификаторов (дешёвые, с `response_format=json`) и эмбеддингов. Альтернатива — GigaChat SDK: отпала, т.к. выдан OpenAI-совместимый ключ и модели уже в Cloud.ru (152-ФЗ, данные в РФ). Замена провайдера в будущем = смена `base_url`/моделей в конфиге, код не трогаем.

### D4: Конвейер как LangGraph-граф состояний

Граф `turn_graph` (StateGraph): `safety_fast` (словари/эвристики, локально, ~0 мс) → `safety_llm` (классификатор на дешёвой модели, только если эвристики не дали `red`) → условная ветвь `crisis` (детерминированный шаблон + ресурсы помощи, END) | `emotion` → `retrieve` → `generate` (стрим) → `tts` (если голосовой ход). Состояние — `TurnState` (текст реплики, контекст сессии, safety, эмоции, память, артефакты). Альтернатива — ручная оркестрация async-функциями: дешевле по зависимостям, но режимы/ветвления (кризис, инкогнито, деградации) быстро превращаются в лапшу if'ов; LangGraph даёт явный граф, стриминг событий нод и готовые точки расширения (инструменты, memory). Инкогнито — флаг в состоянии: нода `retrieve` пропускается, артефакты для памяти не формируются.

### D5: Режимы диалога — промпт-пакеты, а не отдельные графы

Один граф; режим (`vent`/`chat`/`gestalt_diary`/`recovery`/`rituals`) выбирает системный промпт-пакет (системка + few-shot + ограничения стиля) из реестра `app/graph/prompts/<mode>.py`. `warmth` отклоняется валидацией на границе API. Отдельные графы на режим — избыточны: ветвления хватает на уровне промптов и параметров retrieval.

### D6: Доступ к памяти — прямое чтение БД backend (pgvector)

Agent подключается к той же PostgreSQL 16 + pgvector (БД `backend`) отдельным PG-пользователем с правами SELECT на `memory_facts`, `messages` (embedding), `session_summaries`. Retrieval: vector-поиск по `messages.embedding` + факты L2 + вес давности + `last_session_at` из запроса. Альтернатива — вызовы backend API за памятью: лишний хоп, и такого API нет ни в одном change'е. Trade-off — coupling на схему БД backend: принимаем, схема фиксируется миграциями add-backend-sessions-streaming / add-backend-profile-settings; agent не пишет в БД вообще (артефакты для записи уходят backend'у в `turn.done`).

### D7: Кризис-классификатор — две ступени, recall-first

Ступень 1: локальные словари/регулярки суицидальных маркеров (мгновенно, без сети). Ступень 2: LLM-классификатор (JSON: level + rationale) на дешёвой модели. Любое сомнение → эскалация уровня вверх. Ответ при `red` — статичные шаблоны деэскалации + горячие линии (те же данные, что сидирует add-backend-content в `support_resources`; на старте — встроенная константа agent, синхронизация через TODO при появлении справочника). Никакой генеративной импровизации в кризисной ветви.

### D8: PII-фильтрация — локальный NER (natasha) + regex

Перед внешними вызовами текст прогоняется через natasha (русский NER: PER/LOC/ORG) и regex (телефоны, паспорта, email): сущности → плейсхолдеры `[PER_1]` с маппингом в памяти запроса; после генерации — обратная подстановка. Альтернатива — NER через LLM: внешний вызов сам по себе утёк бы ПДн. Аудио не фильтруется (уходит в SaluteSpeech — РФ-провайдер по стеку), фильтруется только текст для LLM/эмбеддингов.

### D9: TTS-кэш в Redis

Ключ `tts:{voice_id}:{sha256(text)}` → opus-чанки, TTL 7 дней. Кэшируются только фразы из белого списка (ритуалы, приветствия, кризисное вмешательство) — кэшировать произвольную генерацию бессмысленно и растит Redis.

### D10: Каркас — по проектным правилам, как у backend

Конфиг — env-config-rules (pydantic-settings, `validation_alias`, `SecretStr` для ключа Cloud.ru и внутреннего токена, fail-fast, агрегатор `APP_CONFIG`). Логи — logging-rules (loguru + ContextVars + patcher, три sink'а, маскирование ПДн). Заголовки — api-headers-rules (middleware извлекает x-trace-id/rqUId и ко в ContextVars, проброс во внешние вызовы). Ошибки — `{"error":{code,message,details}}` по каталогу specs `agent-api`. Структура `agent/app/`: `api/` (internal роутеры), `graph/` (LangGraph: state, nodes, prompts), `services/` (safety, emotion, memory, pii), `clients/` (cloudru_llm, salutespeech, redis, postgres), `core/` (config, logging, errors), `schemas/`.

### D11: Деплой

Multi-stage Dockerfile на uv (как у backend), образ `cr.yandex/crpsqeamqpuvrkm5tpr9/agent/agent:<tag>`, манифесты в `k8s/` для ns `agent`: Deployment (2 реплики, resources с лимитами), Service ClusterIP (без HTTPRoute — недоступен снаружи), `imagePullSecrets: registry-pull`, env из нового Secret `agent-secrets` (`<CHANGE_ME_*>` в git, реальные значения — `kubectl create secret`). NetworkPolicy: ingress только из ns `backend`.

## Risks / Trade-offs

- [Качество/стилистика моделей Cloud.ru для эмпатичного русского диалога не проверена] → промпт-пакеты изолированы (D5), Langfuse scores на качество ответов, замена модели — конфиг (D3).
- [Лимиты/латентность Cloud.ru (rate limits, очереди)] → стриминг с первого токена, таймауты + деградация `AGENT_LLM_UNAVAILABLE`, отдельные дешёвые модели для классификаторов снижают нагрузку.
- [Coupling agent на схему БД backend (D6)] → только SELECT по стабильным таблицам, версионирование через миграции backend, при появлении memory-API в backend — миграция на него отдельным change'ом.
- [Два транспорта (SSE + WS) дублируют код хода] → единый конвейер-ядро (генератор событий), транспорты — тонкие адаптеры над ним.
- [SaluteSpeech — единая точка отказа голоса] → circuit breaker + деградация в текст (specs speech-pipeline), TTS-кэш критичных фраз.
- [PII-маскирование natasha несовершенно (пропуск сущности → утечка в Cloud.ru)] → Cloud.ru — РФ-провайдер (152-ФЗ допустимо), regex-добор для телефонов/документов, логи внешних вызовов только с маскированным текстом.

## Migration Plan

1. Развёртывание agent в ns `agent` с `AGENT_LLM_API_KEY` (Cloud.ru) — независимо от backend, проверка `/health/ready`.
2. Backend: новый `AgentClient` (env `AGENT_BASE_URL` + `AGENT_INTERNAL_TOKEN`), конвейер в add-backend-sessions-streaming переключается на вызовы agent (openspec-update-change того change'а — правки design/tasks).
3. Feature flag `AGENT_ENABLED` в backend: выкатка → проверка диалоговой регрессии → снятие флага. Rollback: флаг off, backend возвращается к прежнему поведению.

## Open Questions

- Конкретные идентификаторы моделей Cloud.ru (генерация / классификаторы / эмбеддинги) — выбираются при реализации из доступных в выданном проекте Cloud.ru; фиксируются в конфиге, не в specs.
- Формат аудио между backend и agent (повторять клиентский opus/pcm16 base64 или транскодировать) — решится при реализации WS-адаптера, на контракт событий не влияет.
