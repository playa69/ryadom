## 1. Клиент

- [x] 1.1 Добавить `micDeniedText(userAgent)` в `app/packages/client-core/src/voice/mic-hint.ts` и использовать в `DialogScreen.tsx` (web) и `DialogPage.tsx` (mobile) вместо постоянной строки. Приёмка: три сценария дельты; остальные тексты и переход на текстовый вид не изменены.

## 2. Проверка

- [x] 2.1 Тест `app/packages/client-core/test/mic-hint.test.ts` на User-Agent из PostHog за 05–10.11. Приёмка: `pnpm --filter @ryadom/client-core test` зелёный.
- [ ] 2.2 После выката сравнить долю `permission_denied` среди говоривших голосом по `$browser` (`voice_problem`). Приёмка: цифры в задаче PROTEUS-280.

## 3. Архив

- [ ] 3.1 После выката архивировать change и проверить `openspec validate --specs --strict`.
