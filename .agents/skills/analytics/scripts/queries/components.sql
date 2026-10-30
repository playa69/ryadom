-- Вызовы компонентов агента: сколько и у скольких людей, по компоненту, исходу и признаку кэша.
-- Параметр: since — UTC, 'YYYY-MM-DD HH:MM:SS'.
-- live — ход речи в речь, safety — проверка реплики, memory — поиск сводки, tts с cached = true — фраза из кэша.
SELECT properties.component AS component,
       properties.outcome AS outcome,
       properties.cached AS cached,
       count() AS calls,
       uniq(person_id) AS people
FROM events
WHERE event = 'component_called' AND timestamp >= toDateTime('{{since}}') AND {{people}}
GROUP BY component, outcome, cached
ORDER BY calls DESC
LIMIT 50
