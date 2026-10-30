-- Какие экраны открывают: просмотры и люди по маршруту (идентификаторы в пути заменены на :id).
-- Параметр: since — UTC, 'YYYY-MM-DD HH:MM:SS'. Экраны с личным содержимым (разговор, журнал, память) сами по себе
-- видны как просмотр, но клики внутри них не снимаются.
SELECT properties.screen AS screen, count() AS views, uniq(person_id) AS people
FROM events
WHERE event = '$pageview' AND timestamp >= toDateTime('{{since}}') AND {{people}}
GROUP BY screen
ORDER BY views DESC
LIMIT 30
