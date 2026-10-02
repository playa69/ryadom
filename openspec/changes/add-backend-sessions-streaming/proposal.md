# Proposal: add-backend-sessions-streaming

## Why

Auth-фундамент (change add-backend-foundation-auth) даёт аутентифицированного пользователя; следующий блок дорожной карты — ядро продукта: сессии диалога с режимами из продуктовой спеки и дуплексный стриминг голоса/текста. Без них нет ни одного пользовательского сценария («23:40, тяжело после ссоры», «между группами»), а кризисный протокол — предохранитель, обязательный до выхода к реальным пользователям.

## What Changes

- **Сессии (REST)** по docs/openapi.yaml (тег `sessions`): `POST /sessions` (режимы `vent`, `chat`, `gestalt_diary`, `recovery`, `rituals`; `warmth` зарезервирован под v1 → ошибка валидации), `GET /sessions` (история: фильтры `mode`/`from`/`to`, cursor-пагинация, лента саммари без транскриптов), `GET /sessions/{id}` (детали + транскрипт; 410 `SESSION_TRANSCRIPTS_DISABLED` при выключенном хранении), `DELETE /sessions/{id}`, `POST /sessions/{id}/finish` (tension_after 1–10, takeaway, триггер фоновой суммаризации).
- **WebSocket-стриминг** `wss://.../api/v1/ws/sessions/{id}?token=`: дуплекс — клиент шлёт `audio.chunk` (opus/pcm16, base64), `text.message`, `ping`, `session.pause/resume`; сервер — `transcript.partial/final` (SaluteSpeech ASR), `safety.status` (кризис-классификатор каждой реплики), `llm.token`/`llm.done` (стрим GigaChat), `tts.chunk` (SaluteSpeech TTS), `session.state`, `crisis.intervention`, `error`, `pong`. Монотонный `event_id`, reconnect по `last_event_id` (буфер 200 событий в Redis), дедупликация `client_msg_id`.
- **Лимиты канала**: 1 активное WS-соединение на пользователя (вытеснение кодом 4003), heartbeat 30/60 сек, idle 10 мин (4002), max длительность 60 мин (4001), фрейм ≤ 256 КБ, audio.chunk ≤ 64 КБ, `session_token` TTL 300 сек; 60 сообщений/мин на пользователя (WS+SSE суммарно).
- **SSE-fallback** `POST /sessions/{id}/messages` (text/event-stream) — текстовая деградация без голоса с теми же типами событий.
- **Конвейер реплики**: ASR-стрим → safety-классификатор (двухступенчатый, высокий recall; `level=red` → `crisis.intervention` перекрывает всё: деэскалация + горячие линии) → классификатор эмоций → retrieval памяти (pgvector + вес давности + «время с последней сессии») → GigaChat стрим → TTS стрим (кэш ритуалов/типовых фраз). PII-фильтрация (NER) перед внешними вызовами моделей.
- **Интеграции**: клиенты GigaChat и SaluteSpeech (ASR/TTS стриминг) с retry/backoff и circuit breaker, деградация в текстовый режим при отказе голосовой цепочки; Langfuse-трейсинг каждого вызова модели.
- **Фон**: Celery-задача суммаризации сессии после `finish` (L1-саммари: темы, эмоции, tension до/после, key_facts) — worker из стека config.yaml (Celery + beat).
- **Модели и миграции**: `sessions`, `messages` (text_enc, emo_tags, embedding vector), `session_summaries`.
- **Инкогнито**: сессия при `incognito_session=true` в настройках не пишется в память и историю.

Зависимости: change add-backend-foundation-auth (auth, каркас, rate-limit). Вне scope: профиль/настройки (отдельный change), консолидация памяти L2/L3 (следующие change'ы), ClickHouse (component_calls — пока лог вызовов в собственный лог/метрики).

## Capabilities

### New Capabilities

- `sessions`: жизненный цикл сессий диалога — создание с режимами, история с саммари, детали с транскриптом и правилами его доступности, удаление, завершение с самооценкой, ограничения (одна активная сессия, лимиты сообщений, инкогнито).
- `streaming`: дуплексный протокол реального времени — WebSocket-фреймы клиента и сервера, авторизация соединения session_token, heartbeat и таймауты, одно активное соединение, reconnect/resume, кризисный протокол в потоке, SSE-fallback, конвейер обработки реплики (ASR → safety → эмоции → retrieval → LLM → TTS).

### Modified Capabilities

(пусто — существующих specs нет; зависимость от `auth` и `backend-foundation` — потребление, не изменение их требований)

## Impact

- **Новый код**: `app/services/session_service.py`, `dialog_orchestrator.py`, `crisis_service.py`, `memory_service.py` (retrieval), `pii_filter_service.py`, `app/services/llm/` (клиенты GigaChat, SaluteSpeech ASR/TTS), `app/api/ws/` (WS-менеджер), роутеры `app/api/v1/sessions.py`, Celery-задача `summarize_session`.
- **API**: 5 REST-эндпоинтов (тег `sessions` в docs/openapi.yaml) + WS-эндпоинт + SSE-эндпоинт.
- **БД**: таблицы `sessions`, `messages` (pgvector embedding), `session_summaries`; миграция Alembic.
- **Redis**: буфер событий WS (200 последних на сессию), активные соединения, rate-limit сообщений.
- **Внешние зависимости**: GigaChat (LLM + Embeddings), SaluteSpeech (ASR/TTS стриминг), Langfuse (трейсинг) — новые `*_IS_HARD_HEALTH`: GigaChat/SaluteSpeech hard, Langfuse soft.
- **Инфраструктура**: env-секреты GigaChat/SaluteSpeech в k8s secret; WS через istio-gateway (долгоживущие соединения — таймауты HTTPRoute/Envoy должны допускать 60+ мин).
- **Метрики**: обращения к компонентам на реплику (ASR/safety/эмоции/retrieval/LLM/TTS) — основа конкурсной метрики ≥25 обращений/DAU.
