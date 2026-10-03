# Tasks: add-agent-service

Ссылки: specs — `openspec/changes/add-agent-service/specs/{agent-core,speech-pipeline,agent-api}/spec.md`; design — `openspec/changes/add-agent-service/design.md` (D1–D11). docs/openapi.yaml здесь не применим — API agent внутренний (specs agent-api). UnionApp-паттерны: `/Users/aleksandrsamofalov/PycharmProjects/UnionApp/SevenElementBackend` (формат ошибок, конфиг).

## 1. Каркас и конфиг

- [ ] 1.1 Создать структуру `agent/` в корне монорепо: `app/{api,core,graph,services,clients,schemas}`, `tests/{unit,integration}`, `pyproject.toml` (uv, Python 3.12, зависимости: fastapi, uvicorn, langgraph, openai, httpx, loguru, pydantic-settings, sqlalchemy[asyncio], asyncpg, redis, natasha). Критерий: `cd agent && uv sync` проходит, `uv run python -c "import app"` без ошибок.
- [ ] 1.2 Конфиг `app/core/config.py` по env-config-rules: pydantic-settings, `validation_alias` на каждое поле, `SecretStr` для `AGENT_LLM_API_KEY`/`AGENT_INTERNAL_TOKEN`, агрегатор `APP_CONFIG`; группы: CloudRuLLM (base_url, модели генерации/классификаторов/эмбеддингов, таймауты), SaluteSpeech, Redis (Sentinel), Postgres (read-only), Langfuse, лимиты (таймаут хода 60 сек). Критерий: запуск без обязательных env падает с понятной ошибкой валидации (fail-fast); `.env.example` с плейсхолдерами `<CHANGE_ME_*>`.
- [ ] 1.3 Логирование `app/core/logging.py` по logging-rules: loguru + ContextVars + patcher, три sink'а (app.log, app-metric.log, events.log), маскирование ПДн. Критерий: лог содержит rqUId из ContextVar; маскер скрывает телефон/email в тестовом сообщении.
- [ ] 1.4 Middleware заголовков по api-headers-rules (x-trace-id/rqUId, x-request-time, x-client-id, x-session-id, x-user-id → ContextVars) + exception handlers с форматом `{"error":{code,message,details}}` и каталогом кодов из specs/agent-api «Формат ошибок». Критерий: юнит-тест — запрос с `x-trace-id` пробрасывает rqUId в лог; невалидный запрос отвечает единым форматом ошибки.
- [ ] 1.5 `app/main.py`: сборка FastAPI-приложения, lifespan (инициализация/закрытие клиентов), health/version-эндпоинты `GET /health`, `GET /health/ready`, `GET /version` по specs/agent-api «Служебные эндпоинты». Критерий: `/health` → 200, `/health/ready` → 503 с перечнем недоступных зависимостей при выключенном Redis.

## 2. Клиенты внешних сервисов

- [ ] 2.1 `app/clients/cloudru_llm.py` (design D3): `AsyncOpenAI` с `base_url` Cloud.ru; методы `chat_stream()` (токен-генератор), `classify()` (JSON response_format, дешёвая модель), `embed()`; таймауты, retry с backoff, circuit breaker. Критерий: интеграционный тест с реальным ключом — стрим отдаёт токены, classify возвращает валидный JSON; при недоступном endpoint — ошибка `AGENT_LLM_UNAVAILABLE` за время таймаута.
- [ ] 2.2 `app/clients/salutespeech.py`: ASR-стриминг (частичные/финальные гипотезы) и TTS-стриминг (аудио-чанки), таймауты + circuit breaker по specs/speech-pipeline «Устойчивость внешних вызовов». Критерий: интеграционный тест — pcm16-чанки → `transcript.final`; текст → поток opus-чанков; недоступность провайдера → ошибка за время таймаута.
- [ ] 2.3 `app/clients/redis.py`: подключение через Sentinel, операции для TTS-кэша (get/set с TTL). Критерий: юнит-тест с fakeredis — set/get/TTL работают.
- [ ] 2.4 `app/clients/postgres.py`: async-engine SQLAlchemy к БД backend read-only (design D6), search_path, пул с ограничением. Критерий: подключение к port-forward БД выполняет `SELECT 1`; пользователь БД не имеет прав INSERT/UPDATE/DELETE.

