# Tasks: add-backend-foundation-auth

Контракт: specs/backend-foundation/spec.md и specs/auth/spec.md этого change'а + docs/openapi.yaml (9 операций auth + consents). Решения — design.md (D1–D11), референс копирования — UnionApp `/Users/aleksandrsamofalov/PycharmProjects/UnionApp/SevenElementBackend` (пути и строки в design.md). Open Questions из design.md на состав задач не влияют (email-провайдер — за интерфейсом, CIDR — значение при деплое).

## 1. Каркас и конфигурация

- [ ] 1.1 Инициализировать проект `backend/` (pyproject.toml, Python 3.12, зависимости из proposal.md → Impact) со структурой каталогов по design.md D10. Приёмка: `uvicorn app.main:app` стартует, слои `api/services/repositories/models/schemas/core` существуют
- [ ] 1.2 Реализовать `app/core/config.py` по design.md D7 (.agents/skills/env-config-rules): доменные Settings с `validation_alias`, `SecretStr` для секретов, fail-fast валидация, агрегатор `APP_CONFIG`, `*_IS_HARD_HEALTH`. Приёмка: старт без обязательной env падает с понятной ошибкой; `os.getenv` вне config.py отсутствует (проверка grep'ом)
- [ ] 1.3 Реализовать логирование `app/logger/` по design.md D7 (.agents/skills/logging-rules): loguru + patcher + ContextVars, три sink'а (app.log / app-metric.log / events.log), маскирование PII, `NON_LOGGED_ENDPOINTS`. Приёмка: запись из тестового эндпоинта содержит rqUId/systemId из ContextVars; email в логе маскируется
- [ ] 1.4 Реализовать middleware заголовков по design.md D7 (.agents/skills/api-headers-rules) и specs/backend-foundation «Обработка сквозных заголовков запроса»: извлечение белого списка в ContextVars, сервер не генерирует rqUId. Приёмка: запрос без `x-trace-id` обрабатывается, rqUId в логах пуст; заголовки вне белого списка в логи не попадают
- [ ] 1.5 Реализовать security-headers middleware по specs/backend-foundation «Security-заголовки ответов»: `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Strict-Transport-Security`, `Cache-Control: no-store` для auth-эндпоинтов. Приёмка: заголовки присутствуют в ответах (интеграционный тест)
- [ ] 1.6 Реализовать единый формат ошибок по specs/backend-foundation «Единый формат ошибок» и design.md D6 (механика UnionApp `app/schemas/errors.py`): каталог кодов SCREAMING_SNAKE, `ErrorResponse.from_code` с RU-сообщениями, exception handlers (доменные исключения → код/статус, валидация → 422 с полевыми ошибками, Exception → 500 `INTERNAL_ERROR`), 429 с `Retry-After`. Приёмка: тест на каждый класс исключений; в 500 нет внутренних деталей
- [ ] 1.7 Реализовать health/version эндпоинты вне `/api/v1` по specs/backend-foundation «Служебные эндпоинты»: liveness, readiness с проверкой PostgreSQL и Redis, version. Приёмка: readiness возвращает ошибку при остановленной зависимости; эндпоинты не логируются
- [ ] 1.8 Реализовать `app/core/db.py` (async engine, `get_db_session`) и `app/core/redis.py` (Redis Sentinel client) с `*_IS_HARD_HEALTH` при старте. Приёмка: при `PG_IS_HARD_HEALTH=true` и недоступной БД сервис не стартует
- [ ] 1.9 Реализовать `get_request_security_context` + `_is_trusted_proxy` в `app/api/deps.py` по UnionApp `app/api/deps.py:116-197` (design.md D3) и specs/backend-foundation «Определение реального IP клиента»: XFF только от trusted CIDR, последний адрес цепочки. Приёмка: юнит-тесты — доверенный прокси/подделка XFF/битая запись CIDR

## 2. Модели и миграции

- [ ] 2.1 Реализовать ORM-модели `users`, `auth_identities`, `devices`, `consents` по design.md D11 и D2 (base-миксины UUID PK + created_at — по UnionApp `app/models/base.py`). Приёмка: модели импортируются, поля и связи соответствуют design.md D11
- [ ] 2.2 Реализовать ORM-модели `refresh_tokens`, `password_reset_tokens`, `audit_log` — 1:1 по UnionApp `app/models/refresh_token.py` / `app/models/password_reset_token.py` (design.md D11): `token_hash` unique, `device_id`, `expires_at` index, `revoked_at`/`used_at`. Приёмка: поля и индексы соответствуют референсу
- [ ] 2.3 Создать Alembic-окружение и миграцию `0001_initial` (7 таблиц). Приёмка: `alembic upgrade head` + `downgrade base` проходят на чистой dev-БД без ошибок

## 3. Репозитории

- [ ] 3.1 Реализовать `UserRepository` (get_by_id, get_by_identity, create с identity) и `AuthIdentityRepository` по design.md D2. Приёмка: юнит-тесты на тестовой БД — создание пользователя с device-identity, поиск по email-identity
- [ ] 3.2 Реализовать `AuthRepository` по UnionApp `app/repositories/auth_repository.py` (design.md D1): `get_active_refresh_token`, `get_refresh_token_by_hash`, `create_refresh_token`, `revoke_refresh_token`, `revoke_refresh_tokens_for_user`, `mark_password_reset_token_used`, инвалидация предыдущих reset-токенов. Приёмка: юнит-тесты на каждый метод
- [ ] 3.3 Реализовать `AuditLogRepository` и `ConsentRepository` по design.md D11. Приёмка: запись аудит-события с masked-контактом; фиксация и чтение согласий пользователя

## 4. Сервисы

- [ ] 4.1 Перенести `app/core/security.py` из UnionApp по design.md D1 (JWT HS256 15 мин, opaque refresh 48 байт, reset-токен 32 байта, argon2id, `hash_token`) с доработками (без claim `login`, только type `access`). Приёмка: юнит-тесты выдачи/валидации JWT, verify argon2, хэш токена
- [ ] 4.2 Перенести `rate_limit_service.py` 1:1 (RedisRateLimitBackend ZSET, cooldown SET NX EX, NoOp, InMemory) — design.md D3. Приёмка: юнит-тесты sliding window и cooldown на InMemoryRateLimitBackend
- [ ] 4.3 Реализовать `anti_spam_service.py` с action'ами `device_login`, `email_login`, `email_link`, `password_reset` и лимитами из specs/auth «Rate-limit и антиспам auth-контуров» (все пороги/окна — из конфига), `build_contact_handles`, маскирование, `record_forgot_password_request` (cooldown для несуществующего email). Приёмка: юнит-тесты каждого `evaluate_*` и anti-enumeration cooldown
- [ ] 4.4 Реализовать `auth_service.py`: `POST /auth/device` (идемпотентный вход, несовпадение device_key → 401) и `POST /auth/email/login` (одинаковый ответ для нет email/неверный пароль) по specs/auth «Анонимный вход по устройству» и «Вход по email и паролю». Приёмка: сценарии этих требований покрыты тестами
- [ ] 4.5 Реализовать ротацию refresh с family-revoke в `auth_service.py` по UnionApp `app/services/auth_service.py:723-770` + `logout` (:772-782) — specs/auth «Ротация refresh-токенов с защитой от replay» и «Выход». Приёмка: тесты — нормальная ротация, повтор в grace-окне 10 сек, replay вне окна → отзыв всех refresh + аудит
- [ ] 4.6 Реализовать флоу привязки email `email_code_service.py` по шаблону UnionApp `app/services/cabinet_2fa_service.py` (design.md D4): namespace `email_link`, код 6 цифр, TTL 600 сек, 5 попыток, single-use, `compare_digest`, код не логируется; привязка с argon2id-паролем, 409 на занятый email. Приёмка: сценарии specs/auth «Привязка email с подтверждением кодом» покрыты тестами
- [ ] 4.7 Реализовать сброс пароля по specs/auth «Сброс пароля без раскрытия аккаунта» и UnionApp `app/services/auth_service.py:663-683`: opaque-токен TTL 30 мин (хэш в БД), инвалидация предыдущих, письмо до коммита с rollback, одинаковый ответ для любого email, после confirm — отзыв всех refresh + письмо-уведомление. Приёмка: сценарии требования покрыты тестами
- [ ] 4.8 Реализовать `EmailSender`-протокол и реализацию-заглушку по design.md D5 (masked-получатель в лог + аудит-событие), точка расширения под production-провайдера. Приёмка: сервисы зависят от протокола; сбой отправки reset-письма откатывает транзакцию (тест)
- [ ] 4.9 Реализовать `consent_service.py` по specs/auth «Согласия и подтверждение возраста»: фиксация 18+/дисклеймер/оферта с версией, `age_confirmed=false` → 403 `AGE_RESTRICTED`. Приёмка: сценарии требования покрыты тестами
- [ ] 4.10 Реализовать security-аудит во всех auth-сервисах по specs/auth «Security-аудит auth-событий»: login/link/reset/family-revoke/logout/блокировки антиспама в `audit_log` (IP/UA/masked) + Prometheus-счётчики без PII. Приёмка: тесты проверяют запись события и отсутствие секретов/токенов в payload

## 5. Роутеры и DI

- [ ] 5.1 Реализовать DI-фабрики в `app/api/deps.py` (сервисы, репозитории, rate-limit backend) + `get_current_user` по UnionApp `app/api/deps.py:505-619` (401 `AUTH_TOKEN_EXPIRED`/`AUTH_TOKEN_INVALID`). Приёмка: защищённый эндпоинт отклоняет запрос без токена и с истёкшим токеном (тест)
- [ ] 5.2 Реализовать роутер `app/api/v1/auth.py`: `POST /auth/device`, `/auth/email/login`, `/auth/refresh`, `/auth/logout` с fail-closed 503 при недоступном Redis (design.md D3) и Pydantic-схемами по docs/openapi.yaml (DeviceLoginRequest, EmailLoginRequest, RefreshRequest, AuthResponse, TokenPair). Приёмка: ответы и коды ошибок 1:1 specs/auth (интеграционные тесты)
- [ ] 5.3 Реализовать роутер привязки email: `POST /auth/email/link`, `/auth/email/link/confirm` по specs/auth «Привязка email с подтверждением кодом» (схемы EmailLinkRequest, EmailLinkConfirmRequest из docs/openapi.yaml). Приёмка: интеграционные тесты по сценариям требования
- [ ] 5.4 Реализовать роутер сброса пароля: `POST /auth/password-reset/request`, `/auth/password-reset/confirm` по specs/auth «Сброс пароля без раскрытия аккаунта». Приёмка: ответ request идентичен для существующего/несуществующего email (тест)
- [ ] 5.5 Реализовать роутер `POST /users/me/consents` по specs/auth «Согласия и подтверждение возраста» (auth Bearer обязателен). Приёмка: интеграционные тесты по сценариям требования
- [ ] 5.6 Собрать `app/main.py`: lifespan (init зависимостей с `*_IS_HARD_HEALTH`), middleware (заголовки → ContextVars, security-headers), exception handlers, роутеры под `/api/v1`, служебные эндпоинты вне префикса. Приёмка: OpenAPI приложения содержит 9 операций auth+consents, совпадающих с docs/openapi.yaml (operationId)

## 6. Тесты

- [ ] 6.1 Настроить pytest + pytest-asyncio + httpx AsyncClient, тестовую БД (отдельная схема) и fake Redis/InMemoryRateLimitBackend в фикстурах. Приёмка: `pytest` зелёный в CI-локальном окружении
- [ ] 6.2 Покрыть юнит-тестами сервисный слой auth (тесты из задач 4.1–4.10 довести до полного покрытия сценариев specs/auth). Приёмка: каждый сценарий spec auth имеет зелёный тест
- [ ] 6.3 Покрыть интеграционными тестами все 9 эндпоинтов: успех, 401/403/409/422/429/503 по specs/backend-foundation «Единый формат ошибок» и specs/auth. Приёмка: прогон против поднятого приложения с тестовой БД и Redis
- [ ] 6.4 Тест fail-closed: при остановленном Redis auth-эндпоинты возвращают 503 `SERVICE_UNAVAILABLE`, прочие лимиты fail-open (specs/auth «Rate-limit и антиспам auth-контуров»). Приёмка: тест с недоступным Redis зелёный

## 7. Деплой-манифесты

- [ ] 7.1 Написать multi-stage `backend/Dockerfile` (сборка зависимостей → slim runtime, non-root user) по design.md D9. Приёмка: образ собирается, контейнер стартует локально с env из `.env.example`
- [ ] 7.2 Написать `backend/.env.example` со всеми env из config.py (плейсхолдеры `<CHANGE_ME_*>`, без секретов). Приёмка: список env полностью покрывает обязательные поля конфига
- [ ] 7.3 Написать k8s-манифесты в `k8s/backend/`: Deployment (imagePullSecrets `registry-pull`, env из secret `db-credentials` + JWT-secret, resources, probes на health), Service, по design.md D9. Приёмка: `kubectl apply --dry-run=server` проходит; секретов в манифестах нет
- [ ] 7.4 Написать HTTPRoute path `/api` по шаблону `k8s/istio/manifests/00-example-gateway.yaml` (замена `<CHANGE_ME_PATH_PREFIX>`): наружу только `/api/v1/*`, служебные пути фильтруются. Приёмка: dry-run проходит; `/metrics`, `/health`, `/docs`, `/openapi.json` не маршрутизируются
- [ ] 7.5 Написать Job миграций Alembic (тот же образ, `alembic upgrade head`) по design.md раздел Migration Plan. Приёмка: Job успешно применяет миграции на БД `backend` в кластере
- [ ] 7.6 Smoke в кластере: собрать/запушить образ в `cr.yandex/crpsqeamqpuvrkm5tpr9/backend/api`, применить манифесты, проверить `POST /api/v1/auth/device` через корневой домен. Приёмка: ответ 200 с парой токенов; событие login в audit_log; метрики в Prometheus
