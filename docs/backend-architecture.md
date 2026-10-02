# Архитектура реализации backend «Слышу Рядом»

Версия документа: 0.1.0 · Статус: черновик v0 (MVP)

Справочник для разработчиков: как строить backend по контракту `docs/api.md`.
Референс реализации — UnionApp (`SevenElementBackend`, FastAPI + SQLAlchemy
async + PostgreSQL + Pydantic v2), пути файлов ниже — относительно
`/Users/aleksandrsamofalov/PycharmProjects/UnionApp/SevenElementBackend`.
Номера строк указаны по состоянию на 2026-10-02; при расхождении ориентируйтесь
на имена функций/классов.

## 1. Слоистый layout

Слои и направление зависимостей — как в UnionApp:

```
app/api/v1/*         — роутеры (тонкие: валидация схем, вызов сервиса, маппинг ошибок)
app/services/*       — бизнес-логика, антиспам, оркестрация компонентов
app/repositories/*   — SQLAlchemy async, только запросы, без логики
app/models/*         — ORM-модели
app/schemas/*        — Pydantic v2 схемы запросов/ответов + errors.py
app/core/*           — config.py, security.py, db.py, redis.py, metrics.py
app/api/deps.py      — сборка зависимостей через Annotated[..., Depends]
```

Правила:

- Роутер не ходит в БД напрямую — только через сервис; сервис — только через
  репозитории.
- Сессия БД — dependency `get_db_session`; коммит делает сервис (одна точка
  коммита на операцию), как в `auth_service.py`.
- Зависимости собираются в `app/api/deps.py` фабриками
  (`get_auth_service` — UnionApp `app/api/deps.py:217-230`): репозитории и
  сервисы не создаются руками в роутерах.
- Конфиг — типизированный `BaseSettings` (см. раздел 6), никаких `os.getenv`
  вне `config.py`.

## 2. Что копировать из UnionApp почти без изменений

### 2.1. `app/core/security.py` (151 строка) — целиком

| Функция / класс | Строки | Что даёт |
|---|---|---|
| `password_hasher = PasswordHash.recommended()` | :16 | argon2id для паролей и device_key |
| `hash_password` / `verify_password` | :60-65 | хэширование/проверка |
| `hash_token` | :68-69 | SHA-256 для opaque-токенов (в БД только хэш) |
| `create_access_token` | :72-99 | JWT HS256, TTL 15 мин, claims `sub/type/iat/exp` |
| `create_refresh_token` | :102-111 | opaque `token_urlsafe(48)`, TTL 30 дней |
| `create_password_reset_token` | :114-123 | opaque `token_urlsafe(32)`, TTL 30 мин |
| `decode_and_validate_jwt` | :126-151 | валидация с `require: [exp, sub, type]` |
| `JWTPayload`, `IssuedToken`, `TokenValidationError` | :25-43 | типы |

Доработки при переносе: claim `login` не нужен (нет логина — `sub` = user UUID);
`JWTTokenType` оставить только `ACCESS`; роли/organization-claims не переносить.

### 2.2. Ротация refresh с family-revoke — `app/services/auth_service.py`

| Код | Строки | Механика |
|---|---|---|
| `refresh` | :723-770 | активный токен → ротация (:728-732); отозванный в grace-окне 10 сек → новая пара без отзыва (:736-755); отозванный вне окна → replay → отзыв ВСЕХ refresh пользователя (:756-768) |
| `_issue_rotated_tokens` | :685-721 | новая пара, старый → `revoked_at`, `device_id` наследуется новым токеном (:717) |
| `logout` | :772-782 | отзыв refresh устройства, идемпотентно |
| сброс пароля | :663-683 | новый пароль → `mark_password_reset_token_used` → `revoke_refresh_tokens_for_user` (:668) → аудит (:669-676) → коммит → письмо после коммита |

Вместе с сервисом переносится `AuthRepository`
(`app/repositories/auth_repository.py`): `get_active_refresh_token`,
`get_refresh_token_by_hash`, `revoke_refresh_token`,
`revoke_refresh_tokens_for_user`, `create_refresh_token`,
`mark_password_reset_token_used`, инвалидация предыдущих reset-токенов при новом
запросе.

