## 4. Клиенты

- [x] 4.1 Лендинг не отправляет `open_app`; экраны разговора веба и PWA не отправляют `first_dialog_3_replies`; обеих нет в каталоге `MetrikaGoal` (`app/apps/landing/app/_components/tracked.tsx`, `app/apps/web/components/DialogScreen.tsx`, `app/apps/mobile/src/client/components/pages/dialog/DialogPage.tsx`, `app/packages/analytics/src`).
  Приёмка: `app/packages/analytics/test/metrika.test.ts` — каталог целей `first_reply`, `polz_3`, `dau_10`.

## 6. Выкат

- [x] 6.1 Кабинет Метрики: цели 681200816, 681247741 и 678454825 удалены, осталось четыре.
- [ ] 6.2 Образы web, pwa, landing с этим кодом.

## 7. Архив

- [ ] 7.1 `archive remove-extra-metrika-goals --yes` после выката.
