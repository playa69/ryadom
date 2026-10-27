# Tasks: add-job-queue

Контракт — `specs/{account-deletion,data-retention,mood-diary,product-analytics}/spec.md` (четыре MODIFIED). Решения — `design.md` (D1–D10). Change ведётся без номера задачи (решение владельца). Этапы: 1 — 1.x и 3.1–3.4 (очередь и три расписания); 2 — 3.5 и 3.8 (стирание в аналитике); 3 — 3.6 (после удаления разговора); 4 — 3.7 (сторож). Этапы 3 и 4 можно отложить, не ломая остальные.

## 0. Решения

- [x] 0.1 Решения владельца по открытым вопросам `design.md` приняты 27.10: воркеры внутри `api`, без сверки стирания в аналитике, проход дневника не оптимизируем, без номера задачи. Приёмка: ответы записаны в «Решено владельцем» (`design.md`), `validate add-job-queue --strict` зелёный
- [x] 0.2 Согласовать с `add-notifications` (задача 2.4, решение D4): планировщик уведомлений строится на этой очереди. Приёмка: в `add-notifications/tasks.md` у 2.4 стоит «→ add-job-queue», D4 исправлена после слияния этого change'а

## 1. Данные и контракты

- [x] 1.1 Зависимость `pg-boss` точной версии `12.38.0` в `app/packages/db` и `app/services/api`; `pnpm-lock.yaml`. Приёмка: `pnpm install --frozen-lockfile` проходит, `pnpm --filter @ryadom/api build` собирает бандл без новых внешних модулей в `build.mjs` (`EXTERNAL`), собранный `dist/index.js` стартует
- [x] 1.2 Мигратор: `runMigrations` ставит схему pg-boss после drizzle-миграций под той же `pg_advisory_lock` (`app/packages/db/src/migrate.ts`; программный запуск без supervise и schedule, `design.md`, D2). Приёмка: `app/packages/db/test/migrate-jobs.test.ts` — на пустой базе от роли, владельца базы без прав суперпользователя, схема `pgboss` создана и версия последняя; повторный запуск ничего не применяет; недоступная база — исключение (ненулевой выход `migrate`)
- [x] 1.3 Образ `migrate`: `app/packages/db/build.mjs` собирает pg-boss в `migrate.mjs`. Приёмка: `docker build` образа из `app/packages/db/Dockerfile` и запуск на пустой базе даёт «applied …» и схему `pgboss`; размер образа и список внешних модулей записаны в отчёте
- [x] 1.4 Тестовая база: шаблон (`app/packages/db/src/test-db.ts`) включает схему pg-boss, а имя шаблона зависит и от версии схемы pg-boss (сегодня только от хеша drizzle-миграций, `ensureTemplate`). Приёмка: после смены версии pg-boss в тестовой среде шаблон пересоздаётся; в базе теста есть `pgboss.version`; `truncate` в `setup.ts` не трогает схему `pgboss`, тесты с задачами чистят свои очереди сами
- [x] 1.5 Сервис `job-queue-service` в ядре (`app/packages/core/src/services/job-queue-service/`): `EnqueueJobRequest`, `CancelJobRequest`, транспорты `memory` (с `getEnqueuedJobs()`) и регистрируемый, имена очередей и типы данных (`jobs.ts`), по правилам `app/packages/core/AGENTS.md` (фасад, контракты, `requestName`). Приёмка: тест ядра `app/packages/core/test/job-queue.test.ts` — задача попадает в транспорт `memory` с данными и параметрами; без зарегистрированного транспорта — исключение; дубль по ключу возвращает `jobId: null`
- [x] 1.6 Переменные `JOBS_WORKERS_ENABLED` (по умолчанию `true`), `JOBS_POOL_MAX` (4), `JOBS_STOP_TIMEOUT_MS` (10000): схема `appEnvSchema` (`app/packages/core/src/config/env.ts`), `app/services/api/.env.example`, `k8s/app/00-app-config.yaml`. Приёмка: `app/services/api/test/env.test.ts` — значения по умолчанию, ошибка на нечисловом значении; ключи есть в манифесте

## 2. Агент

- [x] 2.1 Изменений в агенте нет. Приёмка: `git diff --stat origin/main-cleanup -- agent` пуст в ветке change'а; тест `app/services/api/test/jobs.test.ts` фиксирует, как агент отвечает на повторный `DELETE /v1/users/{id}` и на `DELETE …/dialogs/{id}` уже удалённого разговора (на заглушке из `app/dev/agent-mock`); если повтор не считается успехом, это отдельный change для агента, а не правка здесь

## 3. Шлюз API

