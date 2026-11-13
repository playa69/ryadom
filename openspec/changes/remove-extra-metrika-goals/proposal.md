Задача: PROTEUS-267

## Why

В ТЗ маркетинга четыре цели, а в кабинете их было шесть. Владелец решил оставить цели ТЗ, кроме клика, и «Переход в продукт»:
- «Клик по кнопке „Открыть приложение“» почти повторяет «Переход в продукт». Кнопочная цель кабинета узнавала одну кнопку из четырёх, а её замена на JS-событие `open_app` (change `add-metrika-daily-goals`) добавляла только разницу между нажатием и загрузкой приложения.
- «Основная цель: первый разговор с 3+ репликами» (`first_dialog_3_replies`, заведена 03.11) в ТЗ нет; её заменяет `polz_3`.

## What Changes

- Лендинг больше не отправляет в Метрику `open_app`, клиенты разговора — `first_dialog_3_replies`.
- В кабинете остаются четыре цели: `first_reply`, `polz_3`, `dau_10` и «Переход в продукт» (удалены 681200816, 681247741 и 678454825 — 13.11.2026).

## Capabilities

### New Capabilities

Нет.

### Modified Capabilities

- `product-analytics`: «Цели Метрики» — без `open_app` и `first_dialog_3_replies`.

## Impact

- `app/apps/landing`, `app/apps/web`, `app/apps/mobile` (экраны разговора), `app/packages/analytics`, `docs/analytics.md`.
- Образы web, pwa, landing.
