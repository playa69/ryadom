# API-контракт backend «Слышу Рядом»

Версия документа: 0.1.0 · Статус: черновик v0 (MVP)

Полный контракт backend: REST, WebSocket-протокол стриминга, модели данных,
правила приватности и антиспама. Машиночитаемая заготовка REST — `docs/openapi.yaml`
(эндпоинты совпадают 1:1). Архитектура реализации — `docs/backend-architecture.md`.

## 1. Общие правила

### 1.1. Base URL и версионирование

```
https://xn----htbtgjker8b3a2c.xn--p1ai/api/v1   (слышу-рядом.рф)
```

Версия API — в path (`/api/v1`). Ломающие изменения — только новой версией path.
Поддоменов нет: routing path-based через istio-gateway (см. раздел 10).

### 1.2. Заголовки

Сервис принимает и обрабатывает только заголовки из белого списка
(проектное правило `.agents/skills/api-headers-rules`):

| Заголовок | Назначение | Кто ставит |
|---|---|---|
| `Authorization: Bearer <access_token>` | Аутентификация | клиент |
| `x-trace-id` | Сквозной ID запроса (rqUId), связь логов | клиент (сервер НЕ генерирует сам) |
| `x-request-time` | Время запроса от вызывающей стороны (ISO 8601) | клиент |
| `x-client-id` | Идентификатор клиента: `flutter-ios` / `flutter-android` | клиент |
| `x-session-id` | ID сессии диалога (для запросов в контексте сессии) | клиент |
| `x-user-id` | ID пользователя — проставляется сервером после auth, в исходящих вызовах | сервер |

Дополнительно:

| Заголовок | Назначение |
|---|---|
| `Idempotency-Key: <uuid>` | Идемпотентность POST сообщений/чекинов/SOS (см. 1.5) |
| `Retry-After: <seconds>` | В ответах 429 — через сколько повторять |

В логи попадают только заголовки белого списка; `Authorization` не логируется.

### 1.3. Формат ошибок

Единый формат (паттерн UnionApp `app/schemas/errors.py`, не RFC 7807):

```json
{
  "error": {
    "code": "AUTH_TOKEN_EXPIRED",
    "message": "Сессия истекла. Обновите токен или войдите снова",
    "details": null
  }
}
```

- `code` — машиночитаемый код из каталога (ниже), клиент ветвит логику по нему.
- `message` — человекочитаемое сообщение на русском, можно показывать пользователю.
- `details` — `null`, объект или список полевых ошибок валидации:
  `[{"field": "email", "message": "Некорректный email", "code": "invalid_email"}]`.

Каталог кодов (`ErrorCode`, SCREAMING_SNAKE):

| Код | HTTP | Значение |
|---|---|---|
| `AUTH_TOKEN_EXPIRED` | 401 | access-токен истёк — обновить через `/auth/refresh` |
| `AUTH_TOKEN_INVALID` | 401 | токен отсутствует/битый/не Bearer |
| `AUTH_REFRESH_TOKEN_INVALID` | 401 | refresh-токен недействителен, отозван или replay — повторный вход |
| `AUTH_INVALID_CREDENTIALS` | 401 | неверный email/пароль или device_key |
| `AUTH_RESET_TOKEN_INVALID` | 400 | токен сброса пароля недействителен/истёк/использован |
| `AUTH_CODE_EXPIRED` | 400 | код верификации email истёк или уже использован |
| `AUTH_CODE_INVALID` | 400 | неверный код (в `details.remaining_attempts` — остаток попыток) |
| `AUTH_CODE_TOO_MANY_ATTEMPTS` | 400 | исчерпаны 5 попыток ввода кода — запросить новый |
| `AUTH_EMAIL_ALREADY_LINKED` | 409 | email уже привязан к другому аккаунту |
| `AGE_RESTRICTED` | 403 | сервис 18+, подтверждение возраста не пройдено |
| `CONSENT_REQUIRED` | 403 | требуется принять оферту/дисклеймер (`POST /users/me/consents`) |
| `FORBIDDEN` | 403 | доступ запрещён |
| `VALIDATION_ERROR` | 422 | ошибка валидации тела/параметров (детали в `details`) |
| `NOT_FOUND` | 404 | ресурс не найден |
| `SESSION_NOT_FOUND` | 404 | сессия не найдена |
| `ENTRY_NOT_FOUND` | 404 | запись журнала не найдена |
| `FACT_NOT_FOUND` | 404 | факт памяти не найден |
| `RITUAL_NOT_FOUND` | 404 | ритуал не найден |
| `NEWS_NOT_FOUND` | 404 | новость не найдена |
| `SESSION_TRANSCRIPTS_DISABLED` | 410 | хранение транскриптов выключено — транскрипт недоступен |
| `SESSION_ALREADY_FINISHED` | 409 | сессия уже завершена |
| `CONFLICT` | 409 | конфликт данных (дубль, гонка состояний) |
| `RATE_LIMITED` | 429 | превышен лимит запросов (см. `Retry-After` и раздел 9.3) |
| `SERVICE_UNAVAILABLE` | 503 | зависимость недоступна (auth-критичные лимиты fail-closed, см. 9.4) |
| `INTERNAL_ERROR` | 500 | внутренняя ошибка сервера |

### 1.4. Пагинация

Только cursor-based, никаких offset:

- запрос: `limit` (1–100, дефолт 20) + `cursor` (opaque-строка из предыдущего ответа);
- ответ: `{"items": [...], "next_cursor": "eyJ..." | null}` — `null` = страниц больше нет.

Курсор непрозрачен для клиента, инвалидный курсор → `VALIDATION_ERROR`.

### 1.5. Идемпотентность

