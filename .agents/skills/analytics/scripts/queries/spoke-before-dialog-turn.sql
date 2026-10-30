-- Говорившие до того, как появилось событие dialog_turn (13.10.2026 вечером): у них нет ни одного dialog_turn,
-- реплики видны только в счётчике user_messages при завершении и обрыве диалога.
-- ge3 — сумма по всем их диалогам не меньше трёх: приближение, диалоги тогда ещё не различались по dialog_id.
-- Прибавляй к результату target-people.sql, когда нужен накопительный итог с начала сбора (10.10.2026).
SELECT count() AS persons, countIf(replies >= 3) AS ge3
FROM (
  SELECT person_id, sum(toFloat(properties.user_messages)) AS replies, countIf(event = 'dialog_turn') AS turns
  FROM events
  WHERE event IN ('dialog_ended', 'dialog_interrupted', 'dialog_turn') AND {{people}}
  GROUP BY person_id
  HAVING turns = 0 AND replies > 0
)
