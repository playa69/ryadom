# Дельта-спецификация: native-app-build

## Purpose

Мобильный клиент выпускается и как нативные приложения Android и iOS на Capacitor: тот же JS-код работает в WebView, собирается отдельно под каждый вариант (`dev`, `prod`), подписывается и уходит в магазины или по прямой ссылке. Спека фиксирует идентификаторы, конфигурацию оболочки, источники адресов API и номеров версий, артефакты, подпись, каналы выпуска и политику запуска сборок — для тех, кто выпускает версии и обслуживает магазины. Требования о политике запуска сборок и о происхождении номеров в релизе описывают конвейер сборки, расположенный вне каталога `app/`; остальное проверяется по файлам проекта. Реализовано в `app/apps/mobile/capacitor.config.ts`, `app/apps/mobile/vite.config.ts`, `app/apps/mobile/android/`, `app/apps/mobile/ios/` и `app/apps/mobile/scripts/`.

## ADDED Requirements

### Requirement: Идентификатор и имя приложения

Приложение SHALL иметь идентификатор `ru.ryadom.app`: он же `appId` Capacitor, `applicationId` и `namespace` (Java-пакет нативного кода) Android и `PRODUCT_BUNDLE_IDENTIFIER` iOS. Отображаемое имя — «Рядом» (Android: `app_name` варианта `prod`; iOS: `CFBundleDisplayName`). Вариант `dev` на Android SHALL иметь `applicationId` `ru.ryadom.app.dev`, суффикс версии `-dev` и имя «Рядом dev», чтобы ставиться рядом с боевым; на iOS отдельного идентификатора для `dev` нет.

#### Scenario: Боевая сборка Android

- **WHEN** собирается Android-вариант `prod`
- **THEN** `applicationId` равен `ru.ryadom.app`, имя под иконкой — «Рядом»

#### Scenario: Dev-сборка рядом с боевой

- **WHEN** на телефон, где стоит боевое приложение, ставится Android-вариант `dev`
- **THEN** он устанавливается как отдельное приложение `ru.ryadom.app.dev` с именем «Рядом dev»

#### Scenario: iOS

- **WHEN** собирается iOS-приложение
- **THEN** `PRODUCT_BUNDLE_IDENTIFIER` равен `ru.ryadom.app`, имя на домашнем экране — «Рядом»

### Requirement: Идентификаторы неизменны после первой публикации

Идентификатор `ru.ryadom.app` (`appId` Capacitor, `applicationId` и Java-пакет Android, bundle id iOS) MUST NOT меняться после первой публикации в магазине: это идентификатор приложения в магазинах и пакет нативного кода.

#### Scenario: Очередной выпуск

- **WHEN** готовится любая следующая нативная сборка
- **THEN** `appId` в `capacitor.config.ts`, `applicationId` в `android/app/build.gradle` и `PRODUCT_BUNDLE_IDENTIFIER` в проекте Xcode равны `ru.ryadom.app`

### Requirement: Порядок нативной сборки

Нативная сборка SHALL состоять из трёх шагов: сборка JS клиента для нужного варианта (`vite build --mode dev` или `--mode prod`, результат в `dist/client`), `cap sync <android|ios>`, который копирует `dist/client` в нативный проект (`webDir`), и компиляция нативной части. JS MUST собираться под синтаксис не новее ES2020, чтобы работать и в старых версиях системного WebView.

#### Scenario: Локальная dev-сборка Android

- **WHEN** выполняется `pnpm android:dev`
- **THEN** сначала собирается JS в режиме `dev`, затем `cap sync android`, затем `assembleDevDebug`, установка по `adb` и запуск `ru.ryadom.app.dev/ru.ryadom.app.MainActivity`

#### Scenario: Целевой синтаксис

- **WHEN** собирается JS для нативной сборки
- **THEN** результат не использует синтаксис новее ES2020

### Requirement: Конфигурация нативной оболочки Capacitor

