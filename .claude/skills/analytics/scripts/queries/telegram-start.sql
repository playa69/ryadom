-- Telegram Mini App по метке ссылки (`https://t.me/<бот>?startapp=<метка>`, поле start_param события app_opened):
-- сколько устройств открыло, сколько создало аккаунт, сколько сказало реплику и три и больше.
-- Метка человека — первая непустая среди его app_opened; без метки — «(без метки)»: кнопка меню бота, ссылка без
-- параметра, а также запуски до образа PWA, который пишет start_param.
-- Берутся люди, у которых был app_opened из Mini App и первое событие которых не раньше since.
-- Параметр: since — UTC, 'YYYY-MM-DD HH:MM:SS'. visitors — устройства, не люди (до входа события анонимны).
-- spoke_3plus — три реплики и больше ВСЕГО, не в одном диалоге: точный счёт даёт target-people.sql.
SELECT coalesce(nullIf(label, ''), '(без метки)') AS label,
       count() AS visitors,
       countIf(accounts > 0) AS with_account,
       countIf(turns > 0) AS spoke,
       countIf(turns >= 3) AS spoke_3plus
FROM (
  SELECT person_id,
         argMinIf(properties.start_param, timestamp, event = 'app_opened' AND properties.start_param IS NOT NULL) AS label,
         countIf(event = 'account_created') AS accounts,
         countIf(event = 'dialog_turn') AS turns
  FROM events
  WHERE {{people}}
  GROUP BY person_id
  HAVING countIf(event = 'app_opened' AND properties.app_platform = 'telegram') > 0
     AND min(timestamp) >= toDateTime('{{since}}')
)
GROUP BY label
ORDER BY visitors DESC
LIMIT 50