- [x] 3.1 Каркас: `app/services/api/src/lib/jobs.ts` — pg-boss с `migrate: false`, `max: JOBS_POOL_MAX`, обработчик `error` в журнал, `start`; регистрация транспорта ядра (`fromDrizzle(getDb(), sql)`); создание очередей каталога (`createQueue`, при смене опций `updateQueue`). Приёмка: `app/services/api/test/jobs.test.ts` — задача, поставленная внутри `inTransaction`, видна после коммита и отсутствует после отката; повторный старт не падает; старт на базе без схемы — исключение
- [x] 3.2 Реестр и каталог: `app/services/api/src/jobs/registry.ts` и по файлу на работу (`design.md`, D4); воркеры стартуют при `JOBS_WORKERS_ENABLED`. Приёмка: тест — при `false` ни воркер, ни расписание не регистрируются, а постановка работает; параметры очередей совпадают с таблицей D4
- [x] 3.3 Остановка: `app/services/api/src/lib/shutdown.ts` и `index.ts` — `offWork` на `SIGTERM`, `boss.stop` перед закрытием пула ядра, `HARD_EXIT_MS` 30 с, исправить устаревший комментарий про 15 с (`design.md`, D7). Приёмка: `app/services/api/test/shutdown.test.ts` — порядок шагов и сроки; тест с настоящим pg-boss — задача, идущая при остановке, завершается, не уложившаяся возвращается в очередь и берётся другим экземпляром
- [x] 3.4 Три расписания: `sessions.purge-expired`, `accounts.purge-inactive-anonymous`, `diary.weekly-pass`; убрать `setInterval` и `setTimeout` из `index.ts`, `startDiaryScheduler` и его вызов. Приёмка: прежние тесты `diary.test.ts`, `diary-analytics.test.ts`, `anonymous.test.ts`, `sessions.test.ts` зелёные; новый тест на двух экземплярах pg-boss над одной базой — за три минуты по одному запуску каждого расписания, проход дневника не стартует поверх предыдущего (сценарии «Несколько реплик и частые перезапуски» и «Две реплики»)
- [x] 3.5 Стирание в аналитике: очередь `analytics.erase-person`; постановка внутри транзакции `DeleteAccountOperationHandler` (`app/packages/core/src/processes/account-deletion/delete-account/`); воркер вызывает `eraseNow` без таймера; убрать `void analytics.erasePerson` в `routes/auth/me.ts`, таймер и `pendingErasures` в `app/packages/analytics/src/server.ts`, опцию `erasureDelayMs`. Приёмка: тесты `app/packages/core/test/account-deletion.test.ts` и `app/services/api/test/account.test.ts` — удаление ставит задачу с выдержкой 30 с, откат удаления задачи не оставляет, сбой PostHog повторяется, `not_configured` завершает задачу без повторов, исчерпание повторов оставляет запись в `jobs.dead-letter` и строку в журнале с идентификатором; `app/packages/analytics/test/server.test.ts` обновлён
- [x] 3.6 После удаления разговора: очередь `dialogs.after-delete`; постановка до вызова агента в `DeleteDialogOperationHandler`, отмена после успешного сброса в маршруте (`routes/dialogs/index.ts`), обработчик проверяет у агента, что разговора нет, отзывает ссылку и сбрасывает неделю. Приёмка: сценарии «Сброс после удаления не удался» и «Удаление разговора не состоялось» из дельты `mood-diary`: `app/services/api/test/dialogs.test.ts` и `app/packages/core/test/diary.test.ts`
- [x] 3.7 Сторож `jobs.watchdog` (`design.md`, D5). Приёмка: тест — при задаче в `jobs.dead-letter` или готовой задаче старше 10 минут в журнале `warn` с именем очереди и числами, при пустых очередях тишина; данные задач в журнал не попадают
- [ ] 3.8 Проверка стирания в PostHog: как отвечает `bulk_delete` на уже стёртую персону, и обработчик 3.5 считает такой ответ успехом. Приёмка: результат проверки на тестовом проекте PostHog записан в `design.md` («Не проверено» → «Проверено»), тест в `app/packages/analytics/test/admin.test.ts` **Не сделано**: нужен тестовый проект PostHog, ключей при реализации не было. Обработчик ведёт себя по D6: ответ без ошибок удаления — успех, любой другой — повтор очереди (после исчерпания — `jobs.dead-letter`); как PostHog отвечает на уже стёртую персону, не проверено.

## 4. Клиенты

- [x] 4.1 Клиенты не меняются: контракты, экраны и тексты прежние. Приёмка: `git diff --stat origin/main-cleanup -- app/apps app/packages/client-core app/packages/contracts` пуст

## 5. Проверка

- [x] 5.1 Модульные и интеграционные тесты: `pnpm turbo run test --filter='!@ryadom/e2e'` и `pnpm turbo run typecheck`. Приёмка: зелёные
- [x] 5.2 Сценарии дельт покрыты тестами. Приёмка: каждый сценарий ниже назван в тесте и проходит

