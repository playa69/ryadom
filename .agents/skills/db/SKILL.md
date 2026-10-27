---
name: db
description: Выполнить запрос к базе прода «Рядом» — PostgreSQL кластера CNPG ryadom-db (базы app, agent, backend, cognee_db) через psql в первичном поде, только чтение по умолчанию. Использовать при вопросах «посмотри в базе», «сколько пользователей», «что за аккаунт», «сколько диалогов за день», «найди диалог по id», при сверке аналитики с базой и при правке данных на проде по прямой просьбе человека.
---

# База прода

Один кластер PostgreSQL 16 под оператором CloudNativePG: `ryadom-db` в ns `ryadom-db`, два инстанса, первичный
находится по метке. Окружение одно — prod; для локальной базы — скилл `local-dev`.

| База | Владелец | Что внутри | Схема |
|---|---|---|---|
| `app` | роль `app` | аккаунты приложения: `users`, `user_credentials`, `user_devices`, `user_consents`, `refresh_tokens`, `email_codes`, `audit_log`, `memory_consent_events` | `app/packages/db/src/schema/`, миграции drizzle |
| `agent` | роль `agent` (с 0.8.0) | диалоги агента: `dialogs`, `messages`, `model_usage`, `voice_prefs`, `client_ids` | `agent/app/services/dialog_db.py` (агент создаёт сам) |
| `backend` | роль `developer` | Python backend (приложением не вызывается) | `backend/alembic/` |
| `cognee_db` и базы вида `"<uuid>"` | роль `cognee` | память агента, по базе на тенанта | ведёт Cognee, руками не трогать |
| `langfuse` | — | Langfuse | не трогать |

## Разрешение

Это данные живых людей, в том числе тексты их разговоров. **Читать прод — только по явной просьбе человека** в этой
задаче или чате; писать — только по отдельной просьбе, по протоколу ниже. `exec` в `ryadom-db` есть только у admin,
так что каждое обращение — это admin: назови, какой запрос выполнишь, и дождись «да».

## Запрос

```bash
.claude/skills/db/scripts/query.py app "SELECT count(*) FROM users WHERE NOT is_deleted"
.claude/skills/db/scripts/query.py agent -f /tmp/dialogs-by-day.sql --csv
```

Скрипт находит первичный под, запускает в нём `psql -U postgres` через локальный сокет (пароль не нужен и не
печатается) и открывает сессию с `default_transaction_read_only`: любая запись упадёт. `--write` снимает защиту — не
добавляй его без прямой просьбы. `--csv` — вывод для дальнейшей обработки. Команду kubectl скрипт берёт из
`RYADOM_KUBECTL_ADMIN` (по умолчанию `kubectl`).

Без скрипта то же самое:

```bash
POD=$(kubectl -n ryadom-db get pod -l cnpg.io/cluster=ryadom-db,cnpg.io/instanceRole=primary -o name)
kubectl -n ryadom-db exec -i "$POD" -c postgres -- psql -U postgres -d app -X -v ON_ERROR_STOP=1 < query.sql
```

Порт-форвард `svc/ryadom-db-rw` с ролью `developer` (developer-kubeconfig) открывает только базу `backend`: к `app` и
`agent` у этой роли прав нет.

## Шпаргалка

```sql
-- Аккаунты по дням (Москва), без тестовых и командных
SELECT (created_at AT TIME ZONE 'Europe/Moscow')::date AS day, count(*)
FROM users WHERE coalesce(properties->>'traffic_type', 'real') NOT IN ('test', 'internal')
GROUP BY 1 ORDER BY 1;

-- Диалоги и реплики по дням (база agent; время там — текст ISO в UTC)
SELECT (started_at::timestamptz AT TIME ZONE 'Europe/Moscow')::date AS day, count(*) AS dialogs,
       count(DISTINCT user_id) AS people
FROM dialogs GROUP BY 1 ORDER BY 1;

-- Размер разговора без текстов
SELECT d.id, d.user_id, d.started_at, count(m.*) FILTER (WHERE m.role = 'user') AS user_messages
FROM dialogs d LEFT JOIN messages m ON m.dialog_id = d.id
WHERE d.started_at > (now() - interval '1 day')::text GROUP BY d.id ORDER BY d.started_at DESC LIMIT 20;

-- Расход моделей за сутки
SELECT model, task, direction, unit, sum(amount) FROM model_usage
WHERE created_at > (now() - interval '1 day')::text GROUP BY 1, 2, 3, 4;
```

Колонки проверяй по схеме или запросом к `information_schema.columns`: таблицы агента меняются вместе с его версией.
Готовые запросы сверки с аналитикой — `docs/analytics-proof/` (написаны для прежней SQLite-базы агента; для PostgreSQL
поправь функции дат).

## Правка данных

Только по прямой просьбе человека.

1. Разведка чтением: какие строки и сколько затронет правка.
2. Тот же `WHERE` в `SELECT count(*)`, число — человеку.
3. Точка отката: старые значения в файл вне репозитория; массовая правка или схема — свежий бэкап (скилл `backup`).
4. Одна транзакция `--write`, внутри проверка ровно ожидаемого числа строк, иначе `ROLLBACK`.
5. Проверка результата чтением.

Удалить аккаунт — не SQL, а API (`DELETE /api/auth/me` от имени аккаунта) или админка: так стираются и данные у агента,
и профиль в PostHog.

## Грабли

- **Время.** В `app` — `timestamptz`, в `agent` — текст ISO в UTC (`…Z`); люди считают сутки по Москве (UTC+3).
- **Тестовые аккаунты.** `users.properties->>'traffic_type'` = `test` (устройства `loadtest-…`) или `internal`
  (команда) — исключай из любых подсчётов людей.
- **Удалённые аккаунты остаются строками** (`is_deleted`, `deleted_at`); в `properties.deletion` лежит архив личных
  данных — его не выбирай.
- **Связи между базами.** `dialogs.user_id` (текст) = `users.id` (uuid), `dialogs.id` = `dialog_id` событий PostHog.
  Join между базами невозможен: два запроса и сопоставление в файле вне репозитория.
- **`$$` в строке shell** раскрывается в PID — не используй dollar-quoting в `-c`, клади SQL в файл.
- В образах приложений нет ни psql, ни драйвера для ручных запросов: только контейнер `postgres` первичного пода.

## Безопасность

Тексты разговоров (`messages.text`, `dialogs.summary`) читай, только если человек попросил разобрать разговор.
Почта, имена и содержание разговоров не идут в отчёты, задачи, коммиты, PR, тесты и фикстуры: там — обезличенные
числа и синтетические фразы. Выгрузки — вне репозитория, после работы удалить.

Связано: [[backup]] — бэкапы и дампы; [[logs]] — откуда берутся `userId` и `dialogId`; [[analytics]] — те же люди в PostHog.
