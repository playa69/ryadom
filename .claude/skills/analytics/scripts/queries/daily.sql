-- Говорившие, реплики, вызовы компонентов и новые аккаунты по дням (Москва).
-- Параметр: days — за сколько суток (например, 14). Последние сутки неполные.
-- visitors_and_people считает любые события, в том числе анонимные открытия приложения (устройства, не люди).
SELECT toDate(toTimeZone(timestamp, 'Europe/Moscow')) AS day,
       uniqIf(person_id, event = 'dialog_turn') AS speakers,
       countIf(event = 'dialog_turn') AS turns,
       countIf(event = 'component_called') AS calls,
       countIf(event = 'account_created') AS new_accounts,
       uniq(person_id) AS visitors_and_people
FROM events
WHERE timestamp > now() - INTERVAL {{days}} DAY AND {{people}}
GROUP BY day
ORDER BY day
LIMIT 100
