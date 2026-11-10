## 0. Решения

- [ ] 0.1 Подтвердить: окно строится поверх PR #112 (`mic-hint.ts`), поэтому ветка реализации берётся после его слияния или стеком на нём. Приёмка: ответ владельца в PROTEUS-284.
- [ ] 0.2 Подтвердить тексты шагов и фразу перед запросом («Микрофон нужен, чтобы слышать тебя. Сейчас браузер спросит разрешение.»). Приёмка: «да» владельца.

## 1. Данные и контракты

- [ ] 1.1 `app/packages/client-core/src/voice/capture.ts`: `MicrophoneDeniedError` получает поле `cause` из закрытого списка (`not_allowed`, `not_found`, `not_readable`, `security`, `other`) по `error.name` из `getUserMedia`. Приёмка: тест в `app/packages/client-core/test/capture.test.ts` на каждое имя.
- [ ] 1.2 `app/packages/analytics` и `docs/analytics.md`: `voice_problem` получает свойство `detail` из того же списка; тексты ошибок не уходят. Приёмка: тест в `app/packages/analytics/test`; `app/apps/web/lib/analytics.ts` и `app/apps/mobile/src/client/lib/analytics.ts` передают `detail`; прежние `reason` не меняются (`no_microphone` — при `not_found`).

## 4. Клиенты по поверхностям

- [ ] 4.1 `app/packages/client-core/src/voice/`: общий модуль `mic-permission.ts` — `queryMicPermission()` (`navigator.permissions.query`, `null` где не поддерживается, в том числе Safari) и `micGuide(userAgent, standalone)` — платформа и шаги инструкции (расширяет `mic-hint.ts` из #112). Приёмка: unit-тесты на User-Agent из PostHog за 05–10.11.
- [ ] 4.2 Web `app/apps/web/components/DialogScreen.tsx`: фраза перед первым запросом, окно с инструкцией («Попробовать снова», «Писать текстом»), `denied` без вызова `getUserMedia`, `granted` → «Продолжить». Приёмка: сценарии дельты (кроме иного сбоя) на web.
- [ ] 4.3 Mobile/PWA/Android/iOS/TG `app/apps/mobile/src/client/components/pages/dialog/DialogPage.tsx`: то же окно на Framework7. Приёмка: те же сценарии на mobile.
- [ ] 4.4 Автостарт с главного экрана остаётся без окна (текстовый вид + уведомление). Приёмка: сценарий «Микрофон не разрешён».

## 5. Проверка

- [ ] 5.1 e2e `app/e2e` (desktop, mobile): с подменой `getUserMedia` (`NotAllowedError`, `NotFoundError`) и `permissions.query` (`denied` → `granted`); комментарий с `openspec/changes/add-mic-permission-guide`, «Микрофон или голос недоступны». Приёмка: сценарии «Окно с инструкцией», «Попробовать снова», «Отказ запомнен браузером», «Иной сбой».
- [ ] 5.2 Скриншоты (скилл `screenshots`) 390 и 1280: фраза перед запросом, окно для Chrome/Android, Safari/iOS, встроенного окна, PWA; синтетические данные.
- [ ] 5.3 `release-check`: контракт API не меняется, свойство события необязательное. Приёмка: отчёт в PR.

## 6. Выкат

- [ ] 6.1 После выката: доля отказавших, сказавших реплику голосом (HogQL по `voice_problem` и репликам), и разбивка по `detail`. Приёмка: цифры в PROTEUS-284 (было 2 из 31).

## 7. Архив

- [ ] 7.1 Архивировать после выката и #112; `validate --specs --strict`. Приёмка: зелёный.
