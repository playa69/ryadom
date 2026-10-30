-- Итоговые цифры этапа 1: целевые пользователи и целевые действия (разговоры от трёх реплик в одном диалоге).
-- Только эпоха dialog_turn (с 13.10.2026 вечером); говорившие раньше — в spoke-before-dialog-turn.sql (поле ge3).
-- Всего целевых пользователей = target_users + ge3 из spoke-before-dialog-turn.sql.
-- Без параметров.
SELECT uniq(person_id) AS target_users, count() AS target_dialogs, round(avg(replies), 1) AS mean_replies
FROM (
  SELECT person_id, properties.dialog_id AS dlg, count() AS replies
  FROM events
  WHERE event = 'dialog_turn' AND {{people}}
  GROUP BY person_id, dlg
  HAVING replies >= 3
)
