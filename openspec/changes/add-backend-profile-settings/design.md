# Design: add-backend-profile-settings

## Context

Строится поверх add-backend-foundation-auth (каркас, auth, get_current_user). Контракт — specs/user-profile/spec.md этого change'а + docs/openapi.yaml (тег `users`: getMe, updateMe, deleteMe, listMemoryFacts, updateMemoryFact, deleteMemoryFact, getSettings, updateSettings, putPushToken, getMyState). Каскадное удаление затрагивает таблицы add-backend-sessions-streaming (sessions, messages, session_summaries). Мотивация — см. proposal.md (Why).

## Goals / Non-Goals

**Goals:**

- «Стереть всё» — структурно полное удаление: один реестр таблиц пользовательских данных, по которому проходит каскад.
- Удаление — асинхронное, с аудитом факта (без контента), не блокирует API.
- Настройки — единая строка `user_settings` с jsonb-секциями (мерж по полям без головной боли миграций).

**Non-Goals:**

- Запись фактов памяти агентом (консолидация L2/L3) — здесь только чтение/правка/удаление фактов пользователем.
- Отправка пушей — только регистрация токенов; отправка — с change'ом wellbeing (ритуалы/напоминания).
- Экспорт данных пользователя (выгрузка по 152-ФЗ) — отдельная задача после MVP.

## Decisions

### D1. Каскадное удаление — Celery-задача с реестром таблиц

`cascade_delete_user` (Celery): обходит реестр таблиц с `user_id` (users, auth_identities, devices, consents, user_settings, refresh_tokens, password_reset_tokens, memory_facts, push_tokens, sessions, messages, session_summaries, journal_entries, checkins, ritual_completions, sos_events по мере появления change'ов) и удаляет строки в порядке зависимостей; перед запуском отзываются все refresh-токены. Реестр — явный список в коде с тестом полноты (новая таблица с user_id без записи в реестре роняет тест).

**Почему:** ON DELETE CASCADE от users закрывает только PG-таблицы с FK, но не Redis-ключи (push-очереди, буферы) и не даёт пошагового аудита/ретрая; явный реестр с тестом полноты защищает от «забыли таблицу» при росте схемы.

**Альтернативы:** только FK CASCADE — отвергнуто (Redis, тонкие места аудита); soft-delete — отвергнуто (противоречит обещанию «стереть всё»).

### D2. Порядок между change'ами

Этот change может быть реализован до или после sessions-streaming: реестр каскада покрывает только существующие на момент реализации таблицы, тест полноты (D1) заставит расширить реестр при появлении новых таблиц с user_id. Жёсткой блокирующей зависимости нет.

### D3. Настройки — одна таблица, jsonb-секции

`user_settings` (user_id PK/FK, voice_id, theme, notifications jsonb, privacy jsonb, limits jsonb). PATCH — глубокий мерж секций на сервисном уровне, ответ — полный документ. `available_voices` — конфиг, не БД.

**Почему:** настройки расширяются каждый change (ритуалы, пуши); jsonb-секции не требуют миграции на каждое новое поле, а Pydantic-схема ответа (по docs/openapi.yaml) держит контракт.

### D4. Шифрование чувствительного контента — полевое (Fernet/AES-GCM)

Ключ из k8s-secret (`ENCRYPTION_KEY`, SecretStr в конфиге). Применяется к текстовому контенту пользователя (транскрипты — в sessions-streaming; здесь — к `text` фактов памяти при необходимости хранения чувствительных деталей). В логах — только маскированное.

### D5. Состояние дня — агрегация на чтении

`GET /users/me/state` собирается на лету: minutes_today из сессий дня, soft_recommendation по скользящему окну (порог 90 мин/день и окно «устойчивости» — конфиг), who5_last и clean_time из чекинов, streak из ritual_completions. Без денормализованной таблицы на MVP; при росте — материализация.

### D6. Идемпотентность пуш-токенов — upsert по (user_id, device_id)

device_id — из привязки refresh-токена текущей сессии; смена provider/токена перезаписывает строку; повтор — no-op.

## Risks / Trade-offs

- [Каскад пропустит новую таблицу при росте схемы] → тест полноты реестра (D1) падает при добавлении таблицы с user_id вне реестра.
- [Долгий каскад у пользователя с большой историей] → асинхронная задача с ретраями; API возвращает 202 сразу; статус в deletion_requests.
- [Удаление во время активной WS-сессии] → отзыв токенов на старте каскада закрывает соединение (4401); задача устойчива к частичному удалению (идемпотентна).
- [jsonb-настройки дрейфуют от схемы] → Pydantic-валидация документа на чтении/записи; неизвестные ключи отбрасываются.
- [soft_recommendation по скользящему окну — стоимость агрегации] → окно маленькое (дни), индексы по (user_id, started_at); при росте — материализация (D5).

## Migration Plan

1. Миграция Alembic `0003_user_profile` (user_settings, memory_facts, push_tokens, deletion_requests) — новые таблицы.
2. Rollout; проверка: PATCH settings → GET state → DELETE users/me → каскад завершён, deletion_requests заполнен.
3. Откат: откат Deployment, downgrade (таблицы новые).

## Open Questions

- Окно «устойчивости» антизависимого контура (сколько дней подряд >90 мин) — калибруется по данным, порог и окно в конфиге; дефолт — 3 дня.
- Состав `available_voices` (2–3 голоса SaluteSpeech) — выбирается с консультантами при интеграции TTS, список в конфиге.
