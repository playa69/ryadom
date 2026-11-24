# Дашборд метрик для Sber500

Отдельный сервис в своём namespace `dashboard`: страница `https://слышу-рядом.рф/dashboard` и JSON
`https://слышу-рядом.рф/dashboard/api` с шестью метриками по дням за весь период конкурса — с 2026-11-05
по текущие сутки по Москве включительно
(`dau`, `daily_active_account`, `new_users`, `total_users`, `llm_requests`, `tool_requests`; из всех метрик
исключён трафик аккаунтов `test`/`internal`). Код и определения метрик — `dashboard/app.py`, спека —
`openspec/specs/sber500-dashboard`.

Сервисы agent и api дашборд не трогает. Он читает базы `agent` и `app` в сессиях только на чтение и API
Langfuse, а после полуночи по Москве закрывает завершённые сутки снимком в собственную базу `dashboard` в кластере
CNPG `ryadom-db` (одна таблица `daily_metrics`: дата и шесть целых чисел, без текстов и id людей; запись —
`INSERT ... ON CONFLICT (day) DO NOTHING`, прошлые сутки не пересчитываются). Завершённые дни страница и JSON
читают только из этого хранилища; текущие сутки снимком не закрываются — их метрики считаются из баз
`agent`/`app` и Langfuse при обновлении кэша в памяти (не чаще раза в час) и отдаются как предварительные.
При сбое хранилища или сырых источников отдаётся последний удачный отчёт из кэша, при холодном старте без
базы — 503. Вход — basic auth (логин `sber500`), неудачные входы ограничены по IP.

## Secret

`dashboard-secrets` в ns `dashboard` собирается из Lockbox `ryadom-app-secrets` помощником создания Secret'ов,
сначала с `--dry-run=server`. Значения хранятся у администратора.

| Ключ Secret'а | Ключ в Lockbox |
|---|---|
| `DIALOG_DATABASE_URL` | `AGENT_DIALOG_DATABASE_URL` (то же значение, что в Secret `agent-db` агента; чтение базы `agent`) |
| `APP_DATABASE_URL` | `APP_DATABASE_URL` (новая запись; read-only пользователь базы `app`, см. ниже) |
| `DASHBOARD_DATABASE_URL` | `DASHBOARD_DATABASE_URL` (новая запись; роль `dashboard`, запись только в свою базу) |
| `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` | `AGENT_LANGFUSE_PUBLIC_KEY`, `AGENT_LANGFUSE_SECRET_KEY` (то же, что в `agent-secrets`) |
| `DASHBOARD_PASSWORD` | `DASHBOARD_PASSWORD` |

Пароль роли `dashboard` дополнительно хранится в Secret `dashboard-db-credentials` (ключ `password`) в ns
`ryadom-db` — его читает Job создания базы (`k8s/app/db/02-job-create-dashboard-db.yaml`). Создаётся вручную
`kubectl create secret generic` (не `apply`), значение то же, что в `DASHBOARD_DATABASE_URL`.

Если у агента сменились пароль базы или ключи Langfuse, сначала обновляется Lockbox, затем Secret дашборда
пересоздаётся. `registry-pull` в ns `dashboard` — копия общего секрета реестра из ns `agent` (в Lockbox его нет).

### Read-only пользователь базы `app` (для `APP_DATABASE_URL`)

Отдельная роль `dashboard_app_ro` — НЕ роль `dashboard`: у роли `dashboard` прав на базы `agent` и `app`
нет и быть не должно (это контролирует Job создания базы). Роль создаёт администратор вручную под
суперпользователем postgres (скилл `db`), идемпотентно:

```sql
-- в базе postgres:
CREATE ROLE dashboard_app_ro LOGIN PASSWORD '<пароль из Lockbox APP_DATABASE_URL>';  -- если роли нет
GRANT CONNECT ON DATABASE app TO dashboard_app_ro;
-- в базе app:
GRANT USAGE ON SCHEMA public TO dashboard_app_ro;
GRANT SELECT ON users, user_reply_counts TO dashboard_app_ro;
```

Больше ничего не выдавать: дашборду нужны только `users` (метка `traffic_type`) и `user_reply_counts`
(`first_reply_at`).

## Выкат метрик v2 (порядок строгий)

Прод — только после явного «да» владельца на каждую операцию. Применять поимённо, admin-kubeconfig.

**Порядок: база/роли/секреты → образ dashboard → backfill (дождаться Complete) → только потом новый
Deployment.** Backfill и фоновое закрытие суток (snapshotter) нового Deployment одновременно работать не
должны, поэтому Deployment 0.2.0 выкатывается последним.

