# Tasks: add-backend-profile-settings

Контракт: specs/user-profile/spec.md этого change'а + docs/openapi.yaml (тег `users`). Решения — design.md (D1–D6). Зависит от change add-backend-foundation-auth (auth, каркас). Open Questions на состав задач не влияют (пороги — в конфиг).

## 1. Конфиг

- [ ] 1.1 Добавить в `app/core/config.py`: `ENCRYPTION_KEY` (SecretStr), порог антизависимого контура (`SOFT_RECO_DAILY_MINUTES=90`, `SOFT_RECO_WINDOW_DAYS=3`), список `AVAILABLE_VOICES` (2–3 голоса). Приёмка: все значения через `validation_alias`, дефолты совпадают со specs/user-profile

## 2. Модели и миграции

- [ ] 2.1 Реализовать ORM-модели `user_settings` (user_id PK/FK, voice_id, theme, notifications/privacy/limits jsonb — design.md D3), `memory_facts` (category, text, confidence, source, updated_at), `push_tokens` (user_id+device_id unique, provider, push_token), `deletion_requests` (status, requested_at, completed_at). Приёмка: поля соответствуют схемам docs/openapi.yaml (UserSettings, MemoryFact, UserState)
- [ ] 2.2 Создать миграцию Alembic `0003_user_profile` (4 таблицы). Приёмка: `alembic upgrade head` + `downgrade` на чистой dev-БД без ошибок

## 3. Репозитории

- [ ] 3.1 Реализовать `UserSettingsRepository` (get_or_create с дефолтами, update секций с глубоким мержем — design.md D3). Приёмка: тест — PATCH только quiet_hours не затирает остальные поля
- [ ] 3.2 Реализовать `MemoryFactRepository` (list с фильтром category + cursor, update text с пометкой source=user_edit, delete с проверкой владельца). Приёмка: юнит-тесты каждого метода, чужой факт недоступен
- [ ] 3.3 Реализовать `PushTokenRepository` (upsert по user_id+device_id — design.md D6) и `DeletionRequestRepository` (create, mark_completed). Приёмка: тест идемпотентности upsert; запись аудита без контента

## 4. Сервисы

- [ ] 4.1 Реализовать `user_service.py`: GET/PATCH профиля (age_group enum, дата рождения не хранится), флаги is_anonymous/has_email/age_confirmed/consents_completed. Приёмка: сценарии specs/user-profile «Профиль пользователя» покрыты тестами
- [ ] 4.2 Реализовать `settings_service.py`: GET (настройки + available_voices из конфига), PATCH с мержем и валидацией voice_id. Приёмка: сценарии specs/user-profile «Настройки пользователя» покрыты тестами
- [ ] 4.3 Реализовать факты памяти в `user_service.py`: list/patch/delete по specs/user-profile «Прозрачность фактов памяти». Приёмка: сценарии требования покрыты тестами, правка ставит source=user_edit
- [ ] 4.4 Реализовать `deletion_service.py` + Celery-задачу `cascade_delete_user` (design.md D1): реестр таблиц с user_id, отзыв refresh-токенов на старте, пошаговое удаление с ретраями, аудит в deletion_requests. Приёмка: тест — после каскада данных пользователя нет ни в одной таблице реестра; повторный запуск задачи безопасен
- [ ] 4.5 Реализовать тест полноты реестра каскада (design.md D1): таблица с колонкой user_id вне реестра роняет тест. Приёмка: добавление фиктивной таблицы с user_id ломает тест
- [ ] 4.6 Реализовать `state_service.py` (design.md D5): агрегация minutes_today, soft_recommendation по скользящему окну, who5_last, clean_time_seconds, streak. Приёмка: сценарии specs/user-profile «Состояние дня» покрыты тестами
- [ ] 4.7 Реализовать регистрацию пуш-токена в `push_service.py` (только регистрация, без отправки). Приёмка: сценарии specs/user-profile «Регистрация пуш-токенов» покрыты тестами

## 5. Роутеры

- [ ] 5.1 Реализовать роутер `app/api/v1/users.py`: `GET/PATCH /users/me`, `DELETE /users/me` (202 + deletion_request_id), `GET/PATCH/DELETE /users/me/facts[/{id}]` по docs/openapi.yaml (operationId getMe/updateMe/deleteMe/listMemoryFacts/updateMemoryFact/deleteMemoryFact). Приёмка: интеграционные тесты — ответы и коды 1:1 specs/user-profile
- [ ] 5.2 Добавить в роутер `app/api/v1/users.py`: `GET/PATCH /users/me/settings`, `PUT /users/me/devices/current/push-token`, `GET /users/me/state` (operationId getSettings/updateSettings/putPushToken/getMyState). Приёмка: интеграционные тесты по сценариям specs/user-profile

## 6. Тесты

- [ ] 6.1 Юнит-тесты сервисного слоя (задачи 4.1–4.7) до полного покрытия сценариев specs/user-profile. Приёмка: каждый сценарий spec имеет зелёный тест
- [ ] 6.2 Интеграционный тест «стереть всё» end-to-end: пользователь с сессиями/фактами/настройками → DELETE → каскад → 404 на профиль, пустые таблицы, запись в deletion_requests. Приёмка: прогон на тестовой БД зелёный
- [ ] 6.3 Тест необратимости и приватности удаления: после каскада токены не валидны (401), в audit/логах нет контента пользователя. Приёмка: тест зелёный

## 7. Деплой

- [ ] 7.1 Добавить `ENCRYPTION_KEY` и пороги антизависимого контура в k8s secret и `.env.example` (плейсхолдеры `<CHANGE_ME_*>`). Приёмка: конфиг стартует в кластере, секретов в git нет
- [ ] 7.2 Smoke в кластере: PATCH settings → GET state → DELETE users/me на тестовом аккаунте → каскад завершён. Приёмка: deletion_requests содержит запись, повторный вход с того же устройства создаёт нового пользователя
