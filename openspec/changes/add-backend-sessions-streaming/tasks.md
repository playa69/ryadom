# Tasks: add-backend-sessions-streaming

Контракт: specs/sessions/spec.md и specs/streaming/spec.md этого change'а + docs/openapi.yaml (тег `sessions`). Решения — design.md (D1–D9). Зависит от change add-backend-foundation-auth (каркас, auth, rate-limit). Open Questions на состав задач не влияют.

## 1. Конфиг и клиенты интеграций

- [ ] 1.1 Добавить в `app/core/config.py` домены `GigaChatSettings`, `SaluteSpeechSettings`, `LangfuseSettings`, `StreamingSettings` (пороги heartbeat/idle/max-duration/размеры фреймов из specs/streaming, буфер 200 событий) с `validation_alias` и `*_IS_HARD_HEALTH` (GigaChat/SaluteSpeech hard, Langfuse soft). Приёмка: старт без обязательных env GigaChat падает; дефолты порогов совпадают со specs/streaming
- [ ] 1.2 Реализовать клиент GigaChat (`app/services/llm/gigachat.py`): chat completions стрим + embeddings, retry с backoff для идемпотентных вызовов, circuit breaker, Langfuse-спаны (design.md D4). Приёмка: юнит-тесты на mock httpx — стрим токенов, retry на embeddings, breaker открывается после N ошибок
- [ ] 1.3 Реализовать клиенты SaluteSpeech ASR (стриминг) и TTS (стриминг + кэш аудио в Redis по хэшу текста+голоса) (design.md D4). Приёмка: юнит-тесты — стрим partial/final транскрипта, попадание TTS в кэш при повторном тексте
- [ ] 1.4 Реализовать `pii_filter_service.py` (design.md D6): NER-маскирование ФИО/телефонов/email перед внешними вызовами, восстановление масок в ответе в пределах запроса. Приёмка: тест — реплика с ФИО/email уходит в GigaChat-клиент маскированной
- [ ] 1.5 Реализовать `crisis_service.py` (design.md D5): двухступенчатый классификатор (правила + лёгкая модель → LLM-проверка неоднозначных), уровни green/yellow/red, скрипты деэскалации и ресурсы из справочника. Приёмка: юнит-тесты — зелёная/красная/неоднозначная реплика; шаг не отключается конфигом режима

## 2. Модели и миграции

- [ ] 2.1 Реализовать ORM-модели `sessions` (mode, status, incognito, started_at/finished_at), `messages` (role, text_enc, emo_tags[], embedding vector), `session_summaries` (themes[], emotions, tension_before/after, key_facts[], takeaway). Приёмка: поля соответствуют specs/sessions и схемам docs/openapi.yaml
- [ ] 2.2 Создать миграцию Alembic `0002_sessions` (3 таблицы + vector-индекс). Приёмка: `alembic upgrade head` + `downgrade` на чистой dev-БД без ошибок

## 3. Репозитории

- [ ] 3.1 Реализовать `SessionRepository` (create, get_active_for_user, list с фильтрами mode/from/to + cursor, get с проверкой владельца, delete каскадом). Приёмка: юнит-тесты на тестовой БД — каждый метод, cursor-пагинация стабильна
- [ ] 3.2 Реализовать `MessageRepository` (запись транскрипта с шифрованием text_enc, чтение по сессии, удаление каскадом) и `SessionSummaryRepository` (upsert идемпотентно по session_id). Приёмка: тест — шифрование на записи, расшифровка на чтении, повторный upsert без дубля
- [ ] 3.3 Реализовать retrieval-запросы памяти в `MemoryRepository` (pgvector similarity + вес давности + активные темы + «время с последней сессии»). Приёмка: тест — свежий факт ранжируется выше старого при равной близости

## 4. Сервисы