Оболочка SHALL быть настроена так: `webDir` — `dist/client`; схема Android — `https` (страница открывается с origin `https://localhost`); фон оболочки и заставки — `#00051a`; заставка показывается `500` мс (`launchShowDuration`), скрывается автоматически и без индикатора; значки системных панелей светлые (`DARK`) независимо от системной темы; отступы системных панелей передаются в CSS (`insetsHandling: 'css'`), а WebView выходит под них (`viewport-fit=cover`); клавиатура меняет размер нативно (`resize: 'native'`). Плагин обновлений `CapacitorUpdater` SHALL работать с `autoUpdate: false` и пустым `statsUrl`: обновлениями управляет собственный механизм приложения (см. `app-updates`), а события и ошибки в облако плагина не отправляются.

#### Scenario: Релизная синхронизация

- **WHEN** выполняется `cap sync` без `CAP_LIVE_RELOAD_URL`
- **THEN** сгенерированная конфигурация содержит `androidScheme: 'https'`, `webDir: 'dist/client'` и настройки плагинов выше

#### Scenario: Облако плагина обновлений

- **WHEN** приложение запущено с плагином `CapacitorUpdater`
- **THEN** он не скачивает обновления сам и не шлёт статистику (`autoUpdate: false`, `statsUrl: ''`)

### Requirement: Живая перезагрузка не попадает в релиз

`server.url` и `cleartext` SHALL добавляться в генерируемую конфигурацию Capacitor только когда при `cap sync` задана переменная окружения `CAP_LIVE_RELOAD_URL`; без неё их MUST NOT быть: HTTP-адрес в релизе означает и отказ на проверке магазином, и возможность подмены приложения в открытой сети. Скрипт `pnpm android:dev` MUST удалять эту переменную из окружения, а `pnpm android:live` SHALL задавать её (по умолчанию `http://10.0.2.2:5174`).

#### Scenario: Обычная сборка

- **WHEN** `cap sync` выполняется без `CAP_LIVE_RELOAD_URL`
- **THEN** в конфигурации нет `server.url` и `cleartext`

#### Scenario: Работа с dev-сервером

- **WHEN** выполняется `pnpm android:live`
- **THEN** WebView загружает адрес из `CAP_LIVE_RELOAD_URL`, и правки видны без пересборки

#### Scenario: Dev-сборка после live-запуска

- **WHEN** после `pnpm android:live` выполняется `pnpm android:dev`
- **THEN** переменная `CAP_LIVE_RELOAD_URL` удалена из окружения, и APK не наследует адрес dev-сервера

### Requirement: Адреса API задаются переменными сборки

Адреса SHALL фиксироваться при сборке JS из переменных окружения `VITE_PROD_API_URL`, `VITE_PROD_WEB_URL`, `VITE_STAGING_API_URL` и `VITE_STAGING_WEB_URL`; значения из окружения процесса MUST иметь приоритет над файлом `.env.<режим>`, завершающие `/` отбрасываются. Нативное приложение MUST NOT получать эти адреса во время работы (кроме выбора среды в `dev`-сборке). Если в нативной сборке пусты `VITE_PROD_API_URL` или `VITE_PROD_WEB_URL`, сборка SHALL продолжаться с предупреждением, что среда `prod` в ней не работает. В веб-сборке адрес API — свой же origin (см. `pwa-delivery`).

#### Scenario: Сборка с адресами

- **WHEN** JS собирается с заданными `VITE_PROD_API_URL` и `VITE_PROD_WEB_URL`
- **THEN** приложение ходит в этот API, а ссылки «на сайт» (документы, страница загрузки) строятся от `VITE_PROD_WEB_URL`

#### Scenario: Адреса не заданы

- **WHEN** нативный JS собирается без `VITE_PROD_API_URL` или `VITE_PROD_WEB_URL`
- **THEN** сборка не падает, выводится предупреждение, что среда `prod` в этой сборке не работает

#### Scenario: Переменная процесса и файл

- **WHEN** `VITE_PROD_API_URL` задана и в окружении процесса, и в `.env.<режим>`
- **THEN** используется значение из окружения процесса

### Requirement: Вариант сборки обязателен и определяет среду

