# Tasks: add-push-notifications

## 1. Данные и контракты

- [x] 1.1 Таблица `push_subscriptions` (`app/packages/db/src/schema/push-subscriptions.ts`, каналы в
  `schema/types.ts`), миграция `0013_push_subscriptions` через `pnpm --filter @ryadom/db generate --name push_subscriptions`.
  Приёмка: миграция применяется на чистой базе и поверх `0012`; уникальность `(channel, token)`, `on delete cascade` к `users`.
- [x] 1.2 Действие журнала `USER_NOTIFICATION_SENT` (`AUDIT_LOG_ACTIONS` в `schema/types.ts`).
  Приёмка: typecheck админки требует подпись и тон действия.
- [x] 1.3 Контракт `app/packages/contracts/src/api/notifications.ts` (`PushChannel`, запрос и ответ подписки, коды
  ошибок) и `ApiPath.NotificationSubscriptions`, `notificationSubscriptionPath(id)`.
  Приёмка: клиенты и api берут типы отсюда.
- [x] 1.4 Переменные `RUSTORE_PUSH_API_URL` и `RUSTORE_PUSH_SERVICE_TOKENS` в базовой схеме
  (`app/packages/core/src/config/env.ts`), строки в `.env.example` api и админки.
  Приёмка: неверный формат списка токенов роняет старт со списком ошибок; пустая строка — «не задано».

## 3. Ядро и шлюз API

- [x] 3.1 Менеджер `app/packages/core/src/managers/push-subscriptions-manager`: подписать (upsert по токену),
  снять свою, список подписок открытых сессий человека, удалить подписку, удалить все подписки человека, удалить
  подписки завершённых сессий.
  Приёмка: тесты `app/packages/core/test/notifications.test.ts`.
- [x] 3.2 Интеграция `app/packages/core/src/integrations/rustore-push`: `SendRuStorePushRequest` (таймаут 10 с, TTL
  сутки), код `TOKEN_NOT_FOUND` на `404`, остальные отказы — `throw`.
  Приёмка: тело запроса и заголовок `Authorization` проверены в тесте через `mockFetch`.
- [x] 3.3 Процесс `app/packages/core/src/processes/notifications`: `SubscribeDeviceOperation`,
  `UnsubscribeDeviceOperation`, `SendUserNotificationOperation` (длины, удаление по `TOKEN_NOT_FOUND`, проект без
  токена — неотправлено, журнал).
  Приёмка: тесты на два устройства, устаревший токен, завершённую сессию, нет подписок, длину текста, журнал.
- [x] 3.4 Стирание подписок в `processes/account-deletion/shared/erase-account.ts`; чистка подписок завершённых
  сессий в `services/api/src/jobs/purge-sessions.ts`.
  Приёмка: тест удаления аккаунта видит пустую таблицу подписок; тест чистки.
- [x] 3.5 Маршруты `app/services/api/src/routes/notifications.ts`: `POST /api/notifications/subscriptions`,
  `DELETE /api/notifications/subscriptions/:id` (открытая сессия обязательна).
  Приёмка: `app/services/api/test/notifications.test.ts` — повторная подписка, другой аккаунт, чужая подписка `404`,
  неверный канал `400`, без сессии `401`.

## 4. Клиенты

### Админка

- [x] 4.1 Блок «Уведомления» в `app/apps/admin/app/(dashboard)/users/[id]` (список устройств, форма, действие
  `sendNotification` в `actions.ts`), подпись и тон действия в `_lib/labels.ts`, ключи подробностей журнала.
  Приёмка: сценарии «Уведомление человеку из карточки» в e2e (5.2).

### Android

- [x] 4.2 SDK и манифест: репозиторий RuStore в `android/build.gradle`, `ru.rustore.sdk:pushclient:7.5.0` и
  `manifestPlaceholders` с ID пуш-проекта по варианту в `android/app/build.gradle`, `POST_NOTIFICATIONS`,
  сервис-наследник `RuStoreMessagingService`, `meta-data` проекта, канала и значка в `AndroidManifest.xml`,
  `res/drawable/ic_notification.xml`.
  Приёмка: `assembleDevDebug` проходит, в манифесте APK `POST_NOTIFICATIONS` и `project_id` варианта.