Отличия нашего auth от UnionApp (новый код поверх тех же примитивов):

- `POST /auth/device` — регистрация/вход по `device_id` + `device_key`
  (device_key хэшируется argon2 в `auth_identities.secret_hash`), идемпотентно;
  итог — та же пара токенов через `_issue_rotated_tokens`-аналог.
- `POST /auth/email/link[confirm]` — привязка email к существующему user_id;
  код верификации по шаблону 2.5.
- `POST /auth/email/login` — вход по email/паролю, выдача refresh с `device_id`
  нового устройства.

### 2.3. Модели токенов — `app/models/refresh_token.py`, `app/models/password_reset_token.py`

Копируются 1:1 (33 и 32 строки): `token_hash` (unique), `device_id`,
`expires_at` (index), `revoked_at` / `used_at`, FK `user_id` с
`ondelete="CASCADE"`. Базовые миксины — `app/models/base.py`
(`UUIDPrimaryKeyMixin`, `CreatedAtMixin`).

### 2.4. Антиспам — `app/services/rate_limit_service.py` + `app/services/anti_spam_service.py`

`rate_limit_service.py` (149 строк) — целиком:

- `RateLimitBackend` protocol (:18-45);
- `RedisRateLimitBackend` — sliding window на ZSET
  (`zremrangebyscore`/`zcard`/`zadd`/`expire` в pipeline, :56-67) + cooldown
  через `SET NX EX` (:75-84);
- `NoOpRateLimitBackend` (:87-108) — локальная разработка без Redis;
- `InMemoryRateLimitBackend` (:111-149) — юнит-тесты.

`anti_spam_service.py` (397 строк) — скелет целиком:

- `RequestSecurityContext`, `ContactHandle`, `AntiSpamDecision`,
  `RateLimitExceededError` (:42-67);
- `build_contact_handles` + нормализация/маскирование/хэширование контактов
  (:70-99, :350-397);
- `evaluate_*` (:121-219) и `record_*` (:225-265) — переписываем под наши
  action'ы: `device_login`, `email_login`, `email_link`, `password_reset`,
  `message_send`, `checkin_submit`, `sos_event`;
- `record_forgot_password_request` (:251-265) — cooldown пишется независимо от
  существования аккаунта (anti-enumeration) — переносим как есть.

Лимиты — по таблице раздела 9.3 `docs/api.md`; все пороги и окна — в конфиг
(как `settings.security_*` в UnionApp).

### 2.5. Email-коды — шаблон `app/services/cabinet_2fa_service.py`

Переносим обобщённый `CabinetEmailCodeService` (:114+):

- схема ключей Redis (:37-39): `{ns}:pending:{pending_token}` → JSON payload с
  TTL, `{ns}:user:{user_id}` → активный pending_token (один код на пользователя),
  `{ns}:send:` — rate-limit отправки;
- `CabinetCodeFlowConfig` (:76-86) — конфиг namespace/лимитов на флоу;
- наш namespace — `email_link`; параметры: код 6 цифр, TTL 600 сек, max 5
  попыток ввода, 5 отправок/час на аккаунт и на хэш email, single-use,
  сравнение через `compare_digest`, код никогда не логируется.

Сам cabinet-флоу (логин в кабинет, CSV-экспорт) не переносим — только механизм.

### 2.6. Request context, trusted proxy, current user — `app/api/deps.py`

| Код | Строки | Перенос |
|---|---|---|
| `_is_trusted_proxy` | :116-147 | как есть: plain IP + CIDR, битые записи — warning, не падаем |
| `get_request_security_context` | :150-197 | как есть: XFF доверяем только от trusted proxy; берём ПОСЛЕДНИЙ адрес цепочки (:182-185) — edge-proxy дописывает реального TCP-пира последним, клиентская подделка оказывается раньше и игнорируется |
| `get_rate_limit_backend` / `get_anti_spam_service` | :200-214 | как есть (Redis → fallback) |
| `get_cabinet_2fa_service` fail-closed | :233-258 | паттерн 503 без Redis — применяем ко всем auth-критичным контурам (api.md 9.4) |
| `get_current_user` | :505-619 | как есть: Bearer → `decode_and_validate_jwt` → пользователь из БД → 401 `AUTH_TOKEN_EXPIRED`/`AUTH_TOKEN_INVALID` в едином формате |