Для нативной сборки JS переменная `VITE_FLAVOR` SHALL быть равна `dev` или `prod`; иначе сборка MUST завершаться ошибкой с указанием `--mode dev|prod`. Значение приходит из `.env.<режим>` или из окружения процесса. Вариант `prod` MUST всегда указывать на адреса `prod`, а код переключателя сред MUST отсутствовать в его бандле. Вариант `dev` по умолчанию SHALL указывать на `staging`, если задан `VITE_STAGING_API_URL`, иначе на `local` (на нативном клиенте — `http://10.0.2.2:3002`). Android-варианты Gradle (`dev`, `prod`, измерение `environment`) соответствуют этим двум вариантам.

#### Scenario: Вариант не задан

- **WHEN** нативный JS собирается без `VITE_FLAVOR` или с другим значением
- **THEN** сборка завершается ошибкой «VITE_FLAVOR must be "dev" or "prod"»

#### Scenario: Боевой вариант

- **WHEN** запущено приложение, собранное в варианте `prod`
- **THEN** оно работает только с адресами `prod`, выбрать другую среду нельзя

#### Scenario: Dev-вариант со staging

- **WHEN** собран вариант `dev` с заданным `VITE_STAGING_API_URL` и человек ещё не менял среду
- **THEN** приложение работает со `staging`

#### Scenario: Dev-вариант без staging

- **WHEN** собран вариант `dev` без `VITE_STAGING_API_URL`
- **THEN** приложение стартует в среде `local`

### Requirement: Переключатель сред только в dev-сборке

В варианте `dev` семь быстрых нажатий подряд (пауза между нажатиями не больше 1,5 с) на логотип экрана входа или на номер версии в профиле SHALL открывать выбор среды `Local`, `Staging`, `Prod`; пункт среды, адрес которой не вшит в сборку, MUST быть недоступен; для `Local` запрашивается адрес сервера (пусто — адрес по умолчанию). Выбор SHALL сохраняться между запусками; переключение MUST разлогинивать человека (токены выданы другим сервером) и перезагружать WebView. В варианте `prod` переключателя MUST NOT быть.

#### Scenario: Переключение на staging

- **WHEN** в `dev`-сборке человек семь раз быстро нажимает на логотип и выбирает «Staging»
- **THEN** он выходит из аккаунта, WebView перезагружается и приложение работает со `staging`
- **AND** после перезапуска приложения выбор сохранён

#### Scenario: Медленные нажатия

- **WHEN** паузы между нажатиями на логотип больше 1,5 с
- **THEN** счёт нажатий начинается заново и выбор среды не открывается

#### Scenario: Среда без вшитого адреса

- **WHEN** в `dev`-сборке не вшит адрес `prod`
- **THEN** пункт `Prod` в выборе среды отключён

#### Scenario: Боевая сборка

- **WHEN** в варианте `prod` человек семь раз нажимает на логотип
- **THEN** ничего не происходит

### Requirement: Версии нативной сборки

Android SHALL брать `versionCode` из переменной `RYADOM_VERSION_CODE` (без неё — `1`), `versionName` — из `RYADOM_VERSION_NAME` (без неё — `0.1.0`); вариант `dev` добавляет к `versionName` суффикс `-dev`. iOS SHALL брать версию из `MARKETING_VERSION` (в проекте по умолчанию `1.0`, `CFBundleShortVersionString`) и номер сборки из `CURRENT_PROJECT_VERSION` (по умолчанию `1`, `CFBundleVersion`). Приложение SHALL сообщать API номер сборки (Android `versionCode`, iOS номер сборки) как целое число; если прочитать его не удалось, проверки версий не выполняются. Номер сборки MUST расти с каждым выпуском, потому что ворота версий сравнивают его как число (см. `app-updates`).

#### Scenario: Локальная сборка без переменных

- **WHEN** Android собирается без `RYADOM_VERSION_CODE` и `RYADOM_VERSION_NAME`
- **THEN** `versionCode` равен `1`, `versionName` — `0.1.0` (для `dev` — `0.1.0-dev`)

#### Scenario: Сборка из конвейера

- **WHEN** конвейер задаёт `RYADOM_VERSION_CODE=57` и `RYADOM_VERSION_NAME=0.1.0`
- **THEN** вариант `prod` получает `versionCode` 57 и `versionName` `0.1.0`