## 3. Сервисы доменной логики

- [ ] 3.1 `app/services/pii_service.py` (design D8): natasha NER (PER/LOC/ORG) + regex (телефоны, email, паспорта) → маскирование в `[PER_1]` с маппингом, обратная подстановка в ответе. Критерий: юнит-тесты specs/agent-core «PII-фильтрация» — ФИО и телефон маскируются, лог вызова не содержит исходных значений, подстановка восстанавливает текст.
- [ ] 3.2 `app/services/safety_service.py` (design D7): ступень 1 — словари/регулярки суицидальных маркеров; ступень 2 — LLM-классификатор (`level`, rationale) через `cloudru_llm.classify()`; эскалация вверх при сомнении; детерминированные шаблоны кризисного вмешательства (деэскалация + горячие линии, константа до появления справочника add-backend-content). Критерий: юнит-тесты specs/agent-core «Кризисный протокол» — маркерная реплика → `red` и шаблон вмешательства без вызова генерации; нейтральная → `green`; recall-набор (≥ 20 эталонных кризисных фраз) классифицируется не ниже `yellow`.
- [ ] 3.3 `app/services/emotion_service.py`: классификация эмоций реплики (теги + валентность + интенсивность) через `classify()`. Критерий: юнит-тест specs/agent-core «Классификация эмоций» — результат содержит теги с интенсивностью из фиксированной таксономии.
- [ ] 3.4 `app/services/memory_service.py` (design D6): retrieval — факты L2 (`memory_facts`), vector-поиск по `messages.embedding` с весом давности, учёт `last_session_at`; фильтр строго по `user_id`; при `incognito=true` — пустой контекст. Критерий: юнит-тесты specs/agent-core «Retrieval памяти» — чужие данные не возвращаются; инкогнито → пустой retrieval.
- [ ] 3.5 `app/services/tts_cache_service.py` (design D9): кэш `tts:{voice_id}:{sha256(text)}` в Redis, TTL 7 дней, только фразы из белого списка (ритуалы, приветствия, кризисное вмешательство). Критерий: юнит-тест specs/speech-pipeline «Кэш типовых фраз» — повторная фраза отдаётся без вызова SaluteSpeech (spy на клиенте).

## 4. LangGraph-граф конвейера

- [ ] 4.1 `app/graph/state.py` + `app/graph/prompts/` (design D5): `TurnState` (текст, режим, контекст сессии, safety, эмоции, память, артефакты); реестр промпт-пакетов режимов `vent`/`chat`/`gestalt_diary`/`recovery`/`rituals` (системка + ограничения стиля, vent — без непрошеных советов). Критерий: каждый режим резолвится в промпт-пакет; `warmth` → ошибка валидации (specs/agent-core «Режимы диалога»).
- [ ] 4.2 `app/graph/nodes.py` (design D4): ноды `safety_fast`, `safety_llm`, `crisis` (детерминированная), `emotion`, `retrieve`, `generate` (стрим через `chat_stream`, PII-маскирование до/после), `tts`. Критерий: юнит-тесты каждой ноды на моках сервисов.
- [ ] 4.3 `app/graph/turn_graph.py`: сборка StateGraph с условными ветвями (red → crisis → END; incognito → пропуск retrieve; флаг антизависимого контура → модификатор промпта) и единым генератором событий хода (`transcript.*`, `safety.status`, `llm.token/done`, `tts.chunk`, `crisis.intervention`, `degradation`, `turn.done`, `error`) с монотонным `seq`. Критерий: юнит-тесты specs/agent-core «Конвейер обработки реплики» и «Антизависимый контур» — порядок событий и ветвления соответствуют сценариям.

## 5. Внутренний API

