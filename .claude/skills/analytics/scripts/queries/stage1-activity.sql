-- Итоговые цифры этапа 1: активность целевых пользователей и обращения к компонентам в окне [from, to).
-- Целевой пользователь — тот, у кого есть диалог от трёх реплик (подзапрос). Активный день — день по Москве, в который
-- он сказал реплику; dau_days — число таких пар «человек, день».
-- Обращений на активного пользователя в день:
--   по журналу без навыка = calls_no_cache / dau_days;
--   с навыком (системный промпт над моделью, +1 на каждый ход live) = (calls_no_cache + live_calls) / dau_days;
--   со всеми обращениями, включая фразы из кэша, = calls_all / dau_days.
-- Параметры: from, to — UTC, 'YYYY-MM-DD HH:MM:SS'. Окно из одних суток даёт значение за сутки, окно всего периода —
-- среднее за день по периоду.
SELECT uniqIf(person_id, event = 'dialog_turn') AS active_users,
       uniqIf(concat(toString(toDate(toTimeZone(timestamp, 'Europe/Moscow'))), '|', toString(person_id)), event = 'dialog_turn') AS dau_days,
       countIf(event = 'component_called' AND coalesce(toString(properties.cached), 'false') != 'true') AS calls_no_cache,
       countIf(event = 'component_called' AND properties.component = 'live') AS live_calls,
       countIf(event = 'component_called') AS calls_all
FROM events
WHERE timestamp >= toDateTime('{{from}}') AND timestamp < toDateTime('{{to}}') AND {{people}}
  AND person_id IN (
    SELECT person_id FROM events
    WHERE event = 'dialog_turn' AND {{people}}
    GROUP BY person_id, properties.dialog_id
    HAVING count() >= 3
  )
