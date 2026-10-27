## 1. Данные и контракты

- [x] 1.1 Переменная `MOBILE_JS_MIN_VERSION` в схеме окружения (`app/packages/core/src/config/env.ts`), пусто — не задано, не версия — ошибка запуска; шаблон `app/services/api/.env.example`.
  Приёмка: `app/packages/core/test/platform.test.ts` — по умолчанию `undefined`, `0.1.0.42` принимается, `latest` даёт ошибку окружения.

## 3. Шлюз API

- [x] 3.1 Минимум JS в политике релизов (`app/services/api/src/lib/release-policy.ts`): ниже минимума и ниже пакета — `required`; ворота версий не меняются.
  Приёмка: матрица в `app/services/api/test/server.test.ts` покрывает сценарии «Клиент ниже минимума JS», «Клиент между минимумом и пакетом», «Минимум выше пакета», «Устаревший JS не отрезан».
- [x] 3.2 Описание ключей политики релизов в `k8s/app/00-app-config.yaml` (комментарием: значения по умолчанию в ConfigMap не повторяются).
  Приёмка: у каждого из восьми ключей указано, какой рычаг он включает.

## 4. Клиенты

- [x] 4.1 (Android, iOS) Одна функция версии JS для пакета и встроенного JS: `app/apps/mobile/scripts/js-version.mjs`, её используют `app/apps/mobile/vite.config.ts` (константа `__JS_VERSION__`) и `app/apps/mobile/scripts/build-ota-bundle.mjs`; `app/apps/mobile/src/client/lib/app-update.ts` сообщает `__JS_VERSION__`.
  Приёмка: `app/apps/mobile/test/js-version.test.ts`; собранный с `OTA_BUILD_NUMBER=42` JS содержит `0.1.0.42`, а не `0.1.0`.
- [x] 4.2 (Android, iOS) Поведение клиента на ответы статуса покрыто тестом: блокирующий экран, баннер, тихая загрузка, немедленное применение, откат, первый запуск после обновления из магазина, сбой загрузки, версия в запросе.
  Приёмка: `app/apps/mobile/test/app-update.test.ts`.
- [x] 4.3 (Android, iOS) Дружелюбный текст блокирующего экрана в `app/apps/mobile/src/client/components/AppUpdateGate.tsx`: заголовок «Пора обновить «Рядом»», пояснение с обещанием, что входить заново не придётся.
  Приёмка: сценарий «Понятный текст»; снимок экрана на 390 (раздел «Проверка», 5.2).

## 5. Проверка

- [x] 5.1 Unit: `app/services/api/test/server.test.ts` («Решение сервера по версии JS», «Откуда берётся политика релизов»), `app/packages/core/test/platform.test.ts`, `app/apps/mobile/test/js-version.test.ts`, `app/apps/mobile/test/app-update.test.ts` («Сборка OTA-пакета и манифест», «Нативное приложение сообщает версии в заголовках», «Применение пакета OTA на устройстве»).
- [x] 5.2 Ручная проверка на эмуляторе Android (боевой вариант против локального API с пакетом, образы с пакетами `0.1.0.42` и `0.1.0.43`): мягкое и жёсткое обновление JS, откат образа, мягкое и жёсткое обновление нативной сборки, закрытие баннера, кнопка «Назад» на блокирующем экране; снимки «Обновляемся», баннера и блокирующего экрана. Текст блокирующего экрана после правки 4.3 проверен в браузере на 390, на эмуляторе — до правки.
- [ ] 5.3 iOS вручную не проверялась (нет macOS): логика клиента общая, плагин тот же.
- [ ] 5.4 После выката: `GET /api/app-status?platform=android&version_code=1&js_version=0` возвращает `jsVersion` вида `0.1.0.N`; с `js_version` равной ему — `not_available`.

## 6. Выкат и процесс

- [x] 6.1 Скилл `deploy` (`.agents/skills/deploy/SKILL.md` и копия через `node scripts/sync-agent-skills.mjs`): раздел про четыре рычага и откат пакета.
  Приёмка: `node scripts/sync-agent-skills.mjs --check` зелёный.
- [x] 6.2 Защита от случайной поломки обновлений (процесс, поведения продукта не меняет, спеки не требует): правило в `app/AGENTS.md` (совместимость с живыми клиентами; нативное и версии мобильного клиента), пункты в корневом `AGENTS.md` и скилле `commit`; скилл и скрипт `.agents/skills/release-check/`; ворота в `.agents/skills/deploy/scripts/build.sh` для образов api, pwa и web (`--since`, `--check-only`, `--no-release-check`).
  Приёмка: `node --test .agents/skills/release-check/scripts/release-check.test.mjs` — 35 тестов; `build.sh api <тег> --since <коммит> --check-only`: без `--since` код 2, с нарушением 1, без нарушений 0.

## 7. Архив

- [ ] 7.1 После выката — `archive add-required-js-update --yes`, проверка `git diff openspec/specs/app-updates`.
