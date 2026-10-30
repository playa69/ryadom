-- Путь новых людей по платформе первого открытия: открыл → аккаунт → начал диалог → сказал реплику.
-- Новые — у кого первое событие вообще (за всё время) не раньше since. Параметр: since — UTC, 'YYYY-MM-DD HH:MM:SS'.
-- visitors — не люди: в Telegram Mini App и на лендинге событие до входа анонимно (id устройства, без профиля).
-- Платформа '—' — не было app_opened (только серверные события).
-- spoke_3plus — три реплики и больше ВСЕГО, не в одном диалоге: точный счёт «в одном диалоге» даёт target-people.sql.
SELECT platform,
       count() AS visitors,
       countIf(accounts > 0) AS with_account,
       countIf(dialogs > 0) AS started_dialog,
       countIf(turns > 0) AS spoke,
       countIf(turns >= 3) AS spoke_3plus
FROM (
  SELECT person_id,
         coalesce(argMinIf(properties.app_platform, timestamp, event = 'app_opened'), '—') AS platform,
         countIf(event = 'account_created') AS accounts,
         countIf(event = 'dialog_started') AS dialogs,
         countIf(event = 'dialog_turn') AS turns
  FROM events
  WHERE {{people}}
  GROUP BY person_id
  HAVING min(timestamp) >= toDateTime('{{since}}')
)
GROUP BY platform
ORDER BY visitors DESC
LIMIT 20
