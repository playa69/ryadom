## 0. Решения

- [x] 0.1 Аккаунты, созданные до выката, считаются уже сказавшими первую реплику (не повторять `first_reply` вернувшимся). Цель «Клик по кнопке» (681200816) переводится на JS-событие `open_app` с тем же ID, новых целей в кабинете нет. В e2e цели не покрываются (решение владельца): только поправлены ожидания двух прежних сценариев.
  Приёмка: записано в proposal и `docs/analytics.md`.

## 1. Данные и контракты

- [x] 1.1 Таблица `user_reply_counts` и миграция `0014` с отметкой существующих аккаунтов (`app/packages/db/src/schema/user-reply-counts.ts`, `app/packages/db/migrations/0014_user_reply_counts.sql`).
  Приёмка: миграция создаёт таблицу и строку `replies = 0` на каждый неудалённый аккаунт.
- [x] 1.2 Счёт реплики (команда) и его чтение (запрос): сутки по Москве, признак первой (`app/packages/core/src/managers/reply-counts-manager`). Два шага без транзакции — решение владельца «проще, пусть не 100 %»: одновременные реплики с двух устройств могут потерять цель.
  Приёмка: `app/packages/core/test/reply-counts.test.ts` — первая, сутки по Москве, старый аккаунт, чужой аккаунт.
- [x] 1.3 Кадр `reply_count { today, first }` (`app/packages/contracts/src/api/dialogs.ts`).
  Приёмка: typecheck; старый клиент кадр пропускает (`default` в разборе кадров).

## 3. Шлюз API

- [x] 3.1 После каждой принятой реплики (той же, что `dialog_turn`) шлюз считает её и шлёт `reply_count`; сбой счёта не трогает разговор (`app/services/api/src/dialogs/gateway.ts`, `app/services/api/src/lib/reply-counts.ts`, `app/services/api/src/index.ts`).
  Приёмка: `app/services/api/test/dialogs.test.ts` — текст, голос, пустая расшифровка, второе устройство и разговор.

## 4. Клиенты

- [x] 4.1 `DialogSocket.onReplyCount` (`app/packages/client-core/src/dialog-socket.ts`).
  Приёмка: `app/packages/client-core/test/dialog-socket.test.ts`.
- [x] 4.2 Цели `first_reply`, `polz_3`, `dau_10` по счёту сервера; `first_reply` больше не по разговору (`app/packages/analytics/src/metrika.ts`, `events.ts`); экраны разговора веба и PWA (`app/apps/web/components/DialogScreen.tsx`, `app/apps/mobile/src/client/components/pages/dialog/DialogPage.tsx`).
  Приёмка: `app/packages/analytics/test/metrika.test.ts`.
- [x] 4.3 `open_app` со всех кнопок открытия веб-приложения на лендинге (`app/apps/landing/app/_components/tracked.tsx`).
  Приёмка: ручная проверка на проде (раздел 6).
- [x] 4.4 `yclid` и метки кампании в адресе хита Метрики, в PWA — из адреса запуска (`app/packages/analytics/src/sanitize.ts`, `browser.ts`).
  Приёмка: `app/packages/analytics/test/metrika.test.ts` — Директ и PWA с метками.

## 5. Проверка

- [x] 5.1 Typecheck и юнит-тесты затронутых пакетов, весь набор юнит-тестов.
- [x] 5.2 `release-check` (контракт и шлюз): нарушений нет, нативная сборка не нужна; `REVIEW` по новому кадру — старые клиенты незнакомый кадр пропускают (`default` в разборе).

## 6. Выкат

- [ ] 6.1 Миграция `0014`, образы api, web, pwa, landing.
- [ ] 6.2 Кабинет: цель 681200816 — JS-событие `open_app`.
- [ ] 6.3 Проверка на проде отдельным аккаунтом по таблице ТЗ: `open_app`, `first_reply`, `polz_3` на третьей, ничего с 4-й по 9-ю, `dau_10` на десятой, ничего после; следующие сутки — по счёту юнит-теста (ждать полуночи не нужно).

## 7. Архив

- [ ] 7.1 `archive add-metrika-daily-goals --yes` после выката.
