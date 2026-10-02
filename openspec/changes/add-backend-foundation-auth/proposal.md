# Proposal: add-backend-foundation-auth

## Why

У продукта есть утверждённая OpenAPI-заготовка (docs/openapi.yaml, 41 операция), но нет самого backend-сервиса. Это первый change дорожной карты backend: без каркаса приложения (конфиг, логирование, ошибки, middleware) и auth-контура (анонимный вход, токены, антиспам) невозможно строить остальные capability (sessions/streaming, profile/settings, journal/rituals/checkins, content) — каждая из них опирается на аутентифицированного пользователя, единый формат ошибок и rate-limit инфраструктуру.

## What Changes

- **Каркас сервиса** `backend/` (Python 3.12, FastAPI): слоистая структура `app/` (api/v1, services, repositories, models, schemas, core — design.md D10), конфиг по env-config-rules (pydantic-settings, `validation_alias`, `SecretStr`, fail-fast, агрегатор `APP_CONFIG`), логирование по logging-rules (loguru + ContextVars + patcher, три sink'а, маскирование), единые exception handlers с форматом ошибок `{"error":{code,message,details}}` и каталогом кодов из specs/backend-foundation.
- **Middleware заголовков** по api-headers-rules: извлечение белого списка (x-trace-id/rqUId, x-request-time, x-client-id, x-session-id, x-user-id) в ContextVars; security-headers middleware; определение реального IP через trusted-proxy XFF (паттерн UnionApp `deps.py:150-197`).
- **Health/version эндпоинты** (служебные, вне `/api/v1`, не логируются, не отдаются наружу через HTTPRoute).
- **Auth-контур** по specs/auth: `POST /auth/device` (анонимный вход device_id+device_key, идемпотентный), `POST /auth/email/link` + `/confirm` (6-значный код в Redis, TTL 600 сек, max 5 попыток), `POST /auth/email/login`, `POST /auth/refresh` (ротация + family-revoke, grace-окно 10 сек), `POST /auth/logout`, `POST /auth/password-reset/request` + `/confirm` (opaque-токен TTL 30 мин, anti-enumeration), `POST /users/me/consents` (18+, дисклеймер, оферта). JWT access HS256 TTL 15 мин + opaque refresh TTL 30 дней (SHA-256 хэш в БД, `device_id`), argon2id — паттерны из UnionApp (design.md D1–D4, прямые пути `/Users/aleksandrsamofalov/PycharmProjects/UnionApp/SevenElementBackend`).
- **Антиспам для auth**: rate_limit_service (sliding window на Redis ZSET, cooldown `SET NX EX`) + anti_spam_service с лимитами из specs/auth «Rate-limit и антиспам auth-контуров» (device 20/час/IP, email login 10/5 мин/IP, link 5 кодов/час, reset 1/21 час по IP и хэшу email), 429 + `Retry-After`, fail-closed (503) для auth-критичных контуров при недоступном Redis.
- **Security-аудит**: события auth (login/link/reset/family-revoke/блокировки антиспама) в `audit_log` (IP/UA/masked-контакты) + Prometheus-метрики.
- **Модели и миграции Alembic**: `users`, `auth_identities`, `devices`, `consents`, `refresh_tokens`, `password_reset_tokens`, `audit_log`.
- **Деплой**: Dockerfile (multi-stage), k8s-манифесты в ns `backend` (Deployment, Service, HTTPRoute `/api` по шаблону k8s/istio/manifests/00-example-gateway.yaml, imagePullSecrets `registry-pull`, env из secret `db-credentials`), Job миграций Alembic.

Вне scope (следующие change'ы): сессии и WebSocket-стриминг, профиль/настройки/факты памяти/«стереть всё», журнал/ритуалы/чекины, новости/support/SOS, LLM-интеграции (GigaChat/SaluteSpeech), фоновые воркеры, ClickHouse.

## Capabilities

### New Capabilities

- `backend-foundation`: каркас сервиса — конфиг по env-config-rules, логирование по logging-rules, middleware заголовков и security-headers, trusted-proxy XFF, единый формат ошибок и exception handlers, health/version эндпоинты, слоистая структура приложения.
- `auth`: аутентификация и безопасность доступа — device-based анонимный вход, привязка email с кодом верификации, вход по email/паролю, механика токенов (JWT access + opaque refresh с ротацией и family-revoke), сброс пароля с anti-enumeration, согласия (18+/дисклеймер/оферта), rate-limit и антиспам auth-контуров, security-аудит.

### Modified Capabilities

(пусто — существующих specs в openspec/specs/ нет, это первый change)

## Impact

- **Новый код**: каталог `backend/` (приложение FastAPI, Alembic, тесты pytest).
- **API**: 9 новых REST-эндпоинтов из docs/openapi.yaml (auth + consents) — контракт уже зафиксирован, реализация обязана соответствовать 1:1.
- **БД**: новая схема в БД `backend` (CNPG-кластер, ns `ryadom-db`), PG-юзер `developer`; 7 таблиц через Alembic-миграции.
- **Инфраструктура**: Redis+Sentinel (rate-limit ключи, email-коды, идемпотентность); k8s ns `backend` — первый workload; HTTPRoute на корневом домене, path `/api`; образы `cr.yandex/crpsqeamqpuvrkm5tpr9/backend/<service>:<tag>`.
- **Зависимости Python**: fastapi, uvicorn, pydantic v2, pydantic-settings, sqlalchemy[asyncio], asyncpg, alembic, redis, pyjwt, pwdlib[argon2], loguru, prometheus-client, httpx (тесты), pytest, pytest-asyncio.
- **Референс копирования**: UnionApp `SevenElementBackend` (app/core/security.py, app/services/auth_service.py, rate_limit_service.py, anti_spam_service.py, cabinet_2fa_service.py, app/api/deps.py, app/models/refresh_token.py, password_reset_token.py, app/schemas/errors.py).
- **Секреты**: только через k8s secrets (`db-credentials`, JWT-секрет), в git — плейсхолдеры `<CHANGE_ME_*>`.
