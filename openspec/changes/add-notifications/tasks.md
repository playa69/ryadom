# Tasks: add-notifications

Контракт — `specs/{notifications,mood-reminders,native-app-build,pwa-delivery}/spec.md`. Решения — `design.md` (D1–D12, «Open Questions»). Требование продукта — `REQ-WELL-04` в `docs/spec.md`. Опирается на `mood-diary` (часовой пояс, `mood_checkins`, карточка отметки) — он уже в коде. Подробности каждой задачи — `tasks-details.md`.

Выполнено — ничего: в коде нет уведомлений. Дневник, часовой пояс, источник отметки и ярлык PWA готовы и описаны в базе (`mood-diary`, `app-shell`, `pwa-delivery`).

## 0. Решения, тексты и макеты

- [ ] 0.1 Решения владельца по Open Questions 1–7 в `design.md` (время по умолчанию, Telegram всем или по выбору, серверный push для нативных сборок, утренний пуш, признак «идёт разговор», Web Push в вебе, точность времени локального напоминания). Приёмка: по каждому пункту решение записано в `openspec/changes/add-notifications/design.md`, вопрос помечен «Решено»; при решении 6(б) убраны веб из «Каналов доставки» и дельта `pwa-delivery`, задача 4.3 снята
- [ ] 0.2 Психолог: 5–7 фраз напоминания, вопрос «Напоминать вечером, в 20:00?», «Напоминания на паузе — вернуть?», «Уведомления запрещены в настройках». Приёмка: тексты записаны в `design.md` (D5, D7) и лежат в коде набором фраз
- [ ] 0.3 Макеты в `openspec/changes/add-notifications/mockups/` (HTML и PNG, как в `add-dialog-share-link`), 390 и 1280: строка «Напоминать о настроении» в карточке отметки (включено, выключено, запрещено в системе, на паузе, iPhone без установленной PWA), вопрос «Напоминать вечером, в 20:00?», выбор времени, пуш и сообщение бота. Приёмка: макеты всех состояний лежат в репозитории и показаны владельцу до кода

## 1. Данные и контракты

- [ ] 1.1 Миграция `0012_notifications` (`notification_preferences`, `push_subscriptions`, `notification_deliveries`): `drizzle-kit generate --name notifications` после ребейза на main с `0010_mood_diary` и `0011_self_check`; миграция из черновика `agent/PROTEUS-243-notifications-wip` не берётся (`design.md`, «Порядок слияния и миграции шлюза»). Приёмка: миграция применяется на копии прод-базы и на пустой базе тестов, её `when` в `meta/_journal.json` позже, чем у `0011_self_check`; ограничения проверены тестом схемы `app/packages/core/test`
- [ ] 1.2 Контракты `app/packages/contracts/src/api/notifications.ts` и пути в `paths.ts`. Приёмка: `app/packages/contracts/test/conventions.test.ts` зелёный: в контрактах только `import type`

## 3. Шлюз API

