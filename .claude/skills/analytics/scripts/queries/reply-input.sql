-- Чем говорят: реплики голосом и текстом, и сколько людей пользуется каждым способом.
-- Параметр: since — UTC, 'YYYY-MM-DD HH:MM:SS'.
SELECT properties.input AS input, count() AS replies, uniq(person_id) AS people
FROM events
WHERE event = 'dialog_turn' AND timestamp >= toDateTime('{{since}}') AND {{people}}
GROUP BY input
ORDER BY replies DESC
LIMIT 10