| Требование | Сценарий | Тест |
|---|---|---|
| Профиль и события в аналитике (`account-deletion`) | (API) Удаление человеком | `core/test/account-deletion.test.ts`, `api/test/account.test.ts`, `api/test/jobs.test.ts` (настоящая очередь) |
| | (API) Удаление не состоялось | `core/test/account-deletion.test.ts`, `api/test/account.test.ts`, `api/test/jobs.test.ts` (откат уносит и задачу) |
| | (API) Другие способы удаления | `core/test/user-management.test.ts`, `core/test/anonymous-retention.test.ts` (задач нет) |
| Стирание при удалении аккаунта (`product-analytics`) | Сбой стирания | `api/test/jobs.test.ts` (повторы, очередь недоставленных) |
| | Остановка пода | `api/test/shutdown.test.ts` + `jobs.test.ts` (задача переживает остановку) |
| | Несколько реплик | `api/test/jobs.test.ts` (два экземпляра) |
| | Удаление человеком, Ключа нет | `api/test/jobs.test.ts`, `analytics/test/server.test.ts`, `api/test/env.test.ts` |
| Чистка неактивных гостевых аккаунтов | Несколько реплик и частые перезапуски | `api/test/jobs.test.ts` |
| | прежние пять сценариев | `core/test/anonymous-retention.test.ts` без изменений |
| Когда пересчитываются итоги недели | Сброс после удаления не удался | `api/test/dialogs.test.ts`, `api/test/jobs.test.ts`, `core/test/dialogs.test.ts`, `core/test/diary.test.ts` |
| | Удаление разговора не состоялось | `api/test/dialogs.test.ts`, `core/test/dialogs.test.ts` |
| | Две реплики | `api/test/jobs.test.ts` |
| | прежние четыре сценария | `core/test/diary.test.ts`, `api/test/diary.test.ts` без изменений |

- [x] 5.3 e2e удаления аккаунта и дневника проходят как прежде. Приёмка: `app/e2e/tests/web-account.spec.ts` и `web-diary.spec.ts` (проект `desktop`), `app-account.spec.ts` и `app-diary.spec.ts` (проект `mobile`) зелёные
- [ ] 5.4 Ручная проверка на стенде с двумя экземплярами `api` (`app/scripts/stand.mjs`): убить один посреди задачи, перезапустить оба, остановить по `SIGTERM` при идущей задаче. Приёмка: в отчёте — время возврата задачи, число запусков каждой работы, коды закрытия сокетов, что случилось с хвостом остановки (сайдкар Istio из `design.md`, D7 на стенде без кластера не проверить: записать как не проверенное)
- [x] 5.5 Скриншоты не нужны: интерфейс не меняется. Приёмка: в отчёте строка «скриншотов нет, интерфейс не затронут»
- [x] 5.6 Отчёт перечисляет, что не проверено: сайдкар Istio, переключение primary в CNPG, две реплики в кластере, ответ PostHog на повторное стирание (если не закрыто 3.8)

## 6. Выкат

Раздел не выполнялся в ветке с реализацией: образы, манифесты и кластер трогает человек после проверки. Задачи 6.1–6.5 остаются открытыми.

- [ ] 6.1 Образы `migrate` и `api` из коммита; теги в `k8s/app/db/*-job-migrate-*.yaml` и `k8s/app/api/03-deployment.yaml`; ключи `JOBS_*` в `k8s/app/00-app-config.yaml`. Приёмка: `kubectl diff` показывает только эти правки; число реплик `api` остаётся 1
- [ ] 6.2 Миграции первыми (скилл `deploy`): Job применяется и завершается. Приёмка: в журнале Job «applied …» или «up to date», в базе есть схема `pgboss` и `drizzle.__drizzle_migrations` не изменился
- [ ] 6.3 Rollout `api`. Приёмка: `rollout status` готов; в журнале «очередь запущена» и по одной строке о регистрации каждой очереди и расписания; старые таймеры в журнале не появляются
- [ ] 6.4 Проверки после выката, каждая прод-операция — только после явного «да» человека. Приёмка: расписания отрабатывают (по журналу); на тестовом аккаунте удаление ставит задачу стирания и она выполняется через ≈30 с; `jobs.dead-letter` пуст; число соединений с базой в норме
- [ ] 6.5 Откат: `rollout undo`, схема `pgboss` остаётся, поставленные задачи ждут возврата новой версии (`design.md`, «Выкат и откат»). Приёмка: шаги записаны в описании PR выката

## 7. Архив

- [x] 7.1 После выката: `archive add-job-queue --yes`, дельты вливаются в базу (`account-deletion`, `data-retention`, `mood-diary`, `product-analytics`), правка D4 в `add-notifications` сделана. Приёмка: `validate --all --strict` зелёный, change лежит в `openspec/changes/archive/`
