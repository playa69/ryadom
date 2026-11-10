## 0. Решения

- [ ] 0.1 Подтвердить порядок с PR #112 (PROTEUS-280): то же требование «Микрофон или голос недоступны», кто архивируется вторым, переносит блок на обновлённую спеку. Приёмка: ответ владельца в PROTEUS-284.
- [ ] 0.2 Подтвердить тексты шагов инструкции и сообщений. Приёмка: «да» владельца.

## 1. Данные и контракты

- [x] 1.1 `app/packages/client-core/src/voice/capture.ts`: `MicrophoneError` с полем `detail`, `MicrophoneDeniedError` только для отказа. Приёмка: `app/packages/client-core/test/capture.test.ts` на каждое имя ошибки.
- [x] 1.2 `app/packages/analytics/src/events.ts`: `voice_problem` получает необязательное `detail`; web и mobile передают его. Приёмка: `app/apps/web/lib/analytics.test.ts`, `app/apps/mobile/test/analytics.test.ts`; прежние `reason` не меняются.

## 4. Клиенты по поверхностям

- [x] 4.1 `app/packages/client-core/src/voice/mic-guide.ts` и `mic-permission.ts`: платформа и шаги, проверка и наблюдение за разрешением без запроса. Приёмка: `app/packages/client-core/test/mic-guide.test.ts`.
- [x] 4.2 Web `app/apps/web/components/DialogScreen.tsx`, `MicGuideSheet.tsx`: запрос сразу, окно только после отказа, `denied` без вызова `getUserMedia`, `granted` → «Продолжить», «Попробовать снова» с пометкой «по-прежнему выключен». Приёмка: `app/e2e/tests/web-mic-journeys.spec.ts`.
- [x] 4.3 PWA/Android/iOS/TG `app/apps/mobile/src/client/components/pages/dialog/DialogPage.tsx`, `MicGuideSheet.tsx`: то же на Framework7. Приёмка: `app/e2e/tests/app-mic-journeys.spec.ts`.
- [x] 4.4 Автостарт с главного экрана остаётся без окна (текстовый вид + уведомление). Приёмка: пути 2 и 3 в обоих спеках.

## 5. Проверка

- [x] 5.1 e2e web (desktop, mobile) и PWA: путь «разрешили», «отказали в запросе», «отказ запомнен → включили в настройках», «нет устройства / занят / небезопасный адрес / иной сбой», «браузер не умеет спросить о разрешении». Приёмка: `pnpm evidence` зелёный.
- [x] 5.2 Окна по местам открытия (Chrome/Android, Safari/iPhone, Яндекс Браузер, встроенное окно, PWA). Приёмка: `app/e2e/tests/web-mic-guide.spec.ts`.
- [ ] 5.3 Скриншоты 390 и 1280 для отчёта. Приёмка: снимки в PROTEUS-284.
- [x] 5.4 `release-check`: контракт API не меняется, свойство события необязательное. Приёмка: отчёт в PR.
- [ ] 5.5 Вручную на реальных устройствах: Android Chrome, Safari на iPhone, приложение Яндекса. Приёмка: отметка в PROTEUS-284 (в headless не проверить).

## 6. Выкат

- [ ] 6.1 После выката: доля отказавших, сказавших реплику голосом (HogQL по `voice_problem` и репликам), и разбивка по `detail`. Приёмка: цифры в PROTEUS-284 (было 2 из 31).

## 7. Архив

- [ ] 7.1 Архивировать после выката и #112; `validate --specs --strict`. Приёмка: зелёный.