Для нашего стека: `TRUSTED_PROXY_IPS` = CIDR подсети подов кластера twc-sber500
(istio ingressgateway — единственный доверенный прокси).

### 2.7. Единый формат ошибок — `app/schemas/errors.py`

Переносим механику (:17-184): `ErrorCode` (StrEnum), `ErrorResponse.from_code`
с дефолтными RU-сообщениями (:105-115), `FieldErrorDetail` (:75-83),
`ValidationErrorResponse` (:118-135), exception handlers маппят доменные
исключения сервисов в `{"error": {code, message, details}}`.

Наш каталог кодов — SCREAMING_SNAKE из `docs/api.md` раздел 1.3
(`AUTH_TOKEN_EXPIRED`, `RATE_LIMITED`, `AGE_RESTRICTED`, `SESSION_*` и т.д.),
не UnionApp'овские lowercase — расхождение осознанное, единообразие внутри
проекта важнее. 429 обязан нести `Retry-After`
(`RateLimitExceededError.retry_after_seconds` — anti_spam_service.py:64-67).

### 2.8. Аудит

`AuditLogRepository` + `_record_audit_event` в сервисах (пример вызова —
auth_service.py:669-676): actor, action (`auth.device_login.succeeded`,
`auth.refresh.family_revoked`, `auth.email_link.confirmed`,
`auth.password_reset.*`, блокировки антиспама, `user.deletion.*`), entity,
IP/UA из `RequestSecurityContext`, контакты только masked
(`_mask_email` — anti_spam_service.py:377-381). Плюс Prometheus-счётчики без PII.

## 3. Что доработать при переносе

- **CORS** — в UnionApp `*`; у нас фиксированный список origins (мобильное
  приложение ходит без Origin, CORS нужен только для возможного web-клиента) —
  список в конфиге, дефолт пустой.
- **Trusted proxies** — `TRUSTED_PROXY_IPS` = CIDR pod-сети кластера; значение
  по умолчанию отсутствует (без конфигурации XFF не доверяем никому).
- **Отсутствие `jti` в access-токене** — осознанно оставляем: TTL 15 мин +
  ротация refresh с family-revoke компенсируют; точечный отзыв access не
  требуется контрактом.
- **Security-headers middleware** — добавить (в UnionApp нет):
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, `Strict-Transport-Security` (за TLS-терминацией
  на gateway — заголовок всё равно отдаёт приложение),
  `Cache-Control: no-store` для auth-эндпоинтов.
- **PII-фильтрация (NER)** перед внешними вызовами GigaChat/SaluteSpeech —
  нового кода нет в UnionApp, проектируем как `app/services/pii_filter_service.py`
  в конвейере сессии.
- **Шифрование `text_enc`** (messages, journal_entries) — полевое шифрование
  (Fernet/AES-GCM, ключ из секрета), в UnionApp аналога нет.

## 4. Что НЕ переносить из UnionApp

- генерацию пароля за пользователя (пароль задаёт только пользователь);
- роли `chairman`/`secretary`, `user_roles`, organization-claims в JWT
  (_issue_rotated_tokens: :693-701 — выкидываем `roles_claim`);
- cabinet-флоу (2FA-вход в кабинет, CSV-экспорт) — только механизм email-кодов;
- регистрационные заявки, профсоюзные сущности, опросы, мероприятия;
- phone как контакт (у нас phone не используется вообще — только email).

## 5. Структура каталогов будущего сервиса