Для POST, создающих записи по действию пользователя (`/checkins`, `/sos/events`,
сообщения в сессию), клиент передаёт `Idempotency-Key: <uuid>`. Повтор с тем же
ключом в течение 24 часов возвращает первый ответ без создания дубля.
Ключи хранятся в Redis (TTL 24 ч), привязаны к `user_id` + пути.

## 2. Auth (гибрид: device-based + email)

Механика токенов перенесена из UnionApp (детали реализации — в
`backend-architecture.md`):

- **access** — JWT HS256, TTL 15 минут, claims `sub` (user UUID), `type="access"`,
  `iat`, `exp`. Claim `jti` осознанно отсутствует (короткий TTL компенсирует).
- **refresh** — opaque `token_urlsafe(48)`, TTL 30 дней, в БД хранится только
  SHA-256 хэш + `device_id`.
- **ротация с защитой от replay**: каждый `/auth/refresh` отзывает старый токен
  и выдаёт новый. Повторное использование отозванного токена вне grace-окна
  10 секунд трактуется как компрометация → отзываются ВСЕ refresh-токены
  пользователя (family kill). Внутри grace-окна (гонка клиент/сеть) — выдаётся
  новая пара без отзыва семейства.
- **пароли** — argon2id (`pwdlib[argon2]`, `PasswordHash.recommended()`).

Ответ с парой токенов (одинаков для всех auth-эндпоинтов):

```json
{
  "access_token": "eyJhbGciOi...",
  "token_type": "bearer",
  "expires_in": 900,
  "refresh_token": "8f3a...opaque",
  "refresh_expires_in": 2592000
}
```

### 2.1. `POST /auth/device` — анонимный вход

Auth: не требуется. Антиспам: 20/час по IP (защита от ферм аккаунтов).

Идемпотентен: тот же `device_id` + `device_key` = тот же пользователь.
`device_key` генерируется клиентом при первом запуске (`token_urlsafe(32)`) и
хранится в keychain/keystore устройства.

Запрос:

```json
{
  "device_id": "a3f1c2e8-...-uuid",
  "device_key": "9Qm...client-generated",
  "platform": "ios",
  "app_version": "0.1.0"
}
```

Ответ 200 — пара токенов (см. выше) + профиль-флаги:

```json
{
  "access_token": "eyJhbGciOi...",
  "token_type": "bearer",
  "expires_in": 900,
  "refresh_token": "8f3a...",
  "refresh_expires_in": 2592000,
  "user": {
    "id": "b7c9...-uuid",
    "is_anonymous": true,
    "has_email": false,
    "age_confirmed": false,
    "consents_completed": false
  },
  "is_new_user": true
}
```

Ошибки: `RATE_LIMITED` (429), `AUTH_INVALID_CREDENTIALS` (401 — device_key не
совпал с ранее привязанным к device_id), `VALIDATION_ERROR` (422).

### 2.2. `POST /auth/email/link` — привязка email к анонимному аккаунту

Auth: Bearer. Антиспам: 5 кодов/час на аккаунт И на SHA-256-хэш email.

Отправляет 6-значный код на email (код в Redis, TTL 600 сек, single-use,
сравнение через `compare_digest`, шаблон `cabinet_2fa_service.py`).

Запрос:

```json
{ "email": "user@example.com", "password": "min-8-chars" }
```

Ответ 200:

```json
{
  "pending_token": "c1d2...-uuid",
  "expires_in": 600,
  "email_masked": "u***r@example.com"
}
```

Ошибки: `AUTH_EMAIL_ALREADY_LINKED` (409), `WEAK_PASSWORD` → `VALIDATION_ERROR`
(422, деталь по полю password), `RATE_LIMITED` (429).

### 2.3. `POST /auth/email/link/confirm` — подтверждение привязки

Auth: Bearer. Антиспам: тот же контур, что 2.2; max 5 попыток ввода кода.

Запрос:

```json
{ "pending_token": "c1d2...-uuid", "code": "123456" }
```

Ответ 200 — аккаунт привязан, пароль сохранён (argon2):

```json
{ "user": { "id": "b7c9...-uuid", "is_anonymous": false, "has_email": true } }
```

Ошибки: `AUTH_CODE_INVALID` (400, `details.remaining_attempts`),
`AUTH_CODE_TOO_MANY_ATTEMPTS` (400), `AUTH_CODE_EXPIRED` (400),
`AUTH_EMAIL_ALREADY_LINKED` (409).

### 2.4. `POST /auth/email/login` — вход по email/паролю с нового устройства

Auth: не требуется. Антиспам: 10 попыток/5 мин по IP.

Восстановление истории на новом устройстве: устройство привязывается к аккаунту
через `device_id` выданного refresh-токена.

Запрос:

```json
{
  "email": "user@example.com",
  "password": "...",
  "device_id": "a3f1c2e8-...-uuid",
  "device_key": "9Qm...",
  "platform": "android",
  "app_version": "0.1.0"
}
```

Ответ 200 — пара токенов + `user` (как в 2.1, `is_anonymous: false`).

Ошибки: `AUTH_INVALID_CREDENTIALS` (401, одинаковое сообщение для «нет такого
email» и «неверный пароль» — anti-enumeration), `RATE_LIMITED` (429).

### 2.5. `POST /auth/refresh` — ротация токенов

Auth: не требуется (сам refresh-токен — креденшел).

Запрос: `{ "refresh_token": "8f3a..." }`
Ответ 200 — новая пара токенов (старый refresh отозван).

Ошибки: `AUTH_REFRESH_TOKEN_INVALID` (401). Повторное использование отозванного
токена вне grace-окна → family kill всех refresh пользователя + security-аудит.

### 2.6. `POST /auth/logout` — выход

