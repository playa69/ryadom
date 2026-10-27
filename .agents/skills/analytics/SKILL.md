---
name: analytics
description: Продуктовая аналитика «Рядом» в PostHog (EU, проект 300786) — запросы HogQL через API: DAU, воронки, удержание, диалоги и реплики, платформы, UTM, кризисные сигналы, сверка с базой. Использовать при вопросах «сколько людей поговорили», «какой DAU», «воронка регистрации», «удержание», «откуда пришли», «сколько реплик в день», «сколько реальных пользователей», при подготовке метрик и при проверке событий после выката.
---

# Продуктовая аналитика (PostHog)

Проект `Ryadom` в PostHog Cloud EU, id `300786`. Как устроен сбор, что отправляется и чего нет, каталог событий —
[docs/analytics.md](../../../docs/analytics.md); что считается целевым действием и как цифры сверяются с базами —
[docs/analytics-proof.md](../../../docs/analytics-proof.md). Типы событий и свойств — `app/packages/analytics/src/events.ts`.

## Доступ

```bash
node .agents/skills/analytics/scripts/hogql.mjs "SELECT count() FROM events WHERE timestamp > now() - INTERVAL 1 DAY"
node .agents/skills/analytics/scripts/hogql.mjs -f /tmp/dau.sql --json
```

Скрипт шлёт HogQL в `POST /api/environments/300786/query/` и печатает таблицу (`--json` — колонки и строки как JSON).
Нужен личный ключ PostHog с правом `query:read` в `POSTHOG_PERSONAL_API_KEY`; его выдаёт администратор, в чат и в
файлы репозитория он не попадает. Публичный токен проекта `phc_…` (`POSTHOG_KEY`) для запросов не годится: он только
принимает события.

Без ключа, из браузера, где человек вошёл в `eu.posthog.com`, тот же запрос делает `fetch` со страницы проекта
(сессия и заголовок `X-CSRFToken` из cookie `posthog_csrftoken`); работает только пока вкладка открыта на
`eu.posthog.com`. Веб-интерфейс `app.posthog.com` из части регионов отвечает 403 «not available in your region» —
используй `eu.posthog.com`.

**Ничего не менять в проекте без прямой просьбы:** дашборды, инсайты, когорты, настройки проекта, люди. Запросы — только
чтение.

## Фильтр людей

Любой подсчёт людей начинается с исключения тестового и командного трафика:

```sql
WHERE person_id NOT IN COHORT 275976                                   -- нагрузочный тест 13.10, 150 аккаунтов
  AND coalesce(properties.app_env, '') NOT IN ('local', 'staging', 'development')
  AND coalesce(properties.traffic_type, 'real') NOT IN ('test', 'internal')
```

`traffic_type` ставит сервер по аккаунту (`users.properties.traffic_type`): `test` — устройства с id на `loadtest-`,
`internal` — команда, помеченная вручную. Аккаунты новых нагрузочных прогонов нужно дописывать в когорту 275976
(запрос — в docs/analytics.md, «Дашборды и тестовые данные») — это изменение проекта, только по просьбе.

## Шпаргалка

```sql
-- Люди, которые говорили, и реплики по дням (Москва)
SELECT toDate(toTimeZone(timestamp, 'Europe/Moscow')) AS day,
       uniqIf(person_id, event = 'dialog_turn') AS people, countIf(event = 'dialog_turn') AS turns,
       countIf(event = 'component_called') AS calls
FROM events WHERE timestamp > now() - INTERVAL 14 DAY AND <фильтр людей>
GROUP BY day ORDER BY day

-- Сказал хоть что-то: dialog_turn появился 13.10 вечером, до него — счётчики в конце диалога
SELECT count(DISTINCT person_id) FROM events
WHERE (event = 'dialog_turn' OR (event IN ('dialog_ended', 'dialog_interrupted') AND toInt(properties.user_messages) > 0))
  AND <фильтр людей>

-- Платформы и источники
SELECT properties.app_platform, count(DISTINCT person_id) FROM events WHERE event = 'app_opened' AND <фильтр> GROUP BY 1
SELECT properties.$session_entry_utm_source AS source, count(DISTINCT person_id) FROM events
WHERE event = 'account_created' AND <фильтр> GROUP BY source ORDER BY 2 DESC LIMIT 50

-- Удержание: вернулся с репликой через сутки и позже после первой
SELECT count() FROM (
  SELECT person_id, minIf(timestamp, event = 'dialog_turn') AS first, maxIf(timestamp, event = 'dialog_turn') AS last
  FROM events WHERE event = 'dialog_turn' AND <фильтр людей> GROUP BY person_id)
WHERE last >= first + INTERVAL 24 HOUR

-- Кризисные сигналы и SOS: события без человека, время округлено до часа
SELECT event, properties.level, count() FROM events
WHERE event IN ('safety_signal', 'sos_opened', 'hotline_called') AND timestamp > now() - INTERVAL 7 DAY GROUP BY 1, 2
```

Целевое действие (`dialog_turn`) и DAU по нему определены в docs/analytics-proof.md: считай по этим определениям, а
если задача просит другое (например, «разговор от трёх реплик»), назови его в отчёте явно. Готовые карточки — дашборды «Рядом — продукт»
(`https://eu.posthog.com/project/300786/dashboard/1012431`) и «Рядом — воронка и удержание» (`…/dashboard/1020753`).

## Сверка с базой

PostHog сверяется с базами (скилл `db`): `dialog_id` событий = `dialogs.id` в базе `agent`, `person_id` = id аккаунта
(`users.id` в базе `app`). Для пересечения выгрузи оба списка в файлы вне репозитория и сопоставь скриптом; люди,
которые говорили до 10.10.2026, есть в базе, но не в PostHog (аналитики ещё не было).

## Грабли

- **100 строк по умолчанию.** HogQL молча режет ответ, если в запросе нет `LIMIT`; скрипт предупреждает.
- **Время** в `timestamp` — UTC: для суток по Москве `toTimeZone(timestamp, 'Europe/Moscow')`.
- **Типы.** `greatest()` и сравнения между `Int64` и `UInt64` падают: приводи явно или считай в скрипте.
- **События без человека** (`safety_signal`, `password_reset_requested`, `account_deleted`, SOS и линии помощи) — с
  случайным id и временем, округлённым до часа: людей по ним не считают и с действиями человека не сопоставляют.
- **`app_version`** — тег образа (`--build-arg RELEASE`); `0.1.0` значит, что образ собран без него.
- **Свойства людей и событий не выгружай целиком:** в отчёты и задачи — только агрегаты.

Связано: [[db]] — те же люди и диалоги в базах; [[logs]] — расход моделей и токены (Prometheus, Langfuse).