#### Scenario: Номер iOS

- **WHEN** iOS-архив собирается с `CURRENT_PROJECT_VERSION=57`
- **THEN** `CFBundleVersion` равен `57`, и приложение сообщает API номер сборки 57

### Requirement: Происхождение номеров в релизной сборке

В релизных сборках номер сборки (Android `versionCode`, iOS `CURRENT_PROJECT_VERSION`) SHALL равняться порядковому номеру запуска конвейера (растёт сам и не зависит от веток и тегов), а `versionName` и `MARKETING_VERSION` — полю `version` из `app/apps/mobile/package.json`. Это требование описывает конвейер сборки, расположенный вне `app/`.

#### Scenario: Запуск номер 57

- **WHEN** конвейер собирает Android при `version` `0.1.0` в `package.json` и порядковом номере запуска 57
- **THEN** артефакт имеет `versionCode` 57 и `versionName` `0.1.0`

### Requirement: Артефакты нативных сборок

Android-сборка SHALL производить для каждого варианта релизный APK (`assemble<Вариант>Release`) или AAB (`bundle<Вариант>Release`) без минификации кода (`minifyEnabled false`); AAB предназначен для магазинов, APK — для установки на телефон напрямую. Для разработки `pnpm android:dev` SHALL собирать отладочный APK `app-dev-debug.apk`. iOS-сборка SHALL архивировать схему `App` в конфигурации Release и экспортировать IPA по `ExportOptions.plist` для App Store Connect (`method` — `app-store-connect`, `uploadSymbols` — `true`).

#### Scenario: AAB для магазина

- **WHEN** выпускается Android-вариант `prod` в формате AAB
- **THEN** выполняется `bundleProdRelease`, результат — AAB

#### Scenario: APK для установки напрямую

- **WHEN** выпускается Android-вариант `dev` в формате APK
- **THEN** выполняется `assembleDevRelease`, результат — APK

#### Scenario: IPA

- **WHEN** выпускается iOS-сборка
- **THEN** результат — IPA, экспортированный для App Store Connect

### Requirement: Подпись релизных сборок

Android SHALL подписывать релиз, когда задан `RYADOM_KEYSTORE_PATH`, используя входные данные `RYADOM_KEYSTORE_PASSWORD`, `RYADOM_KEY_ALIAS` и `RYADOM_KEY_PASSWORD`; если путь к хранилищу ключей не задан, релиз MUST собираться неподписанным, а не падать. Файлы ключей (`*.keystore`, `*.jks`, `keystore.properties`) MUST NOT попадать в систему контроля версий. iOS SHALL экспортироваться с ручной подписью (`signingStyle` — `manual`), для которой нужны идентификатор команды разработчика (`DEVELOPMENT_TEAM`), сертификат распространения и provisioning profile. Конвейер сборки (вне `app/`) MUST прерываться с ошибкой, если ключ Android или сертификат и профиль iOS не заданы, и MUST убирать их с сборочной машины после сборки.

#### Scenario: Релиз с ключом

- **WHEN** Android-релиз собирается с `RYADOM_KEYSTORE_PATH` и остальными входными данными
- **THEN** артефакт подписан этим ключом

#### Scenario: Релиз без ключа

- **WHEN** Android-релиз собирается без `RYADOM_KEYSTORE_PATH`
- **THEN** сборка завершается успешно, артефакт не подписан

#### Scenario: Нет входных данных подписи в конвейере

- **WHEN** конвейер запущен без ключа Android или без сертификата либо профиля iOS
- **THEN** он завершается ошибкой до сборки

### Requirement: Разрешения и платформенные параметры оболочки

