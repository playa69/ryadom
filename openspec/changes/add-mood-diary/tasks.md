# Tasks: add-mood-diary

Контракт — `specs/{mood-widget,mood-diary,data-retention}/spec.md`. Решения — `design.md` (D10, D14 и «Open Questions»). Требования продукта — `REQ-WELL-05`, `REQ-WELL-10` в `docs/spec.md`. Подробности каждой задачи — `tasks-details.md`.

Выполнено — см. capability `mood-diary`, `dialog-recaps`, `dialog-history`, `data-retention`, `app-shell`, `pwa-delivery` в `openspec/specs/` (миграция `0010_mood_diary`, отметки и очередь без сети, график, итоги недели, фоновый проход, итоги разговоров и лист завершения, журнал внутри «Дневника», вкладки и сайдбар, ярлык PWA, токен виджета в API, срок хранения 21 день, аналитика дневника, e2e и мок агента). Напоминание о настроении — `add-notifications`, поиск по итогам — `add-recap-search`, тесты в мобильном клиенте — `add-self-check-tests`.

## 0. Решения и макеты

- [ ] 0.1 Решения владельца по Open Questions 4–8 в `design.md` (виджет iOS, «Послушать», привязка токена к сеансу, повторная выдача токена, постоянство и текст предупреждения о сроке). Приёмка: по каждому пункту решение записано в `openspec/changes/add-mood-diary/design.md`, вопрос помечен «Решено»
- [ ] 0.2 Макеты виджета и строк: `openspec/changes/add-mood-diary/mockups/` (HTML и PNG, как в `add-dialog-share-link`). Состояния: виджет 4×1 обычный, с выбранным уровнем, «Войди в Рядом»; превью виджета в списке виджетов; строка «Виджет на главный экран» (Android) и «Быстрая отметка» (PWA) в сегменте «Дневник»; пояснение о сроке в журнале (обычный человек и гость), 390 и 1280. Приёмка: макеты всех состояний лежат в репозитории и показаны владельцу до кода
- [ ] 0.3 Психолог: строки моста к разговору и промпт итогов недели (тексты уже в коде). Приёмка: утверждение записано в `design.md` (D3, D6); правки текстов — отдельным коммитом с тестами агента `agent/tests/test_digests.py`

## 3. Шлюз API

- [ ] 3.1 Отзыв токена виджета при `POST /api/auth/logout-all` (`app/services/api/src/routes/auth/sessions.ts`, `sessions.endAll`), смене пароля (`app/packages/core/src/processes/change-password`) и блокировке (`app/packages/core/src/processes/user-management/toggle-user-activation`): вызвать `RevokeWidgetTokensCommand` (сейчас её зовёт только `DELETE /api/diary/widget-token`). «Завершить» одной сессии токен не трогает (`design.md`, D10). Приёмка: сценарии «(API) Выход на всех устройствах», «(API) Смена пароля», «(API) Блокировка» из `specs/mood-diary/spec.md`

## 4. Клиенты по поверхностям

- [ ] 4.1 Android: виджет «Чек-ин настроения» 4×1 (`app/apps/mobile/android/app/src/main/java/…/widget/`): провайдер, пять лиц, строка «Повлияло: …», отметка по `PUT /api/diary/widget/checkin`, очередь WorkManager с датой своего дня, обновление раз в 30 минут по `GET /api/diary/widget/today`, состояние «Войди в Рядом» при `401`, превью из макета 0.2. Нативное изменение: нужна новая сборка APK. Приёмка: сценарии «(Android) Отметка с экрана телефона», «Фактор из приложения», «Фактор не выбран», «Без сети», «Отметка с другого устройства», «Токен отозван» из `specs/mood-widget/spec.md`
- [ ] 4.2 Android: плагин Capacitor «закрепить виджет» (`AppWidgetManager.requestPinAppWidget`), получение токена `POST /api/diary/widget-token`, хранение токена в зашифрованных настройках, инструкция для лаунчера без закрепления, событие `widget_pin_requested {result}` в `app/packages/analytics/src/events.ts` (без значений настроения). Приёмка: сценарии «(Android) Закрепление» и «(Android) Лаунчер без закрепления»; тест `sanitize` в `app/packages/analytics/test`
- [ ] 4.3 Мобильный клиент: строка «Виджет на главный экран» (Android) и «Быстрая отметка: удерживай значок Рядом» (установленная PWA) в сегменте «Дневник» (`app/apps/mobile/src/client/components/pages/diary/DiaryPage.tsx`); без плагина (старый APK) и в вебе, Mini App, iOS строки нет. Приёмка: сценарии «(PWA) Подсказка про ярлык» и «(Android) Старая сборка» из `specs/mood-widget/spec.md`
- [ ] 4.4 Мобильный клиент (Android): выход из аккаунта отзывает токен виджета до выхода и стирает его на устройстве (без сети — только на устройстве). Приёмка: сценарии «(Android) Выход» и «(Android) Выход без сети» из `specs/mood-widget/spec.md`, «(Android) Выход из приложения» из `specs/mood-diary/spec.md`
- [ ] 4.5 Клиенты (web, PWA, Android, iOS, Telegram): пояснение «Разговоры старше 21 дня удаляются. Итоги недели и заметки остаются.» под непустым списком журнала (`app/apps/web/app/(app)/diary/journal/`, `app/apps/mobile/src/client/components/pages/journal/`), рядом с пояснением гостя о 90 днях, а не вместо него. Приёмка: сценарии «Журнал с разговорами», «Пустой журнал», «Гость» из `specs/data-retention/spec.md`

