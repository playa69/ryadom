-- Итоговые цифры этапа 1: возврат через N часов среди ЦЕЛЕВЫХ пользователей (retention.sql считает всех говоривших).
-- Вернулся — последняя реплика позже первой не меньше чем на N часов; знаменатель base — те из целевых, чья первая
-- реплика была больше N часов назад. Для отчёта N = 12.
-- Параметр: hours.
SELECT countIf(last_turn >= first_turn + INTERVAL {{hours}} HOUR) AS returned, count() AS base
FROM (
  SELECT person_id, min(timestamp) AS first_turn, max(timestamp) AS last_turn
  FROM events
  WHERE event = 'dialog_turn' AND {{people}}
    AND person_id IN (
      SELECT person_id FROM events
      WHERE event = 'dialog_turn' AND {{people}}
      GROUP BY person_id, properties.dialog_id
      HAVING count() >= 3
    )
  GROUP BY person_id
)
WHERE first_turn <= now() - INTERVAL {{hours}} HOUR