Auth: Bearer. Отзывает refresh-токен текущего устройства (семейство устройства).

Запрос: `{ "refresh_token": "8f3a..." }`
Ответ 200: `{ "message": "Logged out successfully." }`

Идемпотентен: отзыв уже отозванного/чужого токена — тот же 200.

### 2.7. `POST /auth/password-reset/request` — запрос сброса пароля

Auth: не требуется. Антиспам: 1 запрос/21 час по IP И по SHA-256-хэшу email.

Только для аккаунтов с привязанным email. Токен сброса — opaque
`token_urlsafe(32)`, TTL 30 минут, в БД хэш; при новом запросе предыдущие токены
инвалидируются; письмо отправляется до коммита (rollback при сбое отправки).

**Anti-enumeration:** ответ одинаков для любого email — существующего и нет;
cooldown пишется даже для несуществующего адреса.

Запрос: `{ "email": "user@example.com" }`
Ответ 200 (всегда):

```json
{ "message": "Если аккаунт с таким email существует, мы отправили письмо со ссылкой для сброса пароля." }
```

Ошибки: `RATE_LIMITED` (429 — по cooldown тоже одинаковое сообщение тела,
отличие только статус и `Retry-After`).

### 2.8. `POST /auth/password-reset/confirm` — подтверждение сброса

Auth: не требуется.

Запрос:

```json
{ "token": "reset-opaque-token", "new_password": "min-8-chars" }
```

Ответ 200: `{ "message": "Password has been updated successfully." }`

После сброса отзываются ВСЕ refresh-токены пользователя (переавторизация на всех
устройствах), отправляется письмо-уведомление о смене пароля.

Ошибки: `AUTH_RESET_TOKEN_INVALID` (400), `VALIDATION_ERROR` (422, слабый пароль).

## 3. Пользователь, профиль, настройки

### 3.1. `POST /users/me/consents` — согласия и 18+

Auth: Bearer. Фиксирует подтверждение возраста, дисклеймер «сервис самоподдержки,
не психотерапия», принятие оферты. Без этого шага сессии не создаются
(`CONSENT_REQUIRED`).

Запрос:

```json
{
  "age_confirmed": true,
  "disclaimer_accepted": true,
  "offer_accepted": true,
  "offer_version": "2026-09-01"
}
```

Ответ 200: `{ "consents_completed": true, "accepted_at": "2026-10-02T12:00:00Z" }`

Ошибки: `AGE_RESTRICTED` (403 — `age_confirmed: false`), `VALIDATION_ERROR` (422).

### 3.2. `GET /users/me` — профиль

Auth: Bearer. Ответ 200:

```json
{
  "id": "b7c9...-uuid",
  "display_name": "Алекс",
  "age_group": "25_34",
  "is_anonymous": false,
  "has_email": true,
  "age_confirmed": true,
  "consents_completed": true,
  "created_at": "2026-09-15T08:30:00Z"
}
```

`age_group`: `18_24 | 25_34 | 35_44 | 45_54 | 55_plus` (возраст храним группой,
не датой рождения — минимизация ПДн).

### 3.3. `PATCH /users/me` — обновление профиля

Auth: Bearer. Частичное обновление: `display_name` (обращение, опционально),
`age_group`. Ответ 200 — обновлённый профиль (как 3.2).

### 3.4. `DELETE /users/me` — «стереть всё»

Auth: Bearer. Одно действие + подтверждение, необратимо. Запускает асинхронную
задачу каскадного удаления: транскрипты, память (факты, эмбеддинги), профиль,
пуш-токены, журнал, чекины, сессии; в `deletion_requests` пишется аудит-след
(без контента).

Запрос: `{ "confirmation": "УДАЛИТЬ" }`
Ответ 202:

```json
{
  "status": "scheduled",
  "deletion_request_id": "d4e5...-uuid"
}
```

Ошибки: `VALIDATION_ERROR` (422 — неверное подтверждение).

### 3.5. Факты памяти — прозрачность «профиля под капотом»

По спеке 4.2: пользователь может посмотреть и отредактировать факты, которые о
нём хранятся (прозрачность без ярлыков).

`GET /users/me/facts` — список (cursor-пагинация, фильтр `category`):

```json
{
  "items": [
    {
      "id": "f1a2...-uuid",
      "category": "close_people",
      "text": "Мама, сложные отношения, разговор в прошлую пятницу",
      "confidence": 0.82,
      "source": "session",
      "updated_at": "2026-09-28T21:10:00Z"
    }
  ],
  "next_cursor": null
}
```

`category`: `themes | values | triggers | coping | close_people | big5 | works_for_user`.

`PATCH /users/me/facts/{fact_id}` — правка `text`. Ответ 200 — обновлённый факт.
`DELETE /users/me/facts/{fact_id}` — удаление. Ответ 204.

Ошибки: `FACT_NOT_FOUND` (404).

### 3.6. `GET /users/me/settings`, `PATCH /users/me/settings` — настройки

Auth: Bearer. Ответ 200 / тело PATCH:

```json
{
  "voice_id": "calm_female_1",
  "theme": "dark",
  "notifications": {
    "enabled": true,
    "quiet_hours": { "from": "23:00", "to": "08:00" }
  },
  "privacy": {
    "store_transcripts": true,
    "incognito_session": false
  },
  "limits": {
    "voice_minutes_per_day": 60
  }
}
```

- `voice_id` — 2–3 варианта TTS-голоса (список валидных значений отдаёт сервер
  в `GET /users/me/settings` → `available_voices`).
- `privacy.store_transcripts: false` — новые транскрипты не сохраняются
  (L0-слой памяти пустой; старые — по запросу удаления).
