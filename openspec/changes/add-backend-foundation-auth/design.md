# Design: add-backend-foundation-auth

## Context

Сервис создаётся с нуля в каталоге `backend/`. Контракт — specs/backend-foundation/spec.md и specs/auth/spec.md этого change'а + docs/openapi.yaml (9 операций auth + consents: deviceLogin, linkEmail, confirmEmailLink, emailLogin, refreshTokens, logout, requestPasswordReset, confirmPasswordReset, acceptConsents). Референс — UnionApp `/Users/aleksandrsamofalov/PycharmProjects/UnionApp/SevenElementBackend` с готовыми паттернами безопасности (пути и строки — в Decisions). Инфраструктура готова: ns `backend`, БД `backend` (PG-юзер `developer`), Redis+Sentinel, HTTPRoute-шаблон `k8s/istio/manifests/00-example-gateway.yaml`. Мотивация — см. proposal.md (Why).

## Goals / Non-Goals

**Goals:**

- Воспроизвести проверенные паттерны UnionApp (токены, антиспам, deps) с минимальными осознанными отличиями, а не изобретать заново.
- Каркас, пригодный для всех последующих capability: DI-сборка, конфиг, логирование, ошибки — без доработок при добавлении sessions/profile/journal.
- Контракт specs (backend-foundation, auth) + docs/openapi.yaml — источник истины: код сверяется с ним, а не наоборот.
- Деплой в существующий кластер по готовым шаблонам (HTTPRoute, imagePullSecrets, secrets).

**Non-Goals:**