## 5. Проверка

Скриншоты — скилл `screenshots`: `pnpm evidence PROTEUS-183 <спеки>` из каталога `app`, по снимку на каждый шаг, проекты desktop (1280) и mobile (390), синтетические данные; Android — `adb exec-out screencap` под замком эмулятора.

- [ ] 5.1 Токен виджета в API. Тест: `app/services/api/test/diary.test.ts` («Выход на всех устройствах», «Смена пароля», «Блокировка», плюс прежние «Токен не открывает остального», «Новый токен») с комментарием `openspec/changes/add-mood-diary`, «Токен виджета в API»; `app/packages/core/test/diary.test.ts` для отзыва командой. Проверка после выката: `k8s/postdeploy/test_features.py`, тест `test_widget_token_is_revoked_by_logout_all` на тестовом аккаунте. Приёмка: тесты зелёные, проверка `--expect post` проходит
- [ ] 5.2 Виджет и подсказка. e2e: `app/e2e/tests/app-diary.spec.ts`, проект mobile — «(PWA) Подсказка про ярлык» (режим `standalone` подменяется init-скриптом) и «(Android) Старая сборка» (нет плагина — нет строки), шаги `step(...)` и снимки 390 и 1280. Ручные проверки Android (эмулятор, Android 13+ и лаунчер без закрепления): все сценарии `specs/mood-widget/spec.md`, снимки `adb screencap` по шагам. Приёмка: e2e зелёный на mobile, Android-снимки приложены к задаче
- [ ] 5.3 Пояснение о сроке. e2e: `app/e2e/tests/web-history.spec.ts` (desktop) и `app/e2e/tests/app-recaps.spec.ts` (mobile) — «Журнал с разговорами», «Пустой журнал»; `app/e2e/tests/web-anonymous.spec.ts` и `app/e2e/tests/app-anonymous.spec.ts` — «Гость»; снимки 390 и 1280. Приёмка: весь e2e-набор зелёный на desktop и mobile

## 6. Выкат

Выкат на кластер — только после отдельного одобрения владельца с указанием окружения.

- [ ] 6.1 Клиенты с пояснением о сроке (web, pwa) выкачены не меньше чем за 7 суток до выката агента из `main-cleanup`, с которого начинается настоящая чистка; перед выкатом агента — копия базы агента (`design.md`, D14). Приёмка: порядок и даты записаны в комментарии к задаче; после выката растёт `agent_dialogs_retention_deleted_total`
- [ ] 6.2 API с отзывом токена виджета и клиенты; новая сборка APK с виджетом — отдельно (`native-app-build`). Приёмка: протокол проверки в комментарии к задаче: тестовый аккаунт (потом удалить) выдаёт токен, `logout-all` его отзывает; виджет на устройстве: отметка проходит и видна в вебе

## 7. Архив

- [ ] 7.1 Статусы `REQ-WELL-01`…`REQ-WELL-05` и `REQ-WELL-10` в `docs/spec.md` по коду; трассировка (§14). Приёмка: `docs/spec.md` соответствует коду
- [ ] 7.2 `openspec archive add-mood-diary` после выката: MODIFIED вливает «Токен виджета в API» и «Срок хранения разговоров» в базу целиком. Приёмка: `openspec validate --specs --strict` зелёный, `git diff openspec/specs` ничего нужного не теряет