- `privacy.incognito_session: true` — «сессия без истории»: следующая сессия не
  пишется в память и историю.
- PATCH — частичное, мерж по полям. Ответ 200 — полные настройки.

### 3.7. `PUT /users/me/devices/current/push-token` — пуш-токен устройства

Auth: Bearer. `device_id` берётся из refresh-токенной привязки устройства.

Запрос:

```json
{ "provider": "apns", "push_token": "d3v1c3t0k3n..." }
```

`provider`: `apns | fcm | rustore`. Ответ 204. Идемпотентен (upsert).

### 3.8. `GET /users/me/state` — состояние дня (anti-dependency)

Auth: Bearer. Данные для главного экрана и антизависимого контура:

```json
{
  "minutes_today": 35,
  "soft_recommendation": false,
  "who5_last": { "score": 14, "measured_at": "2026-09-30T20:00:00Z" },
  "clean_time_seconds": 1209600,
  "streak": { "count": 5, "status": "active", "resting_days": 0 }
}
```

- `soft_recommendation: true` — при >90 мин/день устойчиво: клиент показывает
  мягкую рекомендацию живого контакта (спека 5, «Анти-зависимый контур»).
- `clean_time_seconds` — счётчик чистого времени (режим recovery), `null` вне режима.
- `streak.status`: `active | resting` — серия ритуалов «отдыхает», не «сгорает».

## 4. Чаты (сессии) и история

Режимы (`mode`, спека 4.1): `vent` (Выговориться), `chat` (Поболтать),
`gestalt_diary` (Гештальт-дневник), `recovery` (Выздоровление), `rituals`
(Аффирмации и ритуалы). `warmth` (Тепло) — зарезервирован под v1, в v0
возвращает `VALIDATION_ERROR`.

### 4.1. `POST /sessions` — создать сессию

Auth: Bearer + consents. Лимит: 1 активная сессия на пользователя (вторая —
`CONFLICT` или автозавершение предыдущей, см. 5.5).

Запрос: `{ "mode": "vent" }`
Ответ 201:

```json
{
  "session_id": "s3ss...-uuid",
  "mode": "vent",
  "ws_url": "wss://xn----htbtgjker8b3a2c.xn--p1ai/api/v1/ws/sessions/s3ss...-uuid",
  "session_token": "st_...short-lived",
  "session_token_expires_in": 300,
  "sse_fallback_url": "/api/v1/sessions/s3ss...-uuid/messages"
}
```

`session_token` — короткоживущий (5 мин) токен для подключения к WS.
Обновление токена для reconnect после его истечения — открытый вопрос v0.1
(TODO, отдельный эндпоинт в v1 контракта не входит); в рамках v0 пересоздавайте
сессию после `finished`/`expired`.

Ошибки: `CONSENT_REQUIRED` (403), `CONFLICT` (409 — есть активная сессия),
`VALIDATION_ERROR` (422 — неизвестный mode).

### 4.2. `GET /sessions` — история сессий

Auth: Bearer. Фильтры: `mode`, `from`, `to` (ISO 8601); cursor-пагинация.
В ленте — саммари, без полного транскрипта:

```json
{
  "items": [
    {
      "id": "s3ss...-uuid",
      "mode": "vent",
      "status": "finished",
      "started_at": "2026-10-01T23:40:00Z",
      "finished_at": "2026-10-01T23:52:00Z",
      "summary": {
        "themes": ["работа", "ссора"],
        "emotions": ["обида", "усталость"],
        "tension_before": 8,
        "tension_after": 4
      },
      "has_transcript": true
    }
  ],
  "next_cursor": "eyJ..."
}
```

### 4.3. `GET /sessions/{session_id}` — детали и транскрипт

Auth: Bearer (только владелец). Ответ 200 — объект сессии + `transcript`:

```json
{
  "id": "s3ss...-uuid",
  "mode": "vent",
  "status": "finished",
  "started_at": "2026-10-01T23:40:00Z",
  "finished_at": "2026-10-01T23:52:00Z",
  "summary": { "themes": ["работа"], "emotions": ["обида"], "tension_before": 8, "tension_after": 4, "takeaway": "Я имею право злиться" },
  "transcript": [
    { "role": "user", "text": "Мне сегодня тяжело...", "ts": "2026-10-01T23:40:12Z", "emo_tags": ["sadness"] },
    { "role": "assistant", "text": "Звучит как обида и усталость одновременно — так?", "ts": "2026-10-01T23:40:20Z", "emo_tags": [] }
  ]
}
```

Если `store_transcripts=false` или транскрипт удалён — **410 Gone**
`SESSION_TRANSCRIPTS_DISABLED` с пояснением в `message`.

Ошибки: `SESSION_NOT_FOUND` (404), `SESSION_TRANSCRIPTS_DISABLED` (410).

### 4.4. `DELETE /sessions/{session_id}` — удалить сессию

Auth: Bearer (владелец). Удаляет сессию, транскрипт, саммари и связанные
эмбеддинги. Ответ 204. Ошибки: `SESSION_NOT_FOUND` (404).

### 4.5. `POST /sessions/{session_id}/finish` — завершение сессии

Auth: Bearer (владелец). Фиксирует самооценку «после» и «что забираешь с собой»;
триггерит фоновую суммаризацию и консолидацию памяти.

Запрос:

```json
{ "tension_after": 4, "takeaway": "Я имею право злиться" }
```

Ответ 200:

```json
{
  "session_id": "s3ss...-uuid",
  "status": "finished",
  "summary_status": "pending"
}
```

`tension_after`: 1–10. `takeaway` — опционально, до 500 символов.
Ошибки: `SESSION_NOT_FOUND` (404), `SESSION_ALREADY_FINISHED` (409),
`VALIDATION_ERROR` (422).