```
backend/
├── pyproject.toml
├── app/
│   ├── main.py                    # FastAPI app, lifespan, exception handlers
│   ├── core/
│   │   ├── config.py              # BaseSettings-домены + Config/APP_CONFIG (раздел 6)
│   │   ├── security.py            # ← UnionApp app/core/security.py (2.1)
│   │   ├── db.py                  # engine, get_db_session
│   │   ├── redis.py               # Redis Sentinel client
│   │   └── metrics.py             # Prometheus
│   ├── models/                    # users, auth_identities, devices, consents,
│   │                              # user_settings, refresh_tokens (← 2.3),
│   │                              # password_reset_tokens (← 2.3), audit_log,
│   │                              # sessions, messages, session_summaries,
│   │                              # memory_facts, journal_entries, rituals,
│   │                              # ritual_completions, checkins, news,
│   │                              # support_resources, sos_events, push_tokens,
│   │                              # deletion_requests
│   ├── schemas/                   # Pydantic v2 по openapi.yaml + errors.py (← 2.7)
│   ├── repositories/
│   ├── services/
│   │   ├── auth_service.py        # device/email login, refresh-ротация (← 2.2)
│   │   ├── email_code_service.py  # ← шаблон cabinet_2fa_service.py (2.5)
│   │   ├── rate_limit_service.py  # ← UnionApp 1:1 (2.4)
│   │   ├── anti_spam_service.py   # ← UnionApp скелет + наши action'ы (2.4)
│   │   ├── user_service.py        # профиль, настройки, consents, факты памяти
│   │   ├── deletion_service.py    # «стереть всё» (каскад, аудит)
│   │   ├── session_service.py     # CRUD сессий, история, finish
│   │   ├── dialog_orchestrator.py # конвейер реплики: ASR→safety→эмоции→
│   │   │                          # retrieval→LLM→TTS, кризисный протокол
│   │   ├── memory_service.py      # суммаризация, консолидация, retrieval pgvector
│   │   ├── crisis_service.py      # двухступенчатый классификатор, скрипты
│   │   ├── journal_service.py, ritual_service.py, checkin_service.py
│   │   ├── news_service.py, support_service.py, sos_service.py
│   │   ├── push_service.py        # APNs/FCM/RuStore
│   │   └── llm/                   # GigaChat, SaluteSpeech ASR/TTS, классификаторы
│   ├── api/
│   │   ├── deps.py                # ← 2.6 + фабрики сервисов
│   │   ├── middleware.py          # заголовки→ContextVars (раздел 7), security headers
│   │   ├── router.py
│   │   ├── v1/                    # роутеры по тегам openapi.yaml
│   │   └── ws/                    # WebSocket-менеджер сессий (api.md раздел 5)
│   └── workers/
│       ├── worker.py              # Arq worker (Redis Sentinel queue)
│       └── tasks.py               # суммаризация, консолидация памяти (L3),
│                                  # генерация пушей, календарные триггеры,
│                                  # каскадное удаление, дайджесты
├── alembic/
└── tests/
```

## 6. Конфигурация (проектное правило env-config-rules)

По `.agents/skills/env-config-rules`:

- Все env — в `app/core/config.py`, `Field(validation_alias="ENV_NAME")` на
  каждое поле, дефолты у всего опционального; `os.getenv` вне config.py запрещён.
- Доменные Settings-наследники `BaseAppSettings`: `AppSettings`,
  `DatabaseSettings`, `RedisSettings`, `JwtSettings` (`JWT_SECRET_KEY` —
  `SecretStr`, `ACCESS_TOKEN_EXPIRE_MINUTES=15`,
  `REFRESH_TOKEN_EXPIRE_DAYS=30`, `REFRESH_TOKEN_ROTATION_GRACE_SECONDS=10`),
  `SecuritySettings` (`TRUSTED_PROXY_IPS` — JSON list, все `*_RATE_LIMIT`/`*_COOLDOWN`
  из api.md 9.3), `GigaChatSettings`, `SaluteSpeechSettings`,
  `LangfuseSettings`, `FeatureFlags`.
- Агрегатор `Config` + неизменяемый синглтон `APP_CONFIG`; производные URL —
  `@property`.