- [ ] 4.1 Реализовать `session_service.py`: create (проверка consents → 403 `CONSENT_REQUIRED`, одна активная → 409 `CONFLICT`, режим warmth → 422, инкогнито из настроек), выдача session_token (design.md D2). Приёмка: сценарии specs/sessions «Создание сессии» покрыты тестами
- [ ] 4.2 Реализовать историю и детали в `session_service.py`: лента саммари без транскриптов (инкогнито скрыты), детали с транскриптом или 410 `SESSION_TRANSCRIPTS_DISABLED`, delete. Приёмка: сценарии specs/sessions «История», «Детали», «Удаление» покрыты тестами
- [ ] 4.3 Реализовать `finish` в `session_service.py`: tension_after 1–10, takeaway ≤ 500, 409 `SESSION_ALREADY_FINISHED`, постановка Celery-задачи summarize_session. Приёмка: сценарии specs/sessions «Завершение сессии» покрыты тестами
- [ ] 4.4 Реализовать `dialog_orchestrator.py` (design.md D3): отменяемый pipeline ASR → safety → эмоции → retrieval → LLM-стрим → TTS-стрим, barge-in через cancellation, Langfuse-спаны и счётчики component calls на каждый шаг. Приёмка: юнит-тест с mock-клиентами — полный цикл реплики; новая реплика отменяет генерацию
- [ ] 4.5 Реализовать кризисную ветку в `dialog_orchestrator.py`: level=red → останов сценария режима + `crisis.intervention` (скрипт + ресурсы) вместо обычного ответа (specs/streaming «Кризисный протокол»). Приёмка: тест — при red нет вызова LLM-ядра, отправлен intervention
- [ ] 4.6 Реализовать деградацию голоса (design.md D4): при открытом breaker'е ASR/TTS сессия продолжается в тексте с событием деградации. Приёмка: тест — отказ TTS → llm-ответ доставлен текстом, клиент уведомлён
- [ ] 4.7 Реализовать Celery-задачу `summarize_session` (design.md D7): L1-саммари лёгкой моделью → `session_summaries`, идемпотентно по session_id, rqUId через logger.bind (фон без ContextVars). Приёмка: тест задачи на fake LLM — саммари записано, повтор без дубля

## 5. WS-менеджер и роутеры

- [ ] 5.1 Реализовать WS-менеджер `app/api/ws/` (design.md D1): реестр соединений, вытеснение кодом 4003, буфер 200 событий в Redis, монотонный event_id. Приёмка: тесты — второе подключение закрывает первое 4003; event_id строго возрастает
- [ ] 5.2 Реализовать WS-эндпоинт `/api/v1/ws/sessions/{id}`: авторизация session_token (4401), фреймы клиента/сервера по specs/streaming, ping/pong, таймеры heartbeat (60 сек), idle (10 мин → 4002), max duration (60 мин → 4001). Приёмка: тесты всех close-кодов и лимитов размеров фреймов
- [ ] 5.3 Реализовать reconnect/resume: `last_event_id` → досылка буфера, дедуп `client_msg_id`, аудио не реплеится. Приёмка: тесты сценариев specs/streaming «Reconnect и resume»
- [ ] 5.4 Реализовать роутер `app/api/v1/sessions.py`: `POST /sessions`, `GET /sessions`, `GET /sessions/{id}`, `DELETE /sessions/{id}`, `POST /sessions/{id}/finish` по docs/openapi.yaml (operationId createSession/listSessions/getSession/deleteSession/finishSession). Приёмка: интеграционные тесты — ответы и коды 1:1 specs/sessions
- [ ] 5.5 Реализовать SSE-эндпоинт `POST /sessions/{id}/messages` (text/event-stream, типы событий без аудио, rate-limit 60/мин action `message_send`). Приёмка: тест — поток safety.status → llm.token → llm.done; 61-е сообщение → 429

## 6. Тесты

- [ ] 6.1 Юнит-тесты конвейера и сервисов (из задач 1.2–4.7) довести до полного покрытия сценариев specs/streaming и specs/sessions. Приёмка: каждый сценарий обеих specs имеет зелёный тест
- [ ] 6.2 Интеграционные тесты WS полного цикла: создание сессии → подключение → текстовая реплика → safety → llm-стрим → finish → саммари (mock внешних LLM). Приёмка: прогон против поднятого приложения с тестовой БД/Redis
- [ ] 6.3 Тесты отказов: недоступность GigaChat (breaker, деградация), недоступность SaluteSpeech (текстовый режим), обрыв соединения с reconnect. Приёмка: сценарии specs/streaming «Деградация голоса», «Reconnect» зелёные

## 7. Деплой

- [ ] 7.1 Добавить env GigaChat/SaluteSpeech/Langfuse/Streaming в k8s secret и `.env.example` (плейсхолдеры `<CHANGE_ME_*>`). Приёмка: конфиг стартует в кластере, секретов в git нет
- [ ] 7.2 Добавить Celery worker в манифесты ns `backend` (тот же образ, команда worker) и проверить таймауты WS на HTTPRoute/Envoy ≥ 60 мин (Open Question design.md). Приёмка: worker обрабатывает summarize_session в кластере; WS живёт > 10 мин без разрыва
- [ ] 7.3 Smoke в кластере: `POST /api/v1/sessions` → WS-реплика полного цикла → finish → саммари в истории; метрики component calls в Prometheus. Приёмка: одна тестовая сессия даёт ≥ 6 component calls на реплику