## 5. Стриминг с чат-ботом

### 5.1. Основной канал — WebSocket

```
wss://xn----htbtgjker8b3a2c.xn--p1ai/api/v1/ws/sessions/{session_id}?token=<session_token>
```

Полнодуплексный канал голосовой сессии. Все фреймы — JSON (аудио — base64 внутри
JSON). Каждый серверный фрейм несёт монотонный `event_id` (per-session) — для
reconnect/resume.

#### Сообщения клиент → сервер

| type | Поля | Назначение |
|---|---|---|
| `audio.chunk` | `seq`, `codec` (`opus`/`pcm16`), `data` (base64, ≤ 64 КБ) | Поток микрофона, VAD на устройстве |
| `text.message` | `text` (≤ 4000), `client_msg_id` | Текстовая реплика (идемпотентна по `client_msg_id`) |
| `ping` | `ts` | Heartbeat, клиент шлёт каждые 30 сек |
| `session.pause` | — | Пауза (сворачивание приложения) |
| `session.resume` | — | Возобновление после паузы |

Примеры фреймов:

```json
{ "type": "audio.chunk", "seq": 12, "codec": "opus", "data": "AAEC...==" }
{ "type": "text.message", "text": "Мне тревожно из-за завтрашнего", "client_msg_id": "c9d8...-uuid" }
{ "type": "ping", "ts": "2026-10-01T23:41:00Z" }
```

#### Сообщения сервер → клиент

| type | Поля | Назначение |
|---|---|---|
| `transcript.partial` | `event_id`, `text` | Промежуточный результат SaluteSpeech ASR |
| `transcript.final` | `event_id`, `text`, `emo_tags[]` | Финальный транскрипт реплики |
| `safety.status` | `event_id`, `level` (`green`/`yellow`/`red`) | Вердикт кризис-классификатора по каждой реплике |
| `llm.token` | `event_id`, `token` | Стрим токенов ответа GigaChat |
| `llm.done` | `event_id`, `full_text` | Ответ завершён (для лога/ретрая) |
| `tts.chunk` | `event_id`, `seq`, `codec` (`opus`), `data` (base64) | Поток аудио-ответа SaluteSpeech TTS |
| `session.state` | `event_id`, `state` (`active`/`paused`/`finishing`/`finished`) | Смена состояния сессии |
| `crisis.intervention` | `event_id`, `script_step`, `resources[]` | Кризисный протокол — перекрывает всё (см. 5.3) |
| `error` | `code`, `message` | Ошибка фрейма/лимита (коды из 1.3) |
| `pong` | `ts` | Ответ на `ping` |

Примеры фреймов:

```json
{ "type": "transcript.final", "event_id": "evt_0182", "text": "Мне тревожно из-за завтрашнего", "emo_tags": ["anxiety"] }
{ "type": "safety.status", "event_id": "evt_0183", "level": "green" }
{ "type": "llm.token", "event_id": "evt_0184", "token": "Слышу" }
{ "type": "tts.chunk", "event_id": "evt_0185", "seq": 3, "codec": "opus", "data": "BAUG...==" }
{ "type": "session.state", "event_id": "evt_0186", "state": "paused" }
```

### 5.2. Reconnect / resume

При переподключении клиент добавляет `&last_event_id=evt_0182` — сервер шлёт
пропущенные серверные события (буфер последних 200 событий сессии в Redis).
`audio.chunk` не реплеятся (аудио не хранится). Повторная текстовая реплика —
через тот же `client_msg_id` (дедупликация).

### 5.3. Кризисный протокол (спека 4.3)

Двухступенчатый классификатор на каждом сообщении (правила + лёгкая модель →
LLM-проверка неоднозначных). При `level=red` сервер:

1. мягко останавливает сценарий режима (`session.state: finishing` не шлётся —
   диалог продолжается скриптом деэскалации);
2. шлёт `crisis.intervention` со скриптом, валидированным консультантами:

```json
{
  "type": "crisis.intervention",
  "event_id": "evt_0190",
  "script_step": "deescalation",
  "resources": [
    { "kind": "hotline", "name": "Телефон доверия", "phone": "8-800-2000-122", "hours": "24/7" },
    { "kind": "close_person", "name": "из ваших близких", "contact_ref": "fact:f1a2..." }
  ]
}
```

3. клиент показывает горячие линии в один тап и предложение позвонить.
   Никакого удержания в диалоге. Кризис перекрывает любой режим и метрику.

### 5.4. Fallback — SSE (text-only)

```
POST /api/v1/sessions/{session_id}/messages
Accept: text/event-stream
```

Деградация без голоса (фри-тариф, плохая сеть): клиент шлёт текстовое сообщение
в теле, сервер отвечает `text/event-stream` с теми же типами событий, что в WS
(`transcript.final`, `safety.status`, `llm.token`, `llm.done`,
`crisis.intervention`, `error` — без `audio.chunk`/`tts.chunk`).

Запрос:

```json
{ "text": "Мне тревожно из-за завтрашнего", "client_msg_id": "c9d8...-uuid" }
```

Поток событий:

```
event: safety.status
data: {"level": "green"}

event: llm.token
data: {"token": "Слышу"}

event: llm.done
data: {"full_text": "Слышу тебя. Расскажешь, что именно тревожит?"}
```

Антиспам: 60 сообщений/мин на пользователя (WS и SSE суммарно).

### 5.5. Таймауты и лимиты канала

