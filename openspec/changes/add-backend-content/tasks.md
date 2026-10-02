# Tasks: add-backend-content

Контракт: specs/content/spec.md этого change'а + docs/openapi.yaml (теги `news`, `support`, `sos`). Решения — design.md (D1–D4). Зависит от add-backend-foundation-auth (каркас, идемпотентность, rate-limit по IP). Open Questions на состав задач не влияют (тексты справочника — сид-данные).

## 1. Модели и миграции

- [ ] 1.1 Реализовать ORM-модели `news` (title, teaser, body_markdown, tags[], published_at), `support_resources` (kind hotline/group/specialist, topic, payload jsonb, updated_at), `sos_events` (user_id nullable, session_id nullable, trigger, created_at). Приёмка: поля соответствуют схемам docs/openapi.yaml (NewsItem, SupportHotline/SupportGroup/Specialist, SosEventRequest/Response)
- [ ] 1.2 Создать миграцию Alembic `0005_content` (3 таблицы). Приёмка: `alembic upgrade head` + `downgrade` на чистой dev-БД без ошибок
- [ ] 1.3 Создать data-миграцию сидирования (design.md D1): горячие линии РФ, стартовые группы/специалисты по темам, 1–2 новости — плейсхолдеры контента пометить TODO для консультантов. Приёмка: после upgrade справочник и лента непустые

## 2. Репозитории

- [ ] 2.1 Реализовать `NewsRepository` (list с фильтром tag + cursor от новых к старым, get_by_id). Приёмка: юнит-тесты — сортировка, cursor-пагинация, фильтр тега
- [ ] 2.2 Реализовать `SupportResourceRepository` (list по kind с фильтром topic, версия выборки для ETag — design.md D2). Приёмка: тест — ETag меняется после изменения данных
- [ ] 2.3 Реализовать `SosEventRepository` (create с nullable user_id/session_id). Приёмка: тест — запись анонимного и привязанного события

## 3. Сервисы

- [ ] 3.1 Реализовать `news_service.py`: лента + детали, 404 `NEWS_NOT_FOUND`. Приёмка: сценарии specs/content «Новостная лента» покрыты тестами
- [ ] 3.2 Реализовать `support_service.py`: hotlines/groups/specialists с ETag/304 (design.md D2), Pydantic-валидация payload по kind (design.md D4). Приёмка: сценарии specs/content «Справочник поддержки» покрыты тестами, включая 304
- [ ] 3.3 Реализовать `sos_service.py` (design.md D3): фиксация события с опциональной привязкой user/session, идемпотентность по Idempotency-Key, ответ с ресурсами из support_resources (single source), лимит 10/час по IP (action `sos_event`). Приёмка: сценарии specs/content «Фиксация SOS-событий» покрыты тестами

## 4. Роутеры

- [ ] 4.1 Реализовать роутер `app/api/v1/news.py`: `GET /news`, `GET /news/{id}` (operationId listNews/getNewsItem), публичный доступ (design.md D4). Приёмка: интеграционные тесты 1:1 specs/content
- [ ] 4.2 Реализовать роутер `app/api/v1/support.py`: `GET /support/hotlines`, `GET /support/groups`, `GET /support/specialists` (operationId listHotlines/listSupportGroups/listSpecialists) с ETag и публичным доступом. Приёмка: интеграционные тесты — 200, 304, фильтры topic
- [ ] 4.3 Реализовать роутер `app/api/v1/sos.py`: `POST /sos/events` (operationId createSosEvent) с обязательным Idempotency-Key и опциональной auth. Приёмка: интеграционные тесты — 201 с auth и без, идемпотентность, 429

## 5. Тесты

- [ ] 5.1 Юнит-тесты сервисов (задачи 3.1–3.3) до полного покрытия сценариев specs/content. Приёмка: каждый сценарий spec имеет зелёный тест
- [ ] 5.2 Интеграционный тест публичного контура: все 6 эндпоинтов без auth → 200/201; с валидным auth — тот же результат с привязкой user в sos_events. Приёмка: прогон на тестовой БД/Redis зелёный

## 6. Деплой

- [ ] 6.1 Smoke в кластере: миграция и сид применены; `GET /api/v1/support/hotlines` без auth через корневой домен → 200; повтор с If-None-Match → 304; `POST /api/v1/sos/events` → 201 с ресурсами. Приёмка: метрики SOS в Prometheus, событие в БД
