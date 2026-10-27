# app/: правила кода

Общие правила репозитория — в корневом `AGENTS.md`. Здесь — как устроен код `app/` (pnpm + Turborepo, Node 24,
TypeScript); запуск и проверки — скиллы `local-dev` и `e2e`. У ядра (`packages/core`: слои, менеджеры, процессы,
транзакции) свои правила — `packages/core/AGENTS.md`.

## Контракты

Формат публичного API — типы в `packages/contracts`: их используют и `services/api`, и клиенты. Меняешь запрос или
ответ — сначала контракт, потом обе стороны; старые OTA- и нативные сборки клиента ещё живут, поле нельзя просто убрать.

## Конфигурация сервера

- Переменные сервера описаны zod-схемами в `packages/core/src/config/env.ts`: `appEnvSchema` для `services/api`,
  `adminEnvSchema` для админки, общая часть — в обеих. Сервер проверяет их при старте
  (`services/api/src/lib/env.ts`, `apps/admin/lib/env.ts`) и падает со списком всех ошибок. Пустая строка — «не задано».
- Новая переменная — поле в схеме, строка в `.env.example` приложения и, если нужна в проде, ключ в
  `k8s/app/00-app-config.yaml` (секрет — в Secret, в репозитории только его имя). Прямых `process.env` в коде сервера
  не добавлять.

## Логи

- Логгер — `createLogger('<компонент>')` из `packages/core` (pino, JSON в stdout; в кластере его собирает Loki).
- Поля с личными данными в контрактах запросов ядра помечаются `@hasPII()` (`packages/core/src/shared/pii-protection.ts`):
  `LoggingBehavior` маскирует их в логах (какую маску выбрать — `packages/core/AGENTS.md`). Тексты разговоров в лог не
  пишутся.

## Заголовки трассировки

- Клиенты шлют на каждый запрос пять заголовков — `TracingHeader` в `packages/contracts/src/api/headers.ts`:
  `x-trace-id`, `x-request-time`, `x-client-id`, `x-session-id`, `x-user-id`.
- API читает их один раз на входе (HTTP-middleware, апгрейд WebSocket) в `RequestContext`
  (`packages/core/src/shared/request-context.ts`, AsyncLocalStorage): оттуда их берут записи лога и исходящие вызовы
  агента (`tracingHeaders()`). Через аргументы функций контекст не передают.
- За токеном `x-user-id` заменяется проверенным аккаунтом.

## Язык

Комментарии в коде — по-английски и только о причинах; тексты интерфейса и документация — по-русски.