| Параметр | Значение |
|---|---|
| Активных WS-сессий на пользователя | 1 (новое подключение закрывает старое, код 4003) |
| Heartbeat | клиент `ping` каждые 30 сек; сервер закрывает при 60 сек тишины |
| Idle-таймаут | 10 минут без сообщений → `session.state: finishing` + close 4002 |
| Max длительность сессии | 60 минут → `session.state: finishing` + close 4001 |
| Max размер фрейма | 256 КБ (audio.chunk ≤ 64 КБ) |
| TTL `session_token` | 300 сек |

WS close-коды приложения: 4000 — нормальное завершение; 4001 — max длительность;
4002 — idle; 4003 — вытеснено новым подключением; 4401 — токен недействителен;
4429 — rate limit.

## 6. Журнал, ритуалы, чекины

### 6.1. Журнал (гештальт-письма и записи)

`POST /journal/entries` — создать запись. Auth: Bearer. Запрос:

```json
{ "kind": "gestalt_letter", "title": "Незавершённый разговор", "text": "..." }
```

`kind`: `gestalt_letter | note`. Ответ 201 — созданная запись:

```json
{
  "id": "j1e2...-uuid",
  "kind": "gestalt_letter",
  "title": "Незавершённый разговор",
  "text": "...",
  "created_at": "2026-10-02T09:00:00Z",
  "updated_at": "2026-10-02T09:00:00Z"
}
```

`GET /journal/entries` — лента (cursor, фильтры `kind`, `from`/`to`, `q` —
поиск подстрокой). Ответ 200: `{"items": [...], "next_cursor": ...}`.

`GET /journal/entries/{entry_id}` — одна запись. Ошибки: `ENTRY_NOT_FOUND` (404).

`DELETE /journal/entries/{entry_id}` — удалить. Ответ 204.

`GET /journal/export` — экспорт всех записей одним Markdown-документом
(клиент передаёт в системный share sheet; полноценного API системных заметок
нет — спека 4.6). Ответ 200:

```json
{
  "format": "markdown",
  "filename": "journal-2026-10-02.md",
  "content": "# Журнал\n\n## Незавершённый разговор\n..."
}
```

### 6.2. Ритуалы (утро/вечер, спека 4.5)

`GET /rituals/today` — ритуалы на сегодня (адаптированы под пользователя из памяти):

```json
{
  "items": [
    {
      "id": "r1t2...-uuid",
      "kind": "morning",
      "title": "Утренний настрой",
      "duration_seconds": 180,
      "completed": false,
      "streak": { "count": 5, "status": "active", "resting_days": 0 }
    },
    {
      "id": "r3t4...-uuid",
      "kind": "evening",
      "title": "Вечерняя рефлексия",
      "duration_seconds": 240,
      "completed": false,
      "streak": { "count": 4, "status": "resting", "resting_days": 3 }
    }
  ]
}
```

`POST /rituals/{ritual_id}/complete` — отметить выполнение. Запрос:
`{ "mood_note": "стало спокойнее" }` (опционально). Ответ 200 — ритуал с
обновлённой серией. Идемпотентен в пределах дня (повтор — 200 с тем же состоянием).
Ошибки: `RITUAL_NOT_FOUND` (404).

`GET /rituals/history` — история выполнений (cursor, фильтр `kind`). Серия
«отдыхает»: `status: resting` + `resting_days`, без обнуления и «сгорания».

### 6.3. Чекины

`POST /checkins` — фиксация состояния. Auth: Bearer. `Idempotency-Key`
обязателен. Запрос:

```json
{
  "type": "halt",
  "payload": { "hungry": false, "angry": true, "lonely": true, "tired": false, "tension": 7 }
}
```

`type`: `halt | who5 | tension`.

- `halt` — HALT-инвентаризация режима recovery (hungry/angry/lonely/tired +
  напряжение 1–10).
- `who5` — индекс благополучия WHO-5: `payload: { "answers": [2,3,1,4,2] }`
  (5 ответов 0–5, score = сумма × 4).
- `tension` — точечная самооценка напряжения: `payload: { "value": 6 }`.

Ответ 201:

```json
{
  "id": "c5h6...-uuid",
  "type": "halt",
  "payload": { "hungry": false, "angry": true, "lonely": true, "tired": false, "tension": 7 },
  "created_at": "2026-10-02T21:00:00Z",
  "clean_time_seconds": 1209600
}
```

`GET /checkins/history` — динамика (cursor, фильтры `type`, `from`/`to`):

```json
{
  "items": [ { "id": "c5h6...-uuid", "type": "who5", "payload": { "answers": [2,3,1,4,2], "score": 48 }, "created_at": "..." } ],
  "aggregates": {
    "who5_trend": [ { "week": "2026-W39", "avg_score": 44 }, { "week": "2026-W40", "avg_score": 48 } ],
    "clean_time_seconds": 1209600
  },
  "next_cursor": "eyJ..."
}
```

## 7. Новости, «Люди рядом», SOS

### 7.1. Новости

Простой контентный раздел (паттерн UnionApp: публичная лента). Админ-CRUD —
отдельным контуром позже, в v1 контракта не входит (TODO).

`GET /news` — лента (cursor, опциональный фильтр `tag`):

```json
{
  "items": [
    {
      "id": "n7w8...-uuid",
      "title": "Запустили режим «Выздоровление»",
      "teaser": "Чекины HALT, счётчик чистого времени и кнопка «хочу сорваться»",
      "tags": ["релиз", "recovery"],
      "published_at": "2026-10-01T10:00:00Z"
    }
  ],
  "next_cursor": null
}
```

`GET /news/{news_id}` — полная новость:

```json
{
  "id": "n7w8...-uuid",
  "title": "Запустили режим «Выздоровление»",
  "teaser": "...",
  "body_markdown": "## Что нового\n...",
  "tags": ["релиз", "recovery"],
  "published_at": "2026-10-01T10:00:00Z"
}
```