1. **Агент с TOOL-инструментацией памяти** — образ агента выкачен первым (по скиллу `deploy`), записи TOOL
   в Langfuse начинают появляться; поведение диалогов не меняется. Зафиксировать фактический день выката:
   если он не 2026-11-17, до дальнейших шагов поправить `TOOL_REQUESTS_SINCE` в
   `k8s/dashboard/02-deployment.yaml` и `k8s/dashboard/05-job-backfill.yaml`.
2. **База и роли**: создать Secret `dashboard-db-credentials` в ns `ryadom-db`, затем
   `kubectl apply -f k8s/app/db/02-job-create-dashboard-db.yaml` и
   `kubectl -n ryadom-db wait --for=condition=complete job/create-dashboard-db`. Проверка (скилл `db`):
   база и роль существуют, `has_database_privilege('dashboard','app','CREATE')` и `…,'agent','CREATE')` — false.
   Роль `dashboard_app_ro` для `APP_DATABASE_URL` — SQL из раздела выше.
3. **Lockbox и Secret**: добавить записи `APP_DATABASE_URL` и `DASHBOARD_DATABASE_URL` в Lockbox, пересобрать
   `dashboard-secrets` помощником — сначала прогон с `--dry-run=server`, затем реальное применение. Ключи
   Langfuse и `DASHBOARD_PASSWORD` остаются прежними. Бегущий старый под 0.1.0 пересоздание Secret'а не
   затрагивает (env читается при старте пода).
4. **Образ**: `cr.yandex/crpsqeamqpuvrkm5tpr9/app/dashboard:0.2.0` собран из `dashboard/` под linux/amd64 и
   отправлен в реестр — до этого шага Job и Deployment не применять (поды не стартуют без образа).
5. **Backfill истории**: `kubectl apply -f k8s/dashboard/05-job-backfill.yaml`,
   `kubectl -n dashboard wait --for=condition=complete job/dashboard-backfill --timeout=1800s`,
   журнал — `kubectl -n dashboard logs job/dashboard-backfill`. Backfill закрывает только завершённые сутки,
   текущие сутки остаются предварительными и считаются подом из сырых источников. Пока идёт backfill,
   страницу обслуживает старый под 0.1.0, который в `daily_metrics` не пишет. Если Deployment 0.2.0 по ошибке
   уже выкачен — сначала `kubectl -n dashboard scale deploy/dashboard --replicas=0`, затем backfill, затем
   вернуть реплику на шаге 6. Повторный запуск backfill — no-op (пишет только дни без снимка).
6. **Дашборд**: `kubectl apply -f k8s/dashboard/02-deployment.yaml`,
   `kubectl -n dashboard rollout status deploy/dashboard --timeout=120s`. `kubectl diff` до применения
   должен показать только новые env и тег образа.
7. **Проверка**: `curl -sI https://слышу-рядом.рф/dashboard` → 401; с логином → 200; `/dashboard/api`
   отдаёт по дню на каждые сутки с 2026-11-05 по текущие московские сутки включительно с полями `dau`,
   `llm_requests`, `tool_requests`, `total_users`, `new_users`, `daily_active_account`; текущие сутки —
   реальные предварительные данные, не нулевая заглушка; в журнале пода — закрытие суток и catch-up без ошибок.

Первичный выкат namespace с нуля — как раньше (`00-namespace.yaml`, `01-network-policy.yaml`, patch
`ryadom-db-allow-ingress`, политика `infra-allow-ingress-dashboard-langfuse`, Secret'ы, Deployment, Service,
HTTPRoute); сеть к `ryadom-db` и Langfuse уже разрешена и под базу снимков подходит без изменений.

### Даты начала точного учёта

`LLM_REQUESTS_SINCE` (`2026-11-05` — доступная история Langfuse) и `TOOL_REQUESTS_SINCE` (день выката
агента с TOOL-инструментацией) — обычные env в манифестах, не секреты; более ранние дни получают 0 и
честную пометку на странице. Значения в `02-deployment.yaml` и `05-job-backfill.yaml` должны совпадать.

## Выкат 0.2.1 (восстановление сообщений из Langfuse) и пересчёт снимков 05.11–16.11