- Fail-fast: невалидные пути/обязательные значения роняют старт.
- `*_IS_HARD_HEALTH` при старте: PostgreSQL — `hard`, Redis — `hard`
  (auth fail-closed без него), GigaChat/SaluteSpeech — `hard` (core-функция),
  Langfuse — `soft`, ClickHouse — `soft`.

## 7. Логирование и сквозные заголовки (проектные правила)

По `.agents/skills/logging-rules` и `.agents/skills/api-headers-rules`:

- loguru + `LoguruPatcher` + ContextVars: три sink'а — `app.log`,
  `app-metric.log`, `events.log`; ротация `LOG_ROTATION` (дефолт 10 MB).
- Middleware извлекает белый список заголовков (`x-trace-id`→rqUId,
  `x-request-time`, `x-client-id`, `x-session-id`, `x-user-id`) в ContextVars
  один раз; сервер **не генерирует** rqUId сам.
- Каждый исходящий HTTP-вызов (GigaChat, SaluteSpeech, Langfuse) несёт все 5
  заголовков из ContextVars.
- Маскирование обязательно: тексты сообщений пользователей → `***`, PII —
  `mask_pii_*`; флаг `MASK_ENABLED` (дефолт true).
- WS-контур и фоновые задачи (нет HTTP-контекста) — явный
  `logger.bind(rqUId=...)` при старте задачи/соединения.
- Метрики и аудит — только через `bind(target="metric"|"audit-event")`.
- Служебные эндпоинты (`/health`, `/metrics`, `/openapi.json`) не логируются.

## 8. Фоновые задачи — Arq

Выбор — **Arq** (async-native, очередь в Redis Sentinel, который уже есть в
контуре; Celery тяжелее и синхронен по духу). Задачи (по спеке 6.2):

| Задача | Триггер | Что делает |
|---|---|---|
| `summarize_session` | `POST /sessions/{id}/finish` | L1-саммари: темы, эмоции, tension до/после, key_facts |
| `consolidate_memory` | после сессии + еженедельно (cron) | L2/L3: обновление `memory_facts` с confidence, «что помогает именно ему» |
| `generate_pushes` | cron + события | тёплые персональные пуши из памяти, тихие часы, тайминг из паттернов |
| `calendar_triggers` | cron | пуши к событиям календаря |
| `cascade_delete_user` | `DELETE /users/me` | полное удаление данных + аудит в `deletion_requests` |
| `component_call_log` | каждый вызов компонента | лог в ClickHouse с тегом окружения (антифрод-прозрачность, метрика конкурса) |

Каждая задача пишет `component_calls` отдельными типами вызовов; тестовые и
отладочные вызовы исключаются тегом окружения.

## 9. WebSocket-контур

- Менеджер соединений `app/api/ws/`: 1 активное соединение на пользователя
  (новое закрывает старое кодом 4003), буфер последних 200 серверных событий
  сессии в Redis (reconnect по `last_event_id`), дедупликация `client_msg_id`.
- `session_token` (TTL 300 сек) — отдельный короткоживущий JWT назначения
  «ws», выдаётся в `POST /sessions`; проверяется при upgrade.
- Конвейер реплики (`dialog_orchestrator`): ASR-стрим (SaluteSpeech) →
  `transcript.partial/final` → safety-классификатор (каждое сообщение;
  `level=red` → `crisis.intervention` перекрывает всё) → эмоции → retrieval
  памяти (pgvector + вес давности + «время с последней сессии») → GigaChat
  стрим (`llm.token`) → TTS-стрим (`tts.chunk`, кэш ритуалов и типовых фраз).
- Таймауты и close-коды — по таблице api.md 5.5; heartbeats — серверный контроль
  60 сек тишины клиента.

## 10. Соответствие контракту

Реализация сверяется с `docs/api.md` и `docs/openapi.yaml` (эндпоинты 1:1).
Лимиты (9.3), коды ошибок (1.3), модели данных (раздел 8 api.md) — единый
источник истины; расхождения правятся в коде или в контракте отдельным решением,
не «по месту».