- [ ] 3.1 Настройки и подписки устройств: процессы в `app/packages/core`, маршруты `app/services/api/src/routes/notifications/` за сессией и флагом `NOTIFICATIONS_ENABLED`. Приёмка: `app/services/api/test/notifications.test.ts`: «(API) Значения по умолчанию», «(API) Время вне окна», «(API) Включение снимает паузу», «(API) Подписка идемпотентна», чужие подписки недоступны, «Уведомления выключены на сервере» (`404`)
- [ ] 3.2 Отправка Web Push (VAPID): интеграция `app/packages/core/src/integrations/web-push/`, ключи из окружения, `404` и `410` удаляют подписку, остальные ошибки увеличивают `failures`, в журналах нет endpoint целиком и ключей. Приёмка: тест на заглушке: успех, «(API) Подписка истекла», `500`
- [ ] 3.3 Отправка через бота Telegram: интеграция `app/packages/core/src/integrations/telegram-bot/` (`sendMessage` с кнопкой, открывающей Mini App на экране), `403` удаляет подписку. Приёмка: тест на заглушке Bot API: «(Telegram) Сообщение бота», «(API) Бот заблокирован»
- [ ] 3.4 Минутный планировщик в `app/services/api/src/index.ts` (выборка, вставка записи доставки, отправка, окно, пропуск больше 2 часов, пауза после 7 неоткрытых). Приёмка: тесты с фиктивным временем: «(API) Две реплики», «(API) Сервер лежал», «(API) Ночное время», «(API) Неделя без открытий»
- [ ] 3.5 Вид «напоминание о настроении»: не отправлять при сегодняшней отметке и при открытом разговоре (по решению 0.1, вопрос 5), текст из набора 0.2, ссылка на дневник. Приёмка: сценарии «Уже отметился», «Идёт разговор», «Без счёта дней», «Текст напоминания»
- [ ] 3.6 Выход и удаление аккаунта: выход удаляет подписку устройства; удаление аккаунта (`app/packages/core/src/processes/account-deletion`) и автоматическое стирание анонимных аккаунтов стирают три таблицы до анонимизации. Приёмка: «Выход», «(API) Удаление аккаунта»; `app/packages/core/test/account-deletion.test.ts` дополнен
- [ ] 3.7 Серверные события `notification_sent {kind, channel}` и `notification_paused {kind}`. Приёмка: сценарий «Отправка» из `specs/notifications/spec.md`; тест `sanitize`

## 4. Клиенты по поверхностям

- [ ] 4.1 Клиенты (web, PWA, Mini App, нативные): строка «Напоминать о настроении» с переключателем и временем в карточке отметки, вопрос «Напоминать вечером, в 20:00?», состояния (запрещено в системе, на паузе, iPhone без установленной PWA), источник отметки `reminder` и `telegram` в `PUT /api/diary/checkins/today`, в том числе из очереди без сети (`app/apps/mobile/src/client/lib/diary.ts`, `diary-queue.ts`). Общая логика — `app/packages/client-core/src/notifications.ts`. Приёмка: сценарии «Первый запуск», «Отказ в системе», «Смена времени», «Выключение», «Согласие», «Отказ от напоминаний», «Отметка после пуша», «Отметка после сообщения бота», «(PWA) Из очереди без сети»
- [ ] 4.2 PWA: подписка Web Push и обработчики `push` и `notificationclick` в `app/apps/mobile/src/sw/sw.ts` (комментарий «There is no push handling here» заменить); ссылка `?from=reminder&d=<id>` разбирается в `app/apps/mobile/src/client/lib/nav.ts` и открывает вкладку «Дневник». Приёмка: «(PWA) Web Push», «(PWA) Касание пуша»; ручная проверка в Android Chrome с установленной PWA
- [ ] 4.3 Веб: подписка Web Push и push-only service worker (`app/apps/web/lib/notifications.ts`), без кэширования; если решено 6(б) — снимается. Приёмка: «После согласия на напоминания» из `specs/pwa-delivery/spec.md`; напоминание приходит в Chrome на компьютере, касание открывает `/app/diary`
- [ ] 4.4 Telegram Mini App: право писать (`requestWriteAccess`), подписка `channel=telegram`, запуск с параметром `startapp=diary_<id>` открывает дневник и отправляет `opened`. Приёмка: «(Telegram) Кнопка бота», «Отметка после сообщения бота» на тестовом аккаунте Telegram
- [ ] 4.5 Android и iOS (нативная сборка, новый APK): `@capacitor/local-notifications`, разрешение `POST_NOTIFICATIONS`, ежедневное уведомление на время из настроек (снимается после известной отметки, переставляется при смене времени, снимается при выключении), подписка `channel=native_local`, касание открывает дневник. Приёмка: «(Android) Локальное уведомление» (оба требования), «(Android) Отметка, о которой телефон знает / не знает», «Запрос уведомлений» из `specs/native-app-build/spec.md`
- [ ] 4.6 Старый APK: клиент проверяет `Capacitor.isPluginAvailable('LocalNotifications')`, без плагина строка напоминания скрыта. Приёмка: сценарий «Старый APK» на текущем APK из `/download` с новым пакетом интерфейса
- [ ] 4.7 События клиента `notification_offer_answered`, `notification_permission_result`, `notification_setting_changed`, `notification_opened` в `app/packages/analytics/src/events.ts` и `docs/analytics.md`. Приёмка: компиляция проверяет свойства, тест `sanitize` в `app/packages/analytics/test`, ни одно событие не несёт текст уведомления или настроение