- [x] 4.3 Плагин `RuStorePush` (`android/app/src/main/java/ru/ryadom/app/RuStorePushPlugin.java`,
  `RuStorePushService.java`, регистрация в `MainActivity`): методы и события из design, D1.
  Приёмка: ручная проверка 5.4.
- [x] 4.4 JS: `app/apps/mobile/src/client/lib/push.ts` (обёртка плагина, включение, повторная подписка при запуске и
  входе, `tokenChanged`, выключение, касание), переключатель «Уведомления» в `ProfilePage.tsx`, отвязка в выходе
  (`lib/store.tsx`), обработка касания в `F7App.tsx`.
  Приёмка: typecheck и тесты mobile; без плагина переключателя нет (тест `app/apps/mobile/test`).

### Консоль RuStore

- [x] 4.5 Пуш-проекты «Тест» (`ru.ryadom.companion.dev`, `CD:53…`) и «Production» (`ru.ryadom.companion`,
  `A8:0C…`); ID — в `android/app/build.gradle`, сервисные токены — хранятся локально у администратора.
  Приёмка: оба проекта в разделе «Push-уведомления» консоли.
  Сделано 04.11: оба проекта созданы, ID в сборке, токены обоих проектов созданы и хранятся локально у администратора.

## 5. Проверка

- [x] 5.1 Unit и integration: `app/packages/core/test/notifications.test.ts` (сценарии «Подписка устройства»,
  «Доставка через RuStore Push», «Уведомления только открытым сессиям», «Ничего лишнего в уведомлении»),
  `app/packages/core/test/account-erasure.test.ts` («Что стирается в приложении»),
  `app/services/api/test/notifications.test.ts`.
- [x] 5.2 E2E `app/e2e/tests/admin-notifications.spec.ts`, проект desktop: админка в стенде e2e (`e2e/scripts/stack.mjs`)
  и заглушка RuStore Push (`app/dev/push-mock`); сценарии «Отправка на телефон», «Нет устройств», «Токен устарел»,
  «Пустой текст», «Уведомление в журнале», «Сессии завершены администратором».
- [x] 5.3 Скриншоты админки: блок «Уведомления» до и после отправки, ошибка поля, журнал — 1280 (`e2e/screenshots/desktop/admin-notifications__*`).
  390 не снимается: админка рассчитана на рабочее место (`admin-console`, «Каркас админки»).
- [x] 5.4 Ручная проверка Android (devDebug, подпись `CD:53…`, проект «Тест», эмулятор или телефон с RuStore): первый
  запуск без запроса, включение и системный запрос, отказ, уведомление от админки локального стенда в свёрнутом и
  открытом приложении, касание при холодном старте, выключение, выход; скриншоты adb.
  Сделано 04.11 на эмуляторе (Android 16, RuStore 1.113): запуск без запроса, SDK инициализирован проектом «Тест»,
  включение → системный запрос → токен RuStore → подписка на стенде; отказ → «Уведомления запрещены…» и «Открыть
  настройки»; выход удаляет подписку и токен; касание со ссылкой — до входа (событие дожидается входа) и в открытом
  приложении. Доставка с админки стенда через настоящий RuStore Push (проект «Тест»): в свёрнутое приложение — в шторке
  с заголовком и текстом (около 1,5 минуты, пока RuStore не разрешили работу в фоне), в открытое — за 2 с, значок в
  строке состояния; касание открывает приложение. Экран блокировки не снят: на эмуляторе нет блокировки.
- [x] 5.5 `node .agents/skills/release-check/scripts/release-check.mjs`: код выхода 0, вывод — в PR.

## 6. Выкат

- [ ] 6.1 `RUSTORE_PUSH_SERVICE_TOKENS` в Secret `app-secrets` (api и админка), миграция, образы api, admin, pwa.
- [ ] 6.2 Нативная сборка 1.0.1 (versionCode 3) в Codemagic, публикация в RuStore; уведомление на production-сборку.

## 7. Архив

- [ ] 7.1 `openspec archive add-push-notifications --yes`, папку `archive/` удалить, `validate --specs --strict`.
