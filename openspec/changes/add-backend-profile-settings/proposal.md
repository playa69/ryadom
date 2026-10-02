# Proposal: add-backend-profile-settings

## Why

Пользователь должен управлять своими данными и опытом: смотреть и править профиль, настраивать голос/уведомления/приватность, видеть, что о нём хранит память («профиль под капотом» — принцип прозрачности из спеки), и одним действием стереть всё (152-ФЗ, обещание продукта «стереть всё одной кнопкой»). Это третий блок дорожной карты backend после auth-фундамента и сессий.

## What Changes

- **Профиль** по docs/openapi.yaml (тег `users`): `GET /users/me`, `PATCH /users/me` (display_name, age_group — возраст храним группой, не датой рождения: минимизация ПДн).
- **«Стереть всё»**: `DELETE /users/me` со строкой-подтверждением — необратимое каскадное удаление всех данных пользователя (транскрипты, память, профиль, настройки, пуш-токены, журнал, чекины, сессии, токены) асинхронной Celery-задачей; аудит-след в `deletion_requests` без контента; ответ 202 со статусом `scheduled`.
- **Факты памяти (прозрачность)**: `GET /users/me/facts` (cursor, фильтр `category`), `PATCH /users/me/facts/{id}`, `DELETE /users/me/facts/{id}` — просмотр и редактирование фактов L2-профиля (themes, values, triggers, coping, close_people, big5, works_for_user) с confidence и source.
- **Настройки**: `GET /users/me/settings`, `PATCH /users/me/settings` (мерж по полям): голос TTS (2–3 варианта из `available_voices`), тема, уведомления + тихие часы, приватность (`store_transcripts`, `incognito_session`), лимит голосовых минут в день.
- **Пуш-токены**: `PUT /users/me/devices/current/push-token` (provider: apns/fcm/rustore, upsert, идемпотентно).
- **Состояние дня**: `GET /users/me/state` — минуты сегодня, `soft_recommendation` (антизависимый контур: устойчиво > 90 мин/день → мягкая рекомендация живого контакта), последний WHO-5, счётчик чистого времени (recovery), серия ритуалов (active/resting).
- **Модели и миграции**: `user_settings`, `memory_facts`, `push_tokens`, `deletion_requests`.

Согласия (consents) НЕ дублируются — уже в change add-backend-foundation-auth (capability auth). Зависимости: add-backend-foundation-auth (auth, каркас); каскад удаления затрагивает таблицы change'а add-backend-sessions-streaming (расширяется по мере появления таблиц, design.md D2). Вне scope: запись фактов памяти агентом (консолидация L2/L3 — отдельный change), отправка пушей (только регистрация токенов).

## Capabilities

### New Capabilities

- `user-profile`: управление аккаунтом и данными пользователя — профиль, необратимое удаление всего с аудитом, прозрачность и редактирование фактов памяти, настройки (голос, уведомления, приватность, лимиты), пуш-токены, агрегированное состояние дня с антизависимым контуром.

### Modified Capabilities

(пусто — consents остаются в capability auth без изменений)

## Impact

- **Новый код**: `app/services/user_service.py`, `settings_service.py`, `deletion_service.py`, `state_service.py`, `push_service.py` (регистрация токенов), Celery-задача `cascade_delete_user`, роутер `app/api/v1/users.py`.
- **API**: 9 REST-эндпоинтов (тег `users` в docs/openapi.yaml): getMe, updateMe, deleteMe, listMemoryFacts, updateMemoryFact, deleteMemoryFact, getSettings, updateSettings, putPushToken, getMyState.
- **БД**: таблицы `user_settings`, `memory_facts`, `push_tokens`, `deletion_requests`; миграция Alembic.
- **Приватность**: шифрование чувствительных полей настроек не требуется; удаление — полное и необратимое, аудит только факта удаления (без контента).
- **Зависимости**: порог антизависимого контура (90 мин/день) и окно «устойчивости» — в конфиг.
