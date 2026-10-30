-- Откуда приходят: входные сессии по рефереру и UTM. Берутся клиентские $pageview: у серверных событий
-- (account_created, dialog_turn…) полей $session_entry_* нет.
-- Параметр: since — UTC, 'YYYY-MM-DD HH:MM:SS'.
-- $direct — реферера нет (набрал адрес, мессенджер, WebView Telegram Mini App — отличить нельзя);
-- свой домен слышу-рядом.рф (xn----htbtgjker8b3a2c.xn--p1ai) — переход лендинг → приложение.
SELECT coalesce(properties.$session_entry_referring_domain, '∅') AS referrer,
       coalesce(properties.$session_entry_utm_source, '') AS utm_source,
       coalesce(properties.$session_entry_utm_medium, '') AS utm_medium,
       coalesce(properties.$session_entry_utm_campaign, '') AS utm_campaign,
       uniq(properties.$session_id) AS sessions,
       uniq(person_id) AS visitors
FROM events
WHERE event = '$pageview' AND timestamp >= toDateTime('{{since}}') AND {{people}}
GROUP BY referrer, utm_source, utm_medium, utm_campaign
ORDER BY sessions DESC
LIMIT 50