Причина: сохранённая история сообщений в базе `agent` неполна — дни 11–16.11.2026 в `messages` отсутствуют
вовсе, провалы есть и в другие дни. Снимки, записанные версией 0.2.0, посчитаны по неполной базе, поэтому
`dau`/`daily_active_account` в них занижены (вплоть до нулевого DAU в дни провалов). Нулевые `tool_requests`
в снимках — НЕ следствие неполной базы `messages`: вызовы памяти считаются по Langfuse, а реальных успешных
вызовов до выката TOOL-инструментации агента не было. Версия 0.2.1 считает «сообщения» по объединению базы и
трейсинга Langfuse (live-turn трассы, max по паре «день, аккаунт» — без двойного счёта; см.
`dashboard/README.md`).

Снимки неизменны по дизайну: backfill пишет только дни без снимка и сам ничего не пересчитает. Пересчёт
05.11–16.11.2026 требует **отдельного явного разрешения владельца на удаление** строк `daily_metrics` за эти
дни. Без разрешения строки НЕ трогаем.

Порядок (прод — только после «да» владельца на каждую операцию, admin-kubeconfig):

1. Собрать и отправить образ `cr.yandex/crpsqeamqpuvrkm5tpr9/app/dashboard:0.2.1` (linux/amd64) — до этого
   шага Job и Deployment не применять.
2. Остановить snapshotter: `kubectl -n dashboard scale deploy/dashboard --replicas=0` — иначе catch-up
   версии 0.2.0 тут же перезапишет удалённые дни старым расчётом.
3. По отдельному разрешению владельца: удалить строки снимков за 05.11–16.11.2026 в базе `dashboard`
   (скилл `db`, ручной `DELETE FROM daily_metrics WHERE day BETWEEN '2026-11-05' AND '2026-11-16'`).
4. Пересоздать Job backfill (старый Job удалить: `kubectl -n dashboard delete job dashboard-backfill`),
   применить `k8s/dashboard/05-job-backfill.yaml` (образ 0.2.1), дождаться Complete, посмотреть журнал.
5. Выкатить Deployment 0.2.1: `kubectl apply -f k8s/dashboard/02-deployment.yaml`,
   `kubectl -n dashboard rollout status deploy/dashboard --timeout=120s`.
6. Проверка: `/dashboard/api` — дни 11.11–16.11 ненулевые (DAU/новые/всего выросли относительно 0.2.0),
   текущие сутки — предварительные по тому же объединённому расчёту; в журнале пода — backfill и закрытие
   суток без ошибок.

## Откат

- **Дашборд**: `kubectl -n dashboard rollout undo deploy/dashboard` (образ 0.1.0): `DIALOG_DATABASE_URL` и
  ключи Langfuse на месте, лишние ключи Secret'а старым образом игнорируются.
- **Агент**: прежним образом (по скиллу `deploy`) — записи TOOL перестают появляться; дашборд посчитает за
  те сутки меньшее, но честное число.
- **Ошибочный запуск backfill** (одновременно со snapshotter или до готовности базы): остановить под —
  `kubectl -n dashboard delete job dashboard-backfill`; при работающем snapshotter —
  `kubectl -n dashboard scale deploy/dashboard --replicas=0`. Уже записанные строки `daily_metrics` НЕ
  удалять и не перезаписывать автоматически: снимки неизменны по дизайну, разбор расхождений и любой
  `DELETE` — только вручную по отдельному разрешению владельца (чтение — по скиллу `db`), после чего
  вернуть реплику дашборда.
- Базу `dashboard` и роли при откате НЕ удаляем: они никому не мешают, а снимки пригодятся при повторном
  выкате. Удаление — только осознанно (ниже).

## Удаление

`kubectl delete ns dashboard`, затем убрать строку `dashboard` из `ryadom-db-allow-ingress` и политику
`infra-allow-ingress-dashboard-langfuse` (или оставить: без namespace они ничего не открывают). База, роли
и Secret `dashboard-db-credentials` при этом остаются: их удаление — отдельная прод-операция по явному «да»
владельца (`DROP DATABASE dashboard`, `DROP ROLE dashboard`, `DROP ROLE dashboard_app_ro` после отзыва
GRANT'ов в базе `app`), снимки до этого сохраняются в daily-бэкапе CNPG.

## Публикация API ежедневных метрик (PROTEUS-343)

Выгрузка использует действующий ключ `METRICS_API_TOKEN` в `dashboard-secrets`. Применяются Deployment
с новым образом и HTTPRoute для префикса `/api/v1/metrics`. Сервис при старте создаёт таблицу агрегатов в своей
базе и восстанавливает историю в фоне. Readiness нового пода проходит после первого успешного расчёта. Права в базах-источниках уже включают чтение `users.created_at`.

Перед передачей доступа коллектору проверьте 401 без токена и 200 с токеном за последние 15 завершённых
московских суток. После успешной проверки URL, `startup_id` и токен передаются через форму подключения.