Ошибки: `NEWS_NOT_FOUND` (404).

### 7.2. «Люди рядом» — справочник поддержки (спека 4.4)

Статичный справочник, кэшируемый (ETag; клиент шлёт `If-None-Match`,
сервер отвечает 304 при неизменности). Публичные GET (auth опционален —
справочник доступен и до входа, SOS-контур не должен упираться в auth).

`GET /support/hotlines` — горячие линии, **всегда первым блоком**:

```json
{
  "items": [
    {
      "id": "h1",
      "name": "Телефон доверия экстренной психологической помощи",
      "phone": "8-800-2000-122",
      "hours": "24/7",
      "description": "Бесплатно, анонимно, по всей России"
    }
  ]
}
```

`GET /support/groups?topic=` — группы поддержки и сообщества по типу запроса
(`topic`: `addiction | grief | burnout | anxiety | other`). Контакты и
расписания, без аффилиации с брендами сообществ (спека 5, уважение к принципам
анонимных сообществ):

```json
{
  "items": [
    {
      "id": "g1",
      "topic": "addiction",
      "name": "Группа взаимопомощи",
      "city": "Москва",
      "schedule": "вт/чт 19:00",
      "contact": "https://t.me/...",
      "notes": "Открытая группа, анонимно"
    }
  ]
}
```

`GET /support/specialists?topic=` — каталог проверенных специалистов
(старт — партнёрская программа с практикующими гештальт-терапевтами):

```json
{
  "items": [
    {
      "id": "s1",
      "name": "Иванова Мария",
      "specialization": "гештальт-терапия",
      "topics": ["anxiety", "burnout"],
      "format": "online",
      "price_from_rub": 3500,
      "booking_url": "https://..."
    }
  ]
}
```

### 7.3. `POST /sos/events` — фиксация SOS

Auth: опционален (SOS доступен всегда, без auth-блокировки — спека 4.3).
`Idempotency-Key` обязателен. Фиксирует нажатие SOS/срабатывание кризиса для
метрик безопасности (спека 7.3); ответ — ресурсы помощи.

Запрос:

```json
{ "trigger": "sos_button", "session_id": "s3ss...-uuid" }
```

`trigger`: `sos_button | crisis_classifier`. Ответ 201:

```json
{
  "event_id": "s0s1...-uuid",
  "resources": {
    "hotlines": [ { "id": "h1", "name": "Телефон доверия", "phone": "8-800-2000-122", "hours": "24/7" } ]
  }
}
```

## 8. Модель данных (эскиз)

БД `backend` (PostgreSQL + pgvector). Таблицы:

| Таблица | Ключевые поля | Назначение |
|---|---|---|
| `users` | id, display_name, age_group, is_active, created_at | Аккаунт (анонимный или с email) |
| `auth_identities` | id, user_id, kind (`device`/`email`), identifier (device_id / email), secret_hash (device_key / argon2 пароль) | Способы входа |
| `devices` | id, user_id, device_id, platform, app_version, last_seen_at | Устройства пользователя |
| `consents` | id, user_id, kind, version, accepted_at | Согласия (18+, дисклеймер, оферта) |
| `user_settings` | user_id, voice_id, theme, notifications(jsonb), privacy(jsonb), limits(jsonb) | Настройки |
| `refresh_tokens` | id, user_id, token_hash (SHA-256, unique), device_id, expires_at, revoked_at, created_at | Refresh-токены (как в UnionApp) |
| `password_reset_tokens` | id, user_id, token_hash, expires_at, used_at, created_at | Токены сброса (TTL 30 мин) |
| `audit_log` | id, actor_user_id, action, entity_type, entity_id, ip, user_agent, payload(jsonb), created_at | Security-события (контакты — masked) |
| `sessions` | id, user_id, mode, status, incognito, started_at, finished_at | Сессии диалога |
| `messages` | id, session_id, role, text_enc, emo_tags[], embedding (vector), created_at | L0 — транскрипт (шифрование) |
| `session_summaries` | id, session_id, user_id, themes[], emotions, tension_before, tension_after, key_facts[], takeaway | L1 — саммари сессий |
| `memory_facts` | id, user_id, category, text, confidence, source, valid_from, updated_at | L2 — профиль (big5, values, triggers, coping, close_people) |
| `journal_entries` | id, user_id, kind, title, text_enc, created_at, updated_at | Журнал |
| `rituals` | id, kind, title, duration_seconds, content(jsonb) | Каталог ритуалов |
| `ritual_completions` | id, ritual_id, user_id, completed_at, mood_note | Выполнения (серия считается отсюда) |
| `checkins` | id, user_id, type, payload(jsonb), created_at | HALT/WHO-5/tension |
| `news` | id, title, teaser, body_markdown, tags[], published_at | Новости |
| `support_resources` | id, kind (`hotline`/`group`/`specialist`), topic, payload(jsonb) | «Люди рядом» |
| `sos_events` | id, user_id (nullable), session_id, trigger, created_at | SOS-события (метрики 7.3) |
| `push_tokens` | id, user_id, device_id, provider, push_token, updated_at | APNs/FCM/RuStore |
| `deletion_requests` | id, user_id, requested_at, completed_at, status | Аудит «стереть всё» |
| `email_verification_codes` | — | **НЕ таблица** — коды в Redis (TTL 600 сек) |
| `component_calls` | — | **НЕ таблица PG** — лог вызовов компонентов (ASR/safety/LLM/TTS) в ClickHouse, с тегом окружения (антифрод-прозрачность, метрика конкурса) |