## 5. Проверка

Скриншоты — скилл `screenshots`: `pnpm evidence PROTEUS-243 app-notifications web-notifications` из каталога `app`, по снимку на каждый шаг сценария, проекты desktop (1280) и mobile (390), синтетические данные; Android — `adb exec-out screencap` под замком эмулятора.

- [ ] 5.1 Сервер и планировщик: `app/services/api/test/notifications.test.ts`, `app/packages/core/test/notifications.test.ts` — все сценарии с пометкой (API) и «Уведомления выключены на сервере», «Отправка», «Выход», «Удаление аккаунта»; в тестах комментарий `openspec/changes/add-notifications`, «<требование>». Приёмка: зелёные
- [ ] 5.2 Клиентская логика: `app/packages/client-core/test` (вопрос, состояния строки, разбор ссылок), `app/apps/mobile/test/nav.test.ts` (ссылка из уведомления). Приёмка: зелёные
- [ ] 5.3 e2e: новые `app/e2e/tests/app-notifications.spec.ts` (mobile) и `web-notifications.spec.ts` (desktop), Playwright `context.grantPermissions(['notifications'])`, заглушка push-сервиса на стенде: «Первый запуск» (на первом экране запроса нет), «Согласие» (создаётся подписка), «Отказ от напоминаний», «Смена времени», «(PWA) Касание пуша», «Идёт разговор», «Уже отметился»; шаги `step(...)` и снимки 390 и 1280. Приёмка: зелёные, весь e2e-набор зелёный на desktop и mobile
- [ ] 5.4 Ручные проверки: Android 13+ (запроса при запуске нет, уведомление приходит в заданное время и не приходит после отметки на этом телефоне), Telegram (сообщение бота и кнопка), iOS — когда выпускается сборка, Chrome на компьютере (веб, если 4.3). Приёмка: снимки и заметка приложены к задаче
- [ ] 5.5 Проверка после выката: `k8s/postdeploy/test_features.py`, тест `test_notification_settings_roundtrip` (настройки, подписка, удаление) на тестовом аккаунте. Приёмка: `--expect post` проходит

## 6. Выкат

Выкат на кластер — только после отдельного одобрения владельца с указанием окружения.

- [ ] 6.1 Ключи VAPID (один раз, в Secret `app-secrets`: `WEB_PUSH_PUBLIC_KEY`, `WEB_PUSH_PRIVATE_KEY`, `WEB_PUSH_SUBJECT`), `NOTIFICATIONS_ENABLED` в `k8s/app/00-app-config.yaml`, миграция `0012_notifications` после `0011_self_check`, образы api, web, pwa. Приёмка: протокол проверки в комментарии к задаче: напоминание в PWA и в Telegram в выбранное время, не приходит после отметки, касание открывает дневник; тестовый аккаунт удалён
- [ ] 6.2 Новая сборка APK с плагином (`native-app-build`) — отдельно, когда готовы 4.5 и 4.6. Приёмка: установка поверх прежней, уведомление приходит

## 7. Архив

- [ ] 7.1 Статус `REQ-WELL-04` и трассировка в `docs/spec.md`; в сценарии А отмечено, что канал есть в PWA, вебе (если 4.3) и Telegram, а в нативных сборках — только локальные (серверного push нет, Open Questions 3). Приёмка: `docs/spec.md` соответствует коду
- [ ] 7.2 `openspec archive add-notifications` после выката; перепроверить чек-лист из `design.md` («Что тронет базу при архивации»). Приёмка: `openspec validate --specs --strict` зелёный
