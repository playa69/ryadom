<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->

# app/: code rules

General repository rules are in the root `AGENTS.md`. This file is about how the `app/` code is built (pnpm +
Turborepo, Node 24, TypeScript); running and checks — skills `local-dev` and `e2e`. The core package
(`packages/core`: layers, managers, processes, transactions) has its own rules in `packages/core/AGENTS.md`.

## Contracts

The public API format is the types in `packages/contracts`: both `services/api` and the clients use them. Changing a
request or a response — first the contract, then both sides; old OTA and native client builds are still alive, so a
field cannot simply be removed.

## Server configuration

- Server variables are described by zod schemas in `packages/core/src/config/env.ts`: `appEnvSchema` for
  `services/api`, `adminEnvSchema` for the admin panel, the shared part in both. The server checks them at start
  (`services/api/src/lib/env.ts`, `apps/admin/lib/env.ts`) and fails with the list of all errors. An empty string
  means "not set".
- A new variable — a field in the schema, a line in the app's `.env.example` and, if production needs it, a key in
  `k8s/app/00-app-config.yaml` (a secret goes into a Secret; the repository holds only its name). Do not add direct
  `process.env` reads to server code.

## Logs

- Logger — `createLogger('<component>')` from `packages/core` (pino, JSON to stdout; in the cluster Loki collects it).
- Fields with personal data in process requests are marked `@hasPII()` (`packages/core/src/shared/pii-protection.ts`):
  `LoggingBehavior` masks them in logs. Conversation texts never go into the log.

## Tracing headers

- Clients send five headers with every request — `TracingHeader` in `packages/contracts/src/api/headers.ts`:
  `x-trace-id`, `x-request-time`, `x-client-id`, `x-session-id`, `x-user-id`.
- The API reads them once at the entry (HTTP middleware, WebSocket upgrade) into `RequestContext`
  (`packages/core/src/shared/request-context.ts`, AsyncLocalStorage): log records and outgoing calls to the agent
  (`tracingHeaders()`) take them from there. The context is not passed through function arguments.
- Behind a token, `x-user-id` is replaced by the verified account.

## Language

Code comments — in English and only about reasons; UI texts and documentation — in Russian.
