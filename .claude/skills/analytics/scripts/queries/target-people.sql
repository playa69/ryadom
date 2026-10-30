-- Люди, которые говорили, и из них — с разговором от N реплик В ОДНОМ диалоге (по dialog_id).
-- Параметр: replies — порог (1 — целевое действие по docs/analytics.md, 3 — «разговор от трёх реплик»).
-- Только эпоха dialog_turn (с 13.10.2026 вечером); говорившие раньше — в spoke-before-dialog-turn.sql.
SELECT count() AS spoke, countIf(best >= {{replies}}) AS target
FROM (
  SELECT person_id, max(replies) AS best
  FROM (
    SELECT person_id, properties.dialog_id AS dlg, count() AS replies
    FROM events
    WHERE event = 'dialog_turn' AND {{people}}
    GROUP BY person_id, dlg
  )
  GROUP BY person_id
)
