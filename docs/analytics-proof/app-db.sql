-- Сверка с базой приложения (PostgreSQL): сколько аккаунтов и согласий на самом деле, без оглядки на PostHog.
--
-- Это второй источник для воронки: строки users не зависят от блокировщика, от отказа человека от аналитики и от того,
-- дошло ли событие до PostHog. Удалённые аккаунты остаются строками (is_deleted), поэтому «сколько людей когда-либо
-- регистрировалось» считается здесь надёжно, а в PostHog это нижняя граница.
--
-- Сутки считаем по Москве, как конкурс. Тестовые и командные аккаунты (users.properties.traffic_type = test | internal)
-- отсечены: те же, что в PostHog помечены traffic_type и не входят в цифры.
--
-- Запуск (read-only, из пода или через проброшенный порт):  psql "$DATABASE_URL" -f app-db.sql

\echo '== Аккаунты по дням (МСК), без тестовых и командных =='
SELECT (created_at AT TIME ZONE 'Europe/Moscow')::date AS day,
       count(*)                                         AS accounts_created,
       count(*) FILTER (WHERE is_deleted)               AS later_deleted
FROM users
WHERE coalesce(properties ->> 'traffic_type', 'real') = 'real'
GROUP BY 1
ORDER BY 1;

\echo '== Принятые согласия: люди по дням первого принятия (то же, что consents_accepted) =='
SELECT (first_accepted AT TIME ZONE 'Europe/Moscow')::date AS day,
       count(*)                                             AS people
FROM (
  SELECT c.user_id, min(c.accepted_at) AS first_accepted
  FROM user_consents c
  JOIN users u ON u.id = c.user_id
  WHERE coalesce(u.properties ->> 'traffic_type', 'real') = 'real'
  GROUP BY c.user_id
) per_person
GROUP BY 1
ORDER BY 1;

\echo '== Сколько аккаунтов какого типа трафика: видно, что не считается людьми =='
SELECT coalesce(properties ->> 'traffic_type', 'real') AS traffic_type,
       count(*)                                         AS accounts,
       min(created_at)                                  AS first_created,
       max(created_at)                                  AS last_created
FROM users
GROUP BY 1
ORDER BY 1;

\echo '== Идентификаторы тестовых и командных аккаунтов (для agent-db.sql): вывести в test-users.csv =='
-- \copy (SELECT id FROM users WHERE coalesce(properties ->> 'traffic_type', 'real') <> 'real') TO 'test-users.csv'
