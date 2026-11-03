# Tasks: align-analytics-screen-url

Контракт — `specs/product-analytics/spec.md`. Задача — PROTEUS-267 (доработка).

## 4. Клиенты по поверхностям

- [x] 4.1 `app/packages/analytics/src/browser.ts` (`trackPageview`): адрес показа экрана в PostHog — настоящий (`$current_url`, `$host`, `$pathname`): без `pageBase` — адрес страницы без query и фрагмента (у веба с `/app`); с `pageBase` и не в оболочке магазина — `pageBase` + маршрут (PWA и Telegram с `/pwa`); в оболочке магазина — как было. Приёмка: сценарии «(Веб) Адрес экрана», «(PWA) Адрес экрана», «(Android) Адрес экрана в оболочке» в `app/packages/analytics/test/browser.test.ts`

## 5. Проверка

- [x] 5.1 Юнит-тесты пакета и весь набор (`pnpm test`), typecheck. Приёмка: зелёные
- [ ] 5.2 Проверка на боевом сайте после выката: `$pageview` из веба и PWA несут адреса с `/app` и `/pwa` (запрос к PostHog по `analytics`). Приёмка: заметка в задаче Multica

## 6. Выкат

- [ ] 6.1 Образы web и pwa (patch-версии); только после «да» владельца. Приёмка: digest подов совпадает с отправленными

## 7. Архив

- [x] 7.1 `docs/analytics.md`: раздел про адрес экрана. Приёмка: документ соответствует коду
