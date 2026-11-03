# Tasks: rename-android-package

## 0. Решения

- [x] 0.1 Пакет Android — `ru.ryadom.companion`, как у приложения в RuStore; iOS пока не меняется. Приёмка: решение
  владельца (03.11.2026) записано в `proposal.md`

## 4. Клиенты: Android

- [x] 4.1 `applicationId` `ru.ryadom.companion` в `app/apps/mobile/android/app/build.gradle` (dev — суффикс `.dev`),
  `appId` в `app/apps/mobile/capacitor.config.ts`, `package_name` и `custom_url_scheme` в
  `app/apps/mobile/android/app/src/main/res/values/strings.xml`; `namespace` и Java-пакет без изменений. Приёмка:
  сценарии «Боевая сборка Android» и «Dev-сборка рядом с боевой»
- [x] 4.2 `pnpm android:dev` запускает `ru.ryadom.companion.dev/ru.ryadom.app.MainActivity`
  (`app/apps/mobile/scripts/android.mjs`). Приёмка: сценарий «Локальная dev-сборка Android»

## 5. Проверка

- [x] 5.1 Пакет в собранных APK: `aapt2 dump badging` для `app-dev-debug.apk` и `app-prod-release-unsigned.apk`.
  Приёмка: `ru.ryadom.companion.dev` и `ru.ryadom.companion`
- [x] 5.2 `node .agents/skills/release-check/scripts/release-check.mjs`. Приёмка: код выхода 0, вывод — в PR
- [x] 5.3 Ручная проверка: dev-сборка ставится на эмулятор и запускается командой из 4.2. Приёмка: приложение
  открывается

## 7. Архив

- [x] 7.1 В этой ветке до слияния — `openspec archive rename-android-package --yes`, папка change'а удалена.
  Приёмка: `openspec/specs/native-app-build/spec.md` содержит `ru.ryadom.companion`