Память (спека 4.2): L0 = `messages` (шифрование, настраиваемое хранение), L1 =
`session_summaries`, L2 = `memory_facts`, L3 («что помогает именно ему») — фоновая
консолидация, результат кладётся в `memory_facts` категории `works_for_user`.
Retrieval — гибридный (pgvector + вес давности). Каждый элемент памяти имеет
временную метку; агенту в контекст всегда передаётся «время с последней сессии».

## 9. Приватность, безопасность, антиспам

### 9.1. Приватность (152-ФЗ, спека 5)

- Данные — только в контуре РФ: кластер Timeweb (Москва) + S3 Yandex Cloud.
- Анонимный вход по умолчанию; телефон не используется; email — опционально.
- Аудио не хранится после транскрибации (по умолчанию; кэш TTS — без пользовательского контента).
- PII-фильтрация (NER) перед внешними вызовами моделей (GigaChat/SaluteSpeech).
- Транскрипты — с шифрованием при хранении (`text_enc`), настраиваемое хранение
  (`store_transcripts`), «сессия без истории» (`incognito_session`).
- «Стереть всё» — одно действие, необратимо, с аудит-следом (без контента).
- Без рекламы, без продажи данных, без обучения общих моделей на личных диалогах.
- 18+, дисклеймер «не медицинская услуга и не психотерапия» в онбординге и оферте.

### 9.2. Определение реального IP

Доверие `X-Forwarded-For` — только от trusted proxy (istio-gateway, CIDR подсети
кластера в `TRUSTED_PROXY_IPS`). При доверенном прокси берётся **последний**
адрес цепочки XFF (его дописывает edge-proxy от реального TCP-пира; ранние
записи могут быть подделаны клиентом). Паттерн `get_request_security_context`
(UnionApp `app/api/deps.py:150-197`). IP используется для rate-limit и аудита.

### 9.3. Антиспам (лимиты)

Реализация — сервисный слой на Redis: sliding window на ZSET + cooldown через
`SET NX EX` (паттерны UnionApp `rate_limit_service.py` / `anti_spam_service.py`).
Лимиты по IP + cooldown по SHA-256-хэшу контакта (email). Ответ при срабатывании —
`429 RATE_LIMITED` + заголовок `Retry-After`.

| Эндпоинт / действие | Лимит | Ключ |
|---|---|---|
| `POST /auth/device` | 20/час | IP |
| `POST /auth/email/login` | 10/5 мин | IP |
| `POST /auth/email/link`, `/link/confirm` | 5 кодов/час | аккаунт + хэш email |
| `POST /auth/password-reset/request` | 1/21 час | IP И хэш email |
| `POST /auth/password-reset/confirm` | 10/5 мин | IP |
| Сообщения в сессию (WS+SSE) | 60/мин | user |
| Стриминг | 1 активная WS-сессия | user |
| `POST /checkins` | 30/час | user |
| `POST /sos/events` | 10/час | IP (без user — анонимный контур) |

**Anti-enumeration:** `/auth/email/login` и `/auth/password-reset/request` не
различают в ответах «нет такого email» и «неверный пароль»; cooldown пишется
даже для несуществующего email.

### 9.4. Fail-open / fail-closed при недоступном Redis

- **fail-closed (503 `SERVICE_UNAVAILABLE`)** — auth-критичные контуры:
  `/auth/device`, `/auth/email/login`, `/auth/email/link*`,
  `/auth/password-reset/*`, верификация email-кодов. Лучше отказать, чем пустить
  перебор без лимитов (как `get_cabinet_2fa_service` в UnionApp — без Redis 503).
- **fail-open** — прочие лимиты (сообщения в сессию, чекины): запрос проходит,
  в лог пишется warning, в метрики — счётчик деградации.

### 9.5. Security-аудит и метрики

События в `audit_log` (IP, UA, masked-контакты, без секретов): login (device/email),
link email, reset-password request/confirm, refresh family-revoke (replay),
logout, срабатывания антиспама, «стереть всё». Плюс Prometheus-метрики по тем же
событиям (счётчики без PII).

### 9.6. Антизависимый контур и «мост к людям»

- Метрика успеха продукта — снижение напряжения и живые контакты, не минуты
  в приложении. При устойчивом >90 мин/день — `soft_recommendation: true` в
  `GET /users/me/state` (мягкая рекомендация, без жёстких запретов).
- Агент проактивно (ненавязчиво) предлагает живой контакт при паттернах: рост
  времени в приложении, повтор темы без прогресса, тяжесть запроса.
- Режим `warmth` (v1): потолки в системном промпте + safety-слой, регулярное
  ревью обезличенных диалогов консультантами.

## 10. Где это живёт

Маппинг на готовую инфраструктуру (см. `k8s/CLOUD-RESOURCES.md`):

| Компонент | Размещение |
|---|---|
| Приложение | ns `backend` кластера twc-sber500 (Timeweb Cloud, k0s) |
| PostgreSQL + pgvector | CNPG-кластер (ns `ryadom-db`), БД `backend`, PG-юзер `developer` |
| Redis + Sentinel | ns `infra` — сессии, очереди фоновых задач, rate-limit, коды верификации |
| ClickHouse | события и лог вызовов компонентов (`component_calls`) — задеплоить с приложением или позже |
| Langfuse | ns `langfuse` — трейсинг LLM-вызовов |
| Ingress | HTTPRoute на корневом домене, path `/api` — шаблон `k8s/istio/manifests/00-example-gateway.yaml`; TLS — единый listener Gateway `ryadom-gateway` |
| Образы | `cr.yandex/crpsqeamqpuvrkm5tpr9/backend/<service>:<tag>` |
| Служебные пути | `/metrics`, `/health`, `/docs`, `/openapi.json` снаружи не отдаются (фильтрация в HTTPRoute) |