Android-приложение SHALL запрашивать только разрешения `INTERNET`, `RECORD_AUDIO` и `ACCESS_NETWORK_STATE`; наличие микрофона MUST NOT быть обязательным для установки (`required="false"`: разговор можно вести текстом); `CALL_PHONE` MUST NOT запрашиваться, потому что кнопка SOS только набирает номер. Минимальная версия Android — API 24, целевая и компилируемая — API 36. iOS-приложение SHALL содержать пояснение для микрофона (`NSMicrophoneUsageDescription`), поддерживать iOS 15.0 и новее на iPhone и iPad, всегда использовать тёмный стиль интерфейса (`UIUserInterfaceStyle` — `Dark`), объявлять `ITSAppUsesNonExemptEncryption` равным `false` и поддерживать на iPhone только портретную ориентацию (на iPad — портретную и перевёрнутую портретную).

#### Scenario: Телефон без микрофона

- **WHEN** приложение ставится на устройство без микрофона
- **THEN** установка не блокируется

#### Scenario: SOS

- **WHEN** человек нажимает SOS на Android
- **THEN** набирается номер без разрешения `CALL_PHONE`, звонок начинает человек

#### Scenario: Первый запрос микрофона на iOS

- **WHEN** iOS впервые запрашивает доступ к микрофону
- **THEN** показывается пояснение из `NSMicrophoneUsageDescription`

### Requirement: Данные приложения не попадают в бэкап

Android-приложение MUST NOT попадать в резервные копии: `allowBackup` MUST быть `false`, а правила `data_extraction_rules` SHALL исключать из облачного бэкапа и из переноса на новое устройство все домены (`root`, `file`, `database`, `sharedpref`, `external`), потому что в хранилище приложения лежат токены сессии.

#### Scenario: Перенос на новый телефон

- **WHEN** человек переносит данные со старого Android-телефона на новый
- **THEN** данные приложения не переносятся, на новом телефоне нужно войти заново

### Requirement: Каналы выпуска

Android-сборка SHALL распространяться через магазины (RuStore, Google Play) и/или по прямой ссылке на APK, iOS — через App Store; каждый канал MUST быть необязательным и задаваться адресом. Для окна обновления API отдаёт адрес магазина платформы (`MOBILE_ANDROID_STORE_URL`, `MOBILE_IOS_STORE_URL`) и прямую ссылку на APK только для Android (`MOBILE_ANDROID_DOWNLOAD_URL`); страница загрузки публичного сайта показывает кнопки RuStore, Google Play, «Скачать APK» и App Store по адресам `PUBLIC_RUSTORE_URL`, `PUBLIC_GOOGLE_PLAY_URL`, `PUBLIC_ANDROID_APK_URL`, `PUBLIC_APP_STORE_URL`, а незаданный адрес скрывает кнопку (см. `landing-site`).

#### Scenario: Задан только магазин

- **WHEN** `MOBILE_ANDROID_DOWNLOAD_URL` пуст, а `MOBILE_ANDROID_STORE_URL` задан
- **THEN** для Android API отдаёт `downloadUrl: null`, и окно обновления предлагает только магазин

#### Scenario: iOS

- **WHEN** приложение запрашивает статус версий как iOS
- **THEN** `downloadUrl` равен `null`, так как прямой ссылки для iOS нет

#### Scenario: Канал не настроен

- **WHEN** адрес канала не задан на странице загрузки
- **THEN** соответствующая кнопка не показывается

### Requirement: Политика запуска сборок

Нативные сборки SHALL запускаться только по тегу (`android-v*` для Android, `ios-v*` для iOS) или вручную; при ручном запуске выбираются вариант (`dev` или `prod`) и, для Android, формат (`apk` или `aab`). Сборки MUST NOT запускаться на pull request и на обычный пуш в ветку. Без явного выбора (запуск по тегу) вариант — `prod`, а формат Android — `aab`; повторные запуски для одной ссылки не отменяют друг друга. Это требование описывает конвейер сборки, расположенный вне `app/`.

#### Scenario: Тег

- **WHEN** отправлен тег `android-v0.1.0`
- **THEN** запускается сборка Android в варианте `prod` и формате AAB

#### Scenario: Ручной запуск

- **WHEN** человек запускает сборку iOS вручную и выбирает вариант `dev`
- **THEN** JS собирается в режиме `dev`, остальное идёт как при релизной сборке

#### Scenario: Pull request

- **WHEN** открыт или обновлён pull request
- **THEN** нативные сборки не запускаются
