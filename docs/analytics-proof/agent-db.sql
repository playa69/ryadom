-- Сверка с базой диалогов агента (SQLite, файл на томе агента): сколько разговоров состоялось на самом деле.
--
-- Реплики и диалоги лежат в базе агента независимо от PostHog, поэтому по ней проверяются целевое действие
-- («состоявшийся разговор») и счётчики событий dialog_turn / dialog_ended. Идентификатор dialogs.id — тот же `dialog_id`,
-- что на событиях в PostHog, user_id — тот же id аккаунта.
--
-- Сутки считаем по Москве (+3 часа к UTC, переходов на летнее время нет). Метки времени в базе — UTC, `...Z`.
--
-- Сначала список тестовых и командных аккаунтов из базы приложения (см. app-db.sql, последний запрос):
--   sqlite3 dialogs.db
--   CREATE TEMP TABLE test_users (id TEXT PRIMARY KEY);
--   .import --csv test-users.csv test_users
--   .read agent-db.sql
-- Без списка тестовые аккаунты попадут в цифры. Запуск только на копии файла или с `?mode=ro`: агент пишет в него сам.

.headers on
.mode column

-- Реплики человека по дням: сколько принято (то же, что событие dialog_turn)
SELECT date(substr(m.created_at, 1, 19), '+3 hours') AS day,
       count(*)                                       AS user_messages,
       count(DISTINCT d.user_id)                      AS people_who_spoke
FROM messages m
JOIN dialogs d ON d.id = m.dialog_id
WHERE m.role = 'user'
  AND d.user_id NOT IN (SELECT id FROM test_users)
GROUP BY 1
ORDER BY 1;

-- Состоявшиеся разговоры: диалоги, где человек сказал хотя бы одну реплику, по дню первой реплики.
-- Сюда не входят открытые и брошенные без единого слова, и входят возобновлённые в другой день как тот же диалог один раз.
SELECT date(substr(first_reply, 1, 19), '+3 hours') AS day,
       count(*)                                      AS conversations
FROM (
  SELECT m.dialog_id, min(m.created_at) AS first_reply
  FROM messages m
  JOIN dialogs d ON d.id = m.dialog_id
  WHERE m.role = 'user'
    AND d.user_id NOT IN (SELECT id FROM test_users)
  GROUP BY m.dialog_id
)
GROUP BY 1
ORDER BY 1;

-- Диалоги, начатые заново (resumed = false в PostHog), и из них те, где человек так и не заговорил
SELECT date(substr(d.started_at, 1, 19), '+3 hours')                              AS day,
       count(*)                                                                    AS new_dialogs,
       sum(CASE WHEN EXISTS (SELECT 1 FROM messages m WHERE m.dialog_id = d.id AND m.role = 'user')
                THEN 0 ELSE 1 END)                                                 AS never_spoke
FROM dialogs d
WHERE d.user_id NOT IN (SELECT id FROM test_users)
GROUP BY 1
ORDER BY 1;

-- Построчная сверка с PostHog: по каждому диалогу реплики человека и агента и завершён ли он.
-- В PostHog: dialog_ended с этим dialog_id несёт те же user_messages / assistant_messages (counts = 'dialog').
SELECT d.id                                                   AS dialog_id,
       d.started_at,
       d.ended_at IS NOT NULL                                 AS ended,
       sum(CASE WHEN m.role = 'user' THEN 1 ELSE 0 END)       AS user_messages,
       sum(CASE WHEN m.role = 'assistant' THEN 1 ELSE 0 END)  AS assistant_messages
FROM dialogs d
LEFT JOIN messages m ON m.dialog_id = d.id
WHERE d.user_id NOT IN (SELECT id FROM test_users)
GROUP BY d.id
ORDER BY d.started_at;

-- Расход моделей по дням: строки model_usage по задачам (это единицы расхода, а не обращения; обращения — в PostHog
-- component_called и в Prometheus agent_component_calls_total)
SELECT date(substr(u.created_at, 1, 19), '+3 hours') AS day,
       u.task,
       count(*)                                       AS usage_rows
FROM model_usage u
JOIN dialogs d ON d.id = u.dialog_id
WHERE d.user_id NOT IN (SELECT id FROM test_users)
GROUP BY 1, 2
ORDER BY 1, 2;