- Любые эндпоинты за пределами auth + consents + health/version (остальное — следующие change'ы).
- LLM/ASR/TTS-интеграции, WebSocket, фоновые воркеры, ClickHouse.
- Отправка email через production-сервис — за интерфейсом `EmailSender` (см. Decisions), реальный провайдер настраивается отдельно.
- Админ-контур и RBAC (нет ролей в продукте v0).

## Decisions

### D1. Копирование security-паттернов UnionApp как есть

`app/core/security.py` UnionApp переносится почти 1:1 (151 строка: JWT HS256 15 мин — `create_access_token` :72-99, opaque refresh `token_urlsafe(48)` — :102-111, argon2id через `pwdlib` — :16, :60-65, SHA-256 хэши токенов — `hash_token` :68-69, валидация JWT — :126-151). Доработки при переносе: claim `login` не нужен (`sub` = user UUID), `JWTTokenType` — только `ACCESS`, роли/organization-claims не переносим. Ротация refresh с family-revoke — по `auth_service.py:723-770` (grace-окно 10 сек), выдача пары — `_issue_rotated_tokens` :685-721 с наследованием `device_id` (:717).

**Почему:** паттерн проверен в бою, покрывает replay-атаку семейства токенов; самостоятельная реализация — чистый риск без выигрыша.

**Альтернативы:** stateful access-токены (jti + проверка в БД) — отвергнуто: лишний запрос в БД на каждый запрос, TTL 15 мин достаточен; хранение refresh в JWT — отвергнуто: нельзя отозвать точечно.

### D2. Гибридная идентичность через `auth_identities`

Пользователь — `users`; способы входа — строки `auth_identities` (kind `device`/`email`, `identifier`, `secret_hash`). Device-вход создаёт пользователя с identity kind=`device`; привязка email добавляет identity kind=`email` тому же `user_id`; email-login находит пользователя по identity.

**Почему:** соответствует контракту (анонимный вход по умолчанию, email опционален, история переживает смену устройства); не дублирует пользователей при входе с нового устройства.

**Альтернативы:** отдельные таблицы device/email аккаунтов — отвергнуто: усложняет слияние и восстановление.

### D3. Антиспам в сервисном слое, без middleware-библиотек

`rate_limit_service` (UnionApp `app/services/rate_limit_service.py`, 149 строк: `RedisRateLimitBackend` — sliding window на ZSET :56-67, cooldown `SET NX EX` :75-84; `NoOpRateLimitBackend` :87-108 для локальной разработки; `InMemoryRateLimitBackend` :111-149 для тестов) + `anti_spam_service` (UnionApp `app/services/anti_spam_service.py`, 397 строк: `ContactHandle`/`build_contact_handles` :70-99, `evaluate_*` :121-219, `record_forgot_password_request` :251-265 — cooldown даже для несуществующего email, маскирование :377-397) с нашими action'ами `device_login`, `email_login`, `email_link`, `password_reset`. Лимиты и окна — только в конфиг. IP — через trusted-proxy XFF (UnionApp `deps.py:150-197`, `_is_trusted_proxy` :116-147), trusted CIDR = pod-сеть кластера.

**Почему:** slowapi и аналоги считают по `request.client.host` без trusted-proxy логики и не дают cooldown по хэшу контакта и anti-enumeration.

**Fail-closed для auth:** при недоступном Redis auth-эндпоинты отвечают 503 — как `get_cabinet_2fa_service` в UnionApp (`deps.py:233-258`).

### D4. Email-коды — обобщённый флоу по шаблону cabinet_2fa_service

Переносится `CabinetEmailCodeService` из UnionApp `app/services/cabinet_2fa_service.py` (обобщённый флоу :114+; namespace ключей :37-39 — `{ns}:pending:{token}`, `{ns}:user:{id}`, `{ns}:send:`; конфиг флоу `CabinetCodeFlowConfig` :76-86; TTL 600 сек, max 5 попыток, single-use, `compare_digest`, код не логируется) с нашим namespace `email_link`. Сам cabinet-флоу не переносим — только механизм.

**Почему:** готовый флоу с корректной инвалидацией и rate-limit отправки; cabinet-флоу как таковой не переносим — только механизм.

### D5. Отправка email — за протоколом `EmailSender`

Сервисный слой зависит от интерфейса отправки (reset-письмо, код привязки, уведомление о смене пароля). В v0 — реализация-заглушка (лог masked-получателя + событие) или SMTP по конфигу; выбор production-провайдера (Yandex Postbox — как в UnionApp `yandex_postbox.py`) — следующий шаг, не блокирует контракт.

**Почему:** сброс пароля требует отправки письма до коммита (rollback при сбое) — интерфейс нужен уже сейчас, а провайдер можно менять без touching бизнес-логики.

### D6. Формат ошибок и коды — SCREAMING_SNAKE

Механика UnionApp `app/schemas/errors.py` (:17-184: `ErrorCode` StrEnum, `ErrorResponse.from_code` с RU-сообщениями :105-115, `FieldErrorDetail` :75-83, `ValidationErrorResponse` :118-135) с каталогом кодов из specs/backend-foundation «Единый формат ошибок» (`AUTH_TOKEN_EXPIRED`, `RATE_LIMITED`, …) в SCREAMING_SNAKE, а не UnionApp'овские lowercase. Расхождение осознанное: единообразие внутри проекта важнее преемственности с референсом. 429 обязан нести `Retry-After` (`RateLimitExceededError.retry_after_seconds` — UnionApp `anti_spam_service.py:64-67`).

### D7. Конфиг и логирование — по проектным skills

`app/core/config.py` — по env-config-rules (доменные Settings, `validation_alias`, `SecretStr`, fail-fast, `APP_CONFIG`); `app/logger/` — по logging-rules (loguru + ContextVars + patcher, три sink'а, маскирование). Middleware заголовков — по api-headers-rules (только белый список, сервер не генерирует rqUId).

### D8. Миграции — Alembic, применение через k8s Job

Схема БД создаётся Alembic-миграциями; в кластере применяются отдельным Job (тот же образ, команда `alembic upgrade head`) перед rollout Deployment. Откат — `alembic downgrade` вручную; таблицы новые, даунтайм-миграций нет.

### D9. Деплой — multi-stage Dockerfile, образы только из YCR

Dockerfile multi-stage (сборка зависимостей → slim runtime, non-root); пуш в `cr.yandex/crpsqeamqpuvrkm5tpr9/backend/api:<tag>`; поды с `imagePullSecrets: registry-pull`; env из secret `db-credentials` + отдельный secret для JWT (создаются kubectl'ом, в git — плейсхолдеры `<CHANGE_ME_*>`); HTTPRoute path `/api` по шаблону `k8s/istio/manifests/00-example-gateway.yaml`; `/metrics`, `/health`, `/docs`, `/openapi.json` снаружи не отдаются.

### D10. Структура каталогов сервиса

Слоистый layout (роутеры → сервисы → репозитории → модели), рассчитанный на все последующие change'ы:

```
backend/
├── pyproject.toml
├── app/
│   ├── main.py                    # FastAPI app, lifespan, exception handlers
│   ├── core/                      # config.py, security.py, db.py, redis.py, metrics.py
│   ├── logger/                    # loguru + ContextVars + patcher, три sink'а
│   ├── models/                    # ORM-модели
│   ├── schemas/                   # Pydantic v2 схемы + errors.py
│   ├── repositories/
│   ├── services/
│   ├── api/
│   │   ├── deps.py                # DI-фабрики, get_current_user, security context
│   │   ├── middleware.py          # заголовки→ContextVars, security headers
│   │   ├── router.py
│   │   ├── v1/                    # роутеры по тегам docs/openapi.yaml
│   │   └── ws/                    # WebSocket-менеджер (change sessions-streaming)
│   └── workers/                   # Celery worker/beat, задачи (change'ы после foundation)
├── alembic/
└── tests/
```

Правила слоёв: роутер не ходит в БД напрямую — только через сервис; сервис — только через репозитории; коммит делает сервис (одна точка коммита на операцию); зависимости собираются в `app/api/deps.py` фабриками через `Annotated[..., Depends]` (паттерн UnionApp `deps.py:217-230`).

### D11. Модель данных этого change'а

Семь таблиц (БД `backend`), ключевые поля:

| Таблица | Поля | Назначение |
|---|---|---|
| `users` | id, display_name, age_group, is_active, created_at | Аккаунт (анонимный или с email) |
| `auth_identities` | id, user_id (FK), kind (`device`/`email`), identifier (device_id / email), secret_hash (device_key / argon2 пароль) | Способы входа (D2) |
| `devices` | id, user_id (FK), device_id, platform, app_version, last_seen_at | Устройства пользователя |
| `consents` | id, user_id (FK), kind, version, accepted_at | Согласия (18+, дисклеймер, оферта) |
| `refresh_tokens` | id, user_id (FK CASCADE), token_hash (unique), device_id, expires_at (index), revoked_at, created_at | 1:1 по UnionApp `app/models/refresh_token.py` (33 строки) |
| `password_reset_tokens` | id, user_id (FK CASCADE), token_hash (unique), expires_at (index), used_at, created_at | 1:1 по UnionApp `app/models/password_reset_token.py` (32 строки) |
| `audit_log` | id, actor_user_id, action, entity_type, entity_id, ip, user_agent, payload (jsonb), created_at | Security-события; контакты — только masked |

Email-коды верификации — НЕ таблица: живут в Redis (D4).

## Risks / Trade-offs

- [Нет production email-провайдера на момент реализации] → интерфейс `EmailSender` + заглушка; флоу сброса/привязки тестируется на fake-реализации, подключение провайдера — конфигурация без смены кода.
- [Grace-окно 10 сек допускает повторное использование отозванного токена] → осознанный trade-off ради сетевых гонок; replay вне окна убивает всё семейство, событие в аудите.
- [Fail-closed 503 при падении Redis делает auth недоступным] → осознанно: лучше отказ, чем перебор без лимитов; Redis в кластере с Sentinel, readiness-проба пода учитывает Redis.
- [Trusted CIDR pod-сети шире, чем один ingressgateway] → приемлемо: внутри pod-сети подделка XFF возможна только от других подов; NetworkPolicy ns `backend` уже ограничивает ingress; точечный список IP недостижим из-за динамических pod IP.
- [Первый rollout: Job миграций должен завершиться до старта подов] → Job в том же apply перед Deployment (sync-wave/ручной порядок), откат — downgrade.

## Migration Plan

1. Создать Alembic-миграцию `0001_initial` (7 таблиц: users, auth_identities, devices, consents, refresh_tokens, password_reset_tokens, audit_log).
2. Локально: `alembic upgrade head` против dev-БД; smoke-прогон auth-флоу.
3. Кластер: собрать и запушить образ → применить манифесты secrets (kubectl) → Job миграций → Deployment/Service/HTTPRoute.
4. Проверка: health через port-forward, затем `POST /api/v1/auth/device` через корневой домен.
5. Откат: удалить HTTPRoute/Deployment, `alembic downgrade base` (таблицы новые, данных нет).

## Open Questions

- Production email-провайдер (Yandex Postbox vs SMTP) — выбор при подключении, на контракт и задачи не влияет (D5).
- Точный CIDR pod-сети для `TRUSTED_PROXY_IPS` — берётся из кластера при деплое (`kubectl get nodes -o wide` / calico ippool), значение в secret/ConfigMap, не в git.
