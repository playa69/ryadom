## MODIFIED Requirements

### Requirement: Идентификатор и имя приложения
Android-приложение SHALL иметь идентификатор `ru.ryadom.companion`: он же `appId` Capacitor и `applicationId` Android. Java-пакет Android (`namespace`) — `ru.ryadom.app`, он с идентификатором приложения не связан. iOS-приложение SHALL иметь `PRODUCT_BUNDLE_IDENTIFIER` `ru.ryadom.app`. Отображаемое имя — «Рядом» (Android: `app_name` варианта `prod`; iOS: `CFBundleDisplayName`). Вариант `dev` на Android SHALL иметь `applicationId` `ru.ryadom.companion.dev`, суффикс версии `-dev` и имя «Рядом dev», чтобы ставиться рядом с боевым; на iOS отдельного идентификатора для `dev` нет. Идентификатор MUST NOT меняться после первой публикации в магазине.

Поверхности: android · ios

#### Scenario: Боевая сборка Android
- **WHEN** (Android) собирается вариант `prod`
- **THEN** `applicationId` равен `ru.ryadom.companion`, имя под иконкой — «Рядом»

#### Scenario: Dev-сборка рядом с боевой
- **WHEN** (Android) на телефон, где стоит боевое приложение, ставится вариант `dev`
- **THEN** он устанавливается как отдельное приложение `ru.ryadom.companion.dev` с именем «Рядом dev»

#### Scenario: iOS
- **WHEN** (iOS) собирается приложение
- **THEN** `PRODUCT_BUNDLE_IDENTIFIER` равен `ru.ryadom.app`, имя на домашнем экране — «Рядом»

### Requirement: Порядок нативной сборки
Нативная сборка SHALL состоять из трёх шагов: сборка JS клиента для нужного варианта (режим `dev` или `prod`, результат в `dist/client`), `cap sync <android|ios>`, который копирует `dist/client` в нативный проект, и компиляция нативной части. JS MUST собираться под синтаксис не новее ES2020, чтобы работать и в старых версиях системного WebView. Для разработки `pnpm android:dev` SHALL выполнять эти шаги с вариантом `dev`, собирать отладочный APK `app-dev-debug.apk`, ставить его по `adb` и запускать `ru.ryadom.companion.dev/ru.ryadom.app.MainActivity`.

Поверхности: android · ios

#### Scenario: Локальная dev-сборка Android
- **WHEN** (Android) выполняется `pnpm android:dev`
- **THEN** собирается JS в режиме `dev`, затем `cap sync android`, затем `assembleDevDebug`, установка по `adb` и запуск

#### Scenario: Целевой синтаксис
- **WHEN** собирается JS для нативной сборки
- **THEN** результат не использует синтаксис новее ES2020
