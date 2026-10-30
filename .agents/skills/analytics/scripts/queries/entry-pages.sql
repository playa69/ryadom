-- С какой страницы начинаются сессии. /pwa/ вместе с app_platform = telegram — Telegram Mini App,
-- / — лендинг, /app/… — веб-приложение.
-- Параметр: since — UTC, 'YYYY-MM-DD HH:MM:SS'.
SELECT coalesce(properties.$session_entry_pathname, '∅') AS entry,
       uniq(properties.$session_id) AS sessions,
       uniq(person_id) AS visitors
FROM events
WHERE event = '$pageview' AND timestamp >= toDateTime('{{since}}') AND {{people}}
GROUP BY entry
ORDER BY sessions DESC
LIMIT 20
