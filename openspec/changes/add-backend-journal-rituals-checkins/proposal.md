# Proposal: add-backend-journal-rituals-checkins

## Why

Четвёртый блок дорожной карты backend: инструменты регулярной самоподдержки из продуктовой спеки — журнал (гештальт-письма и записи), ежедневные ритуалы утро/вечер с сериями, которые «отдыхают, а не сгорают», и чекины состояния (HALT для режима recovery, WHO-5, tension) с динамикой благополучия. Эти данные — основа персонализации агента и продуктовых метрик (завершаемость ритуалов ≥ 50%, динамика WHO-5).

## What Changes

- **Журнал** по docs/openapi.yaml (тег `journal`): `POST /journal/entries` (kind: `gestalt_letter`/`note`), `GET /journal/entries` (cursor, фильтры kind/from/to, поиск `q`), `GET /journal/entries/{id}`, `DELETE /journal/entries/{id}`, `GET /journal/export` (все записи одним Markdown-документом для системного share sheet — полноценного API системных заметок нет).
- **Ритуалы**: `GET /rituals/today` (утро/вечер, адаптация под пользователя из памяти, статус выполнения и серия), `POST /rituals/{id}/complete` (идемпотентно в пределах дня, опциональный mood_note), `GET /rituals/history` (cursor, фильтр kind). Серия MUST «отдыхать», а не «сгорать»: `status: resting` + `resting_days` вместо обнуления.
- **Чекины**: `POST /checkins` (type: `halt`/`who5`/`tension` со своими payload-схемами; обязательный `Idempotency-Key`; лимит 30/час на пользователя), `GET /checkins/history` (cursor, фильтры type/from/to + агрегаты: динамика WHO-5 по неделям, счётчик чистого времени recovery).
- **Фон по расписанию (Celery + beat)**: ежедневная генерация персональных ритуалов из памяти пользователя, напоминания о ритуалах/чекинах с учётом тихих часов. Именно Celery + beat (стек config.yaml), НЕ Arq.
- **Модели и миграции**: `journal_entries` (text_enc), `rituals`, `ritual_completions`, `checkins`.

Зависимости: add-backend-foundation-auth (auth, каркас, rate-limit, идемпотентность); тихие часы и настройки уведомлений — из change add-backend-profile-settings (потребление user_settings); отправка пушей — через зарегистрированные пуш-токены (push_service). Вне scope: календарные интеграции (EventKit — клиентская сторона), консолидация памяти L3.

## Capabilities

### New Capabilities

- `wellbeing`: инструменты самоподдержки — журнал с экспортом, ежедневные ритуалы с бережными сериями, чекины состояния (HALT/WHO-5/tension) с динамикой благополучия и счётчиком чистого времени, фоновая генерация ритуалов и напоминаний по расписанию.

### Modified Capabilities

(пусто — существующие specs не меняются)

## Impact

- **Новый код**: `app/services/journal_service.py`, `ritual_service.py`, `checkin_service.py`, Celery-задачи (генерация ритуалов, напоминания) + beat-расписание, роутеры `app/api/v1/journal.py`, `rituals.py`, `checkins.py`.
- **API**: 10 REST-эндпоинтов (теги `journal`, `rituals`, `checkins` в docs/openapi.yaml).
- **БД**: таблицы `journal_entries` (text_enc — шифрование), `rituals`, `ritual_completions`, `checkins`; миграция Alembic.
- **Фон**: Celery worker + beat (контейнеры того же образа в ns `backend`).
- **Метрики**: завершаемость ритуалов, динамика WHO-5 за 4 недели, счётчики чекинов.
