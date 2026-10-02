# Tasks: add-backend-journal-rituals-checkins

Контракт: specs/wellbeing/spec.md этого change'а + docs/openapi.yaml (теги `journal`, `rituals`, `checkins`). Решения — design.md (D1–D6). Зависит от add-backend-foundation-auth (auth, идемпотентность, rate-limit) и add-backend-profile-settings (user_settings: тихие часы, timezone). Open Questions на состав задач не влияют (окна/тексты — конфиг и сид-данные).

## 1. Конфиг и фон

- [ ] 1.1 Добавить в `app/core/config.py`: `RitualSettings` (окна напоминаний утро/вечер, лимит чекинов 30/час) и `CelerySettings` (broker/backend Redis Sentinel, timezone beat). Приёмка: значения через `validation_alias`, дефолт лимита совпадает со specs/wellbeing
- [ ] 1.2 Настроить Celery app (worker + beat) по design.md D1: broker Redis Sentinel, регистрация задач, rqUId через logger.bind в задачах. Приёмка: worker и beat стартуют локально, тестовая задача выполняется

## 2. Модели и миграции

- [ ] 2.1 Реализовать ORM-модели `journal_entries` (kind, title, text_enc), `rituals` (kind, title, duration_seconds, content jsonb), `ritual_completions` (unique (ritual_id, user_id, date) — design.md D2), `checkins` (type, payload jsonb, score nullable). Приёмка: поля соответствуют схемам docs/openapi.yaml (JournalEntry, Ritual, Checkin)
- [ ] 2.2 Создать миграцию Alembic `0004_wellbeing` (4 таблицы) + сидирование базового каталога ритуалов (утро/вечер). Приёмка: `alembic upgrade head` + `downgrade` без ошибок; каталог заполнен

## 3. Репозитории

- [ ] 3.1 Реализовать `JournalRepository` (create с шифрованием text_enc, list с фильтрами kind/from/to/q + cursor, get/delete с проверкой владельца, list_all для экспорта). Приёмка: юнит-тесты — шифрование, фильтры, чужая запись недоступна
- [ ] 3.2 Реализовать `RitualRepository` (каталог, today для пользователя, complete с unique-идемпотентностью, history + cursor, выборки для streak). Приёмка: тест — повторный complete в тот же день не создаёт дубль (design.md D2)
- [ ] 3.3 Реализовать `CheckinRepository` (create, history с фильтрами + cursor, агрегаты who5_trend по неделям, последний срыв для clean_time). Приёмка: юнит-тесты агрегатов на фиксированных данных

## 4. Сервисы

- [ ] 4.1 Реализовать `journal_service.py`: CRUD + экспорт Markdown (design.md D6 — поиск q по title/странице). Приёмка: сценарии specs/wellbeing «Журнал» и «Экспорт журнала» покрыты тестами
- [ ] 4.2 Реализовать `ritual_service.py`: today (экземпляры дня + completed + streak), complete (идемпотентно, mood_note ≤ 500), history; streak как проекция completions (active/resting + resting_days, без обнуления — design.md D2). Приёмка: сценарии specs/wellbeing «Ритуалы дня», «Выполнение», «История» покрыты тестами
- [ ] 4.3 Реализовать `checkin_service.py`: дискриминированные payload-схемы (design.md D4), score = сумма × 4 для who5, идемпотентность по Idempotency-Key (design.md D5), лимит 30/час (action rate-limit). Приёмка: сценарии specs/wellbeing «Чекины состояния» покрыты тестами
- [ ] 4.4 Реализовать агрегаты истории в `checkin_service.py`: who5_trend по неделям, clean_time_seconds (design.md D4). Приёмка: сценарии specs/wellbeing «История чекинов» покрыты тестами
- [ ] 4.5 Реализовать beat-задачу `generate_daily_rituals` (design.md D3): персональные экземпляры дня из памяти пользователя, fallback на статичный каталог при сбое. Приёмка: тест задачи — активным пользователям созданы ритуалы дня; при сбое LLM использован fallback
- [ ] 4.6 Реализовать beat-задачу `send_ritual_reminders`: напоминания с учётом тихих часов и timezone пользователя (отложить до конца тихих часов), отправка через push_service. Приёмка: тест — в тихие часы пуш не отправлен, после — отправлен

## 5. Роутеры

- [ ] 5.1 Реализовать роутер `app/api/v1/journal.py`: `POST/GET /journal/entries`, `GET/DELETE /journal/entries/{id}`, `GET /journal/export` (operationId createJournalEntry/listJournalEntries/getJournalEntry/deleteJournalEntry/exportJournal). Приёмка: интеграционные тесты 1:1 specs/wellbeing
- [ ] 5.2 Реализовать роутер `app/api/v1/rituals.py`: `GET /rituals/today`, `POST /rituals/{id}/complete`, `GET /rituals/history` (operationId getTodayRituals/completeRitual/listRitualHistory). Приёмка: интеграционные тесты 1:1 specs/wellbeing
- [ ] 5.3 Реализовать роутер `app/api/v1/checkins.py`: `POST /checkins` (обязательный Idempotency-Key), `GET /checkins/history` (operationId createCheckin/listCheckins). Приёмка: интеграционные тесты 1:1 specs/wellbeing, включая 429 и 422

## 6. Тесты

- [ ] 6.1 Юнит-тесты сервисов (задачи 4.1–4.6) до полного покрытия сценариев specs/wellbeing. Приёмка: каждый сценарий spec имеет зелёный тест
- [ ] 6.2 Интеграционный тест дня пользователя: today → complete утреннего → вечерний чекин who5 → history (streak + who5_trend + clean_time). Приёмка: прогон на тестовой БД/Redis зелёный
- [ ] 6.3 Тесты граничных случаев серий: пропуск 3 дней → resting без обнуления; возврат → продолжение серии. Приёмка: тесты зелёные на фиксированных датах (freezegun)

## 7. Деплой

- [ ] 7.1 Добавить контейнеры celery-worker и celery-beat в манифесты ns `backend` (тот же образ, env из тех же secrets). Приёмка: beat ставит задачи, worker выполняет; логи задач с rqUId
- [ ] 7.2 Smoke в кластере: сид каталога применён миграцией; `GET /api/v1/rituals/today` возвращает ритуалы; complete и чекин проходят; beat-задача отработала по расписанию. Приёмка: метрики задач в Prometheus, ошибок воркера нет