- [ ] 5.1 `app/api/internal/turns.py` — `POST /internal/v1/turns` (SSE): текстовый ход, стрим событий из turn_graph, валидация запроса, отмена обработки при разрыве соединения (specs/agent-api «Стриминговая обработка реплики», «Таймауты и отмена»). Критерий: интеграционный тест — текстовый ход отдаёт поток `safety.status → llm.token* → llm.done → turn.done` с монотонным `seq`; разрыв соединения отменяет моки внешних вызовов.
- [ ] 5.2 `app/api/internal/turns_ws.py` — WebSocket `/internal/v1/turns/ws` (design D2): приём аудио-чанков, ASR-стрим с partial-транскриптами, далее общий конвейер; пустая речь → событие отсутствия речи без генерации (specs/speech-pipeline «ASR-стриминг»). Критерий: интеграционный тест WS — чанки → `transcript.partial/final → … → turn.done`.
- [ ] 5.3 Авторизация внутренним токеном на `/internal/**` (dependency, shared secret из конфига) + таймаут хода 60 сек с событием `error` `AGENT_TIMEOUT`. Критерий: тесты specs/agent-api «Внутренняя авторизация» и «Таймауты и отмена» — 401 без токена; зависший мок → `AGENT_TIMEOUT`.
- [ ] 5.4 Деградации: события `degradation` при отказе ASR/TTS/LLM по specs/speech-pipeline «Деградация в текстовый режим» и specs/agent-api «Формат ошибок» (ошибка в середине стрима — событием `error`). Критерий: тесты — отказ TTS → текст + событие деградации; отказ LLM посреди стрима → событие `error` с кодом `AGENT_LLM_UNAVAILABLE`.

## 6. Тесты и трейсинг

- [ ] 6.1 Langfuse-трейсинг (specs/agent-api «Сквозная трассировка»): трейс на ход (session_id, хэш user_id, режим), спаны на каждый вызов модели (модель, токены, длительность), связка с rqUId. Критерий: интеграционный тест с dev-Langfuse (port-forward) — трейс виден в UI с привязкой к rqUId.
- [ ] 6.2 Сквозной тест хода end-to-end на моках внешних провайдеров: текст → SSE-поток до `turn.done` с артефактами (текст ответа, эмо-теги, данные для памяти). Критерий: все сценарии specs/agent-api «Стриминговая обработка реплики» покрыты тестами; `uv run pytest` зелёный.
- [ ] 6.3 Контрактный тест событий: схемы всех типов событий (pydantic) валидируются на золотых примерах; `turn.done` в инкогнито не содержит данных для памяти. Критерий: тест падает при добавлении поля без обновления схемы.

## 7. Деплой

- [ ] 7.1 `agent/Dockerfile`: multi-stage на uv (по образцу backend/Dockerfile), non-root user, healthcheck. Критерий: локальная сборка образа успешна, контейнер отвечает на `/health`.
- [ ] 7.2 k8s-манифесты для ns `agent` (design D11): Deployment (2 реплики, requests/limits, `imagePullSecrets: registry-pull`), Service ClusterIP, NetworkPolicy (ingress только из ns backend), Secret-шаблон `agent-secrets` с `<CHANGE_ME_*>`; без HTTPRoute наружу. Критерий: `kubectl apply --dry-run=server -n agent` проходит; поды Ready; `GET /health/ready` → 200 в кластере.
- [ ] 7.3 Образ `cr.yandex/crpsqeamqpuvrkm5tpr9/agent/agent:0.1.0` собран и запушен (ONBOARDING.md п.2), деплой в ns `agent`, проверка из пода backend: `POST /internal/v1/turns` с токеном → стрим событий. Критерий: реальный текстовый ход через Cloud.ru возвращает `llm.token*` + `turn.done` в кластере.
- [ ] 7.4 openspec-update-change для add-backend-sessions-streaming: вынос конвейера и клиентов GigaChat/SaluteSpeech из его design/tasks, замена на вызовы `AgentClient` (env `AGENT_BASE_URL`, `AGENT_INTERNAL_TOKEN`, feature flag `AGENT_ENABLED`) по разделу Migration Plan в design.md. Критерий: артефакты того change'а не противоречат specs этого change'а; `openspec validate` обоих change'ов зелёный.
