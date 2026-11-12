-- Итоговые цифры этапа 1: реплики пользователей (событие dialog_turn, все настоящие люди) в окне [from, to).
-- Параметры: from, to — UTC, 'YYYY-MM-DD HH:MM:SS' (сутки по Москве: вчера 00:00 МСК = позавчера 21:00 UTC).
SELECT count() AS replies
FROM events
WHERE event = 'dialog_turn' AND timestamp >= toDateTime('{{from}}') AND timestamp < toDateTime('{{to}}') AND {{people}}
