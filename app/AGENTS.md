<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->

# app/: правила кода

Общие правила репозитория — в корневом `AGENTS.md`. Здесь — как устроен код `app/` (pnpm + Turborepo, Node 24,
TypeScript); запуск и проверки — скиллы `local-dev` и `e2e`.

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
- Поля с личными данными в запросах процессов помечаются `@hasPII()` (`packages/core/src/shared/pii-protection.ts`):
  `LoggingBehavior` маскирует их в логах. Тексты разговоров в лог не пишутся.

## Заголовки трассировки

- Клиенты шлют на каждый запрос пять заголовков — `TracingHeader` в `packages/contracts/src/api/headers.ts`:
  `x-trace-id`, `x-request-time`, `x-client-id`, `x-session-id`, `x-user-id`.
- API читает их один раз на входе (HTTP-middleware, апгрейд WebSocket) в `RequestContext`
  (`packages/core/src/shared/request-context.ts`, AsyncLocalStorage): оттуда их берут записи лога и исходящие вызовы
  агента (`tracingHeaders()`). Через аргументы функций контекст не передают.
- За токеном `x-user-id` заменяется проверенным аккаунтом.

## Язык

Комментарии в коде — по-английски и только о причинах; тексты интерфейса и документация — по-русски.
