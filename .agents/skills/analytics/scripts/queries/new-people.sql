-- Новые говорившие по дням: первая реплика человека (за всё время) позже момента since.
-- Параметры: since — UTC, 'YYYY-MM-DD HH:MM:SS' (Москва минус 3 часа); replies — порог целевого действия (например, 3).
-- new_target — те из новых, у кого есть диалог от replies реплик. Кто заговорил ДО since и стал целевым ПОСЛЕ,
-- сюда не попадает: сравнивай с накопительным итогом из target-people.sql.
SELECT toDate(toTimeZone(first_turn, 'Europe/Moscow')) AS day,
       count() AS new_speakers,
       countIf(best >= {{replies}}) AS new_target
FROM (
  SELECT person_id, min(t0) AS first_turn, max(replies) AS best
  FROM (
    SELECT person_id, properties.dialog_id AS dlg, min(timestamp) AS t0, count() AS replies
    FROM events
    WHERE event = 'dialog_turn' AND {{people}}
    GROUP BY person_id, dlg
  )
  GROUP BY person_id
  HAVING first_turn > toDateTime('{{since}}')
)
GROUP BY day
ORDER BY day
LIMIT 100
