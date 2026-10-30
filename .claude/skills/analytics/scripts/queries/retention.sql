-- Возврат через N часов: последняя реплика человека позже первой не меньше чем на N часов.
-- Знаменатель base — только те, чья первая реплика была больше N часов назад (остальным вернуться ещё рано).
-- Параметр: hours (например, 12 и 24). Считается по dialog_turn, то есть для эпохи с 13.10.2026 вечером.
SELECT countIf(last_turn >= first_turn + INTERVAL {{hours}} HOUR) AS returned, count() AS base
FROM (
  SELECT person_id, min(timestamp) AS first_turn, max(timestamp) AS last_turn
  FROM events
  WHERE event = 'dialog_turn' AND {{people}}
  GROUP BY person_id
)
WHERE first_turn <= now() - INTERVAL {{hours}} HOUR
