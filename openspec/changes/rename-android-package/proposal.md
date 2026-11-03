# Proposal: rename-android-package

## Why

Приложение в RuStore заведено с пакетом `ru.ryadom.companion`, а пакет приложения RuStore поменять не даёт. Сборки из
репозитория выходят с `ru.ryadom.app`: RuStore их в это приложение не примет, а тестовый пуш-проект RuStore заведён на
`ru.ryadom.companion.dev`. Опубликованных сборок ещё нет, поэтому сменить идентификатор Android можно сейчас без
потерь.

## What Changes

- Android: `applicationId` — `ru.ryadom.companion`, у варианта `dev` — `ru.ryadom.companion.dev`; `appId` Capacitor —
  `ru.ryadom.companion`.
- Java-пакет Android (`namespace`, `MainActivity`) остаётся `ru.ryadom.app`: в Android он не связан с идентификатором
  приложения, переносить код незачем.
- `pnpm android:dev` запускает `ru.ryadom.companion.dev/ru.ryadom.app.MainActivity`.
- iOS не меняется: `PRODUCT_BUNDLE_IDENTIFIER` остаётся `ru.ryadom.app` до решения по App Store.
- Правило «идентификатор не меняется после первой публикации в магазине» остаётся; первой публикацией станет сборка с
  новым пакетом.

## Capabilities

### New Capabilities

### Modified Capabilities

- `native-app-build`: идентификатор Android-приложения и команда запуска dev-сборки.

## Поверхности

android

## Вне рамок

- Идентификатор iOS.
- Публикация в RuStore и замена ключа подписи у RuStore.

## Impact

- Код: `app/apps/mobile/android/app/build.gradle`, `app/apps/mobile/capacitor.config.ts`,
  `app/apps/mobile/android/app/src/main/res/values/strings.xml`, `app/apps/mobile/scripts/android.mjs`.
- Контракт API не меняется. Нужна новая нативная сборка: она и станет первой для RuStore.
- Тестовые сборки `ru.ryadom.app` и `ru.ryadom.app.dev` на телефонах команды после смены — отдельное приложение: их
  удаляют и ставят новые.
