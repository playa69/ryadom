# Rules: packages/core (`@ryadom/core`)

Rules for the core code: layers, imports, transactions, configuration. They are written down here once so that every new module does not have to be discussed again.

> **Principle:** do only what is described here. If a situation is not covered, do not improvise: ask, or add the rule first.

---

## What core is

`@ryadom/core` is all the business logic of the product: accounts, passwords, email codes, emails, conversations with the agent, admin actions with a journal, env schemas. The applications (`services/api`, `apps/admin`) are a thin layer: parse the request, call the core facade, translate the result into their own response.

- **No sessions in core.** Core does not know who calls it — the site, the admin panel or the app: it checks credentials and performs operations on an account. Sessions are the applications' concern: `app` issues its own JWTs (jose), `admin` issues a signed cookie. This way the lifetime and format of tokens can be changed without touching the domain.
  One exception: `refresh-tokens-manager` keeps the registry of the application's refresh tokens (id, expiry, revocation) without knowing their format. The scenarios for password change and reset, blocking and deletion need it: revoking what was issued is part of their purpose, and the application cannot do it for them. Issuing, signature verification and rotation stay in `services/api`.

- Core does not import from `apps/*`. Core dependencies: npm packages and `@ryadom/db`.
- From outside, core is accessed **only through module facades** (`index.ts`) and `@ryadom/core/config`.
- The package is not built: `exports` points to the sources (`./shared`, `./config`, `./managers/*`, `./processes/*`, `./services/*`, `./integrations/*`).

## Layers

```
src/
├── managers/      # one entity: CRUD, domain validation, DB (Drizzle)
├── processes/     # business scenarios: orchestration of managers / services / integrations
├── services/      # technical capabilities: passwords, tokens, email rendering and sending, health
├── integrations/  # external APIs: agent-api
├── shared/        # the single mediatr, pipeline behaviors, logger, DB and transactions, errors, personal data
└── config/        # env schemas, getEnv/loadEnv, derived helpers, input rules
```

### Dependency direction

```
processes  →  managers
           →  services
           →  integrations
```

- Managers, services and integrations **never call each other** — only through a process.
- Processes **do not call other processes**. A step shared by two scenarios (for example, sending the confirmation email on registration and on resend) is repeated in both: that way a scenario reads as a whole in one file, and a change to one does not drag the other along.
- Within a single process, shared functions live in its `shared/` (for example, building the dialog DTO in `dialogs/shared/dialog.dto.ts`). Importing another process's `shared/` is not allowed; importing _types_ from another module's facade is allowed.
- Imports are relative and without extensions: `import { usersManager } from '../../../managers/users-manager'`.

---

## MediatR

- Use only `mediatr` from `src/shared`. Never create `new Mediator()` in modules.
- A handler is registered by the `@requestHandler(Contract)` decorator when the file is imported. The first block of a module's `index.ts` is the imports of all its `*.handler.ts`. There is no separate registration in `shared/index.ts`: a facade imported by anyone registers its own handlers itself.
- Pipeline (order set in `shared/mediator/index.ts`): `LoggingBehavior` (debug log with personal data masking, an error is logged once) → `ConcurrencyBehavior` (retry on `ConcurrencyError`).

### Decorators

The package's `tsconfig.json` enables `experimentalDecorators`: `mediatr-ts` requires legacy semantics. `@requestHandler` and `@pipelineBehavior` are class decorators; `@hasPII` is written so that it works in both legacy and standard (TC39) semantics: core survives being built by a consumer without this flag.

---

## Contracts and results

Every operation is a folder of files `{operation}.{command|query|operation|request}.ts` (the contract), `{operation}.handler.ts`, `{operation}.types.ts` and, if needed, `{operation}.validator.ts`.

A contract is a class extending `RequestData<Result>`, with a mandatory `*Data` interface (even for a single field; for an empty one — `Record<string, never>` and the constructor `(_data = {})`):

```typescript
export interface CreateUserCommandData {
  userId: string
  email: string
  name: string | null
  isEmailConfirmed: boolean
}

export class CreateUserCommand extends RequestData<CreateUserCommandResult> {
  /** Survives build minification — CreateUserCommand.name is not preserved in production. Used by LoggingBehavior. */
  static readonly requestName = 'CreateUserCommand'

  public readonly userId: string

  @hasPII()
  public readonly email: string

  public readonly name: string | null
  public readonly isEmailConfirmed: boolean

  constructor(data: CreateUserCommandData) {
    super()
    this.userId = data.userId
    this.email = data.email
    this.name = data.name
    this.isEmailConfirmed = data.isEmailConfirmed
  }
}
```

- `static readonly requestName` — a string with the class name, the first line of the body. `LoggingBehavior` takes the request name from here, not from `constructor.name`: the production build of web (Turbopack) minifies class names, and the minifier does not touch a string literal. Without this field the logs would show a one-letter name instead of `CreateUserCommand started`.
- `@hasPII()` — a partial mask (email), `@hasPII(true)` — a full mask (passwords, tokens, hashes, links with tokens, email texts). Mark everything that must not be visible in the debug log.

A result is a union discriminated by `success` with a **named** payload:

```typescript
export enum GetUserByIdQueryErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
}

export type GetUserByIdQueryResult =
  { success: true; user: UserDTO } | { success: false; error: GetUserByIdQueryErrorCode }
```

- No domain failures — no enum: `{ success: true; … }` for managers and processes, a plain result interface for services, `*Response` for integrations.
- There is no `errorMessage`: the human-readable text lives in the UI, core returns only the code.

### Manager commands do not return data

A manager command changes state and answers only "it worked" or "no, and here is why": `{ success: true }` or `{ success: false, error }`. Data (DTOs, lists, counters) is returned **only by queries**. The identifier of a new entity is generated by the caller — the process — and passed into the command: it does not have to wait for the response to know the id, and a retry of the command with the same id hits the primary key instead of creating a duplicate.

```typescript
// command: only success or a failure code
export enum CreateUserCommandErrorCode {
  USER_ALREADY_EXISTS = 'USER_ALREADY_EXISTS',
}

export type CreateUserCommandResult =
  { success: true } | { success: false; error: CreateUserCommandErrorCode }

// process: the id is its own, the data comes from a separate query
const userId = randomUUID()
const created = await usersManager.execute(
  new CreateUserCommand({ userId, email, name, isEmailConfirmed: false }),
)
if (!created.success) {
  switch (created.error) {
    case CreateUserCommandErrorCode.USER_ALREADY_EXISTS:
      return { success: false, error: RegisterOperationErrorCode.USER_ALREADY_EXISTS }
    default:
      assertNever(created.error)
  }
}
const userResult = await usersManager.execute(new GetUserByIdQuery({ userId }))
```

Process operations return what the caller needs (the user after login, the settings after saving): this is the core boundary, not a manager command.

## Error handling

| Error type                                       | Handling                                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| A domain failure the user can influence          | `{ success: false, error: XxxErrorCode.CODE }`                                             |
| Invalid input to an operation                    | zod schema in `*.validator.ts` + `validateInput(schema, input)` → throws `ValidationError` |
| A technical failure (DB, network, provider down) | `throw`                                                                                    |
| An impossible state (a bug)                      | `throw new Error('…')`                                                                     |

- Codes exist only for what can be reacted to: no `UNKNOWN`, `INTERNAL_ERROR`, `NETWORK_ERROR`, `STORAGE_FAILED`.
- Applications validate input themselves before core (422 in the API, form validation in the admin panel); the core validator is the second line.
- **Every** `{ success: false }` of a dependency is handled by a `switch` on the code with `default: assertNever(result.error)` (`import assertNever from 'assert-never'`). The branch is determined by who can resolve the situation:

| Situation                          | Branch                                                     |
| ---------------------------------- | ---------------------------------------------------------- |
| The user can fix it                | `return { success: false, error: OperationErrorCode.XYZ }` |
| An expected edge case, idempotency | `break` (+ `logger.info`)                                  |
| An impossible state                | `throw new Error('…')`                                     |
| Exhaustive check                   | `default: assertNever(result.error)`                       |

The shortcut `if (!result.success) return …` without a `switch` is not used: a new code in a dependency must break compilation in every place that does not handle it.

---

## Naming

| Element          | Rule                          | Example                                                                    |
| ---------------- | ----------------------------- | -------------------------------------------------------------------------- |
| Module directory | kebab-case + layer suffix     | `users-manager`, `token-service`, `admin-authentication`, `agent-api`      |
| Facade class     | PascalCase + layer suffix     | `UsersManager`, `TokenService`, `AuthenticationProcess`, `VkIdIntegration` |
| Facade interface | `I` + class                   | `IUsersManager`                                                            |
| Singleton        | camelCase                     | `usersManager`, `authenticationProcess`                                    |
| Handler          | `{FullContractName}Handler`   | `CreateUserCommandHandler`, `LoginOperationHandler`                        |
| Data interface   | `{FullContractName}Data`      | `CreateUserCommandData`, `LoginOperationData`                              |
| ErrorCode enum   | `{FullContractName}ErrorCode` | `CreateUserCommandErrorCode`, `LoginOperationErrorCode`                    |

By layer:

|                | managers                                       | processes                               | services                                         | integrations                                              |
| -------------- | ---------------------------------------------- | --------------------------------------- | ------------------------------------------------ | --------------------------------------------------------- |
| Contract       | `{Verb}{Entity}Command` / `…Query`             | `{OperationName}Operation`              | `{Verb}{Capability}Request`                      | `{Verb}{Resource}Request`                                 |
| Contract file  | `.command.ts` / `.query.ts`                    | `.operation.ts`                         | `.request.ts`                                    | `.request.ts`                                             |
| Result         | `{Contract}Result` (`CreateUserCommandResult`) | `{OperationName}Result` (`LoginResult`) | `{Contract}Result` (`HashPasswordRequestResult`) | `{Verb}{Resource}Response` (`ExchangeYandexCodeResponse`) |
| Contract union | `{Entity}ManagerRequests`                      | `{ScenarioName}Operations`              | `{ServiceName}Requests`                          | `{ProviderName}IntegrationRequests`                       |
| Operations     | `commands/{op}/`, `queries/{op}/`              | `{op}/`                                 | `{op}/`                                          | `{op}/`                                                   |

Contract names are unique across the whole core: on a clash, add a qualifier (`BuildYandexAuthorizeUrlRequest` and `BuildVkIdAuthorizeUrlRequest`, `DeleteUserOperation` for the admin panel and `DeleteUserCommand` for the manager).

## Facade (`index.ts`)

```typescript
// 1. Handler imports
import './commands/create-user/create-user.handler'
import './queries/get-user-by-id/get-user-by-id.handler'

import type { RequestData } from 'mediatr-ts'
import { mediatr } from '../../shared'

// 2. Contract re-exports
export { CreateUserCommand } from './commands/create-user/create-user.command'
export type { CreateUserCommandData } from './commands/create-user/create-user.command'

// 3. Type re-exports (enum — as a value, everything else — export type)
export type { CreateUserCommandResult } from './commands/create-user/create-user.types'
export { CreateUserCommandErrorCode } from './commands/create-user/create-user.types'
export type { UserDTO } from './shared/user.dto'

// 4. Union type
import type { CreateUserCommand } from './commands/create-user/create-user.command'
export type UsersManagerRequests = CreateUserCommand | GetUserByIdQuery

// 5. Facade
export class UsersManager implements IUsersManager {
  async execute<T extends UsersManagerRequests>(
    request: T,
  ): Promise<T extends RequestData<infer R> ? R : never> {
    return (await (mediatr.send as (r: UsersManagerRequests) => Promise<unknown>)(
      request,
    )) as T extends RequestData<infer R> ? R : never
  }
}

export interface IUsersManager {
  execute<T extends UsersManagerRequests>(request: T): Promise<T extends RequestData<infer R> ? R : never>
}

export const usersManager: IUsersManager = new UsersManager()
```

A process may add wrapper functions for frequent calls — wrappers only, no logic.

---

## Managers

A manager is the domain logic of **one entity** (table): CRUD, domain validation, reading and writing through Drizzle. Commands return only success or a failure code, queries return DTOs.

- They do not orchestrate several entities and do not call other managers, services or integrations. The exception is an auxiliary **read** of a related table in the same query (the provider filter in `SearchUsersQuery` looks into `user_identity_providers`).
- Structure: `commands/{op}/`, `queries/{op}/`, `shared/{entity}.dto.ts` with the DTO interface and the mapper `to{Entity}DTO(row)`.
- DTOs are internal types of core. They may contain internal fields (the password hash in `UserCredentialsDTO`); a process does not hand such DTOs outside but builds its own.
- Identifiers also come from URLs: a non-UUID is turned straight into `…_NOT_FOUND` (`isUuid` from shared), not into a Postgres error.
- Uniqueness conflicts are handled via `ON CONFLICT DO NOTHING … RETURNING` and a check of the empty result, not by catching 23505: an exception inside a process transaction aborts the whole transaction. If an exception cannot be avoided (UPDATE of a unique field), wrap the query in `withSavepoint` and check `isUniqueViolation` / `isForeignKeyViolation`.

## Processes

A process is a business scenario from start to finish and **the only** orchestrator.

- They do not work with the DB directly (except the transaction boundary, see below), do not implement technical logic, do not call external APIs — everything goes through the facades of the layers.
- Structure: `{op}/` per operation, `shared/` for DTOs and functions shared by the operations of this process, `src/processes/config.ts` (`PROCESSES_CONFIG`) — durations and constants of the scenarios.
- Emails and external calls come **after** the transaction. A failure of an email that merely accompanies an action (welcome, "password changed", "account deleted") is logged and does not cancel the action; an email for the sake of which the operation is called (resending the confirmation, the email change link) throws on failure.

## Services

A service is a technical capability with no knowledge of domain entities: password hashing, tokens, email rendering and sending, health.

- They do not call managers, processes or integrations and do not keep state.
- Settings go in the module's `config.ts` (durations, keys from `getEnv()`), not in handlers.
- Email sending lives in `email-sender-service`: the transport (SMTP, console, in-memory for tests) is a technical detail of the service, not of the scenario.

## Integrations

An integration is a thin wrapper over an external API: build the request, call it, return the response in the provider's format (`shared/{provider}.types.ts`), without domain DTOs.

- HTTP errors — `throw`. `ErrorCode` is only for statuses that the API explicitly returns and that the caller handles (`INVALID_GRANT` on code exchange, `UNREGISTERED` for FCM).
- They call the global `fetch` at request time (tests replace it with `vi.stubGlobal`), with the `AbortSignal.timeout` timeout.
- They keep no state between requests. The only exception is the cache of the provider's credentials (the access token of the FCM service account in `fcm/shared/access-token.ts`): it is a cache, and losing it costs one extra request.

---

## DB and transactions

- `getDb()` from `shared` is the query executor: the shared pool (a lazy singleton by `DATABASE_URL`) or the transaction of the current async context.
- The transaction boundary is set by the **process**: `await inTransaction(async () => { …manager calls… })`. Managers inside a transaction get it through `getDb()` (AsyncLocalStorage) and know nothing about it. A nested `inTransaction` joins the outer one. Only the scenario knows the boundary: a manager cannot decide for it where atomicity ends.
- An early exit with a domain error inside a transaction goes through the callback's return value (`return ErrorCode.X`), a rollback goes through `throw`.
- `withSavepoint(fn)` — an isolated piece inside a transaction whose error does not abort it.
- In raw ``sql`…` `` drizzle does not convert `Date` (the driver's date serializers are transparent): pass `date.toISOString()` with an explicit `::timestamptz`.
- Time is compared in JS (`new Date()` is passed as a parameter), not with `now()` in SQL: tests move the clock through a fake `Date`.

## Configuration

- Core reads env only through `getEnv()` (`config/env.ts`, checked against the `coreEnvSchema` schema on first access) and only from the modules' `config.ts` and `processes/config.ts`. The DB and logs are exceptions: `getDb()` reads `DATABASE_URL`, the logger reads `LOG_LEVEL`, `APP_ENV` and `OTEL_*` itself, so that tests and migrations do not require the whole env.
- Applications call `loadEnv(appEnvSchema)` / `loadEnv(adminEnvSchema)` at startup — they fail immediately with a list of all problems.
- A new variable goes into the schema in `config/env.ts` and into the applications' `.env.example`.

## Logs and personal data

- `createLogger('module-name')` from `shared`: `debug/info(message, data)`, `warn/error(message, error, data)`. JSON (pino) to stdout, level — `LOG_LEVEL`; with `OTEL_ENABLED=true` — also over OTLP (`shared/telemetry.ts`).
- Do not write passwords, tokens, OAuth codes, links with tokens or email texts to the log: contract fields are marked `@hasPII`, and core strips query parameters from drizzle errors itself. Which other keys to strip (`password`, `token`, headers…) is not decided by core: the application sets the list at startup via `configureLogger`. Identifiers (userId) may be logged.

## Tests

- `test/*.test.ts`, vitest, a real Postgres (`DATABASE_URL_TEST`, `ryadom_test` by default): the global setup recreates the schema and applies migrations, `test/setup.ts` cleans the tables before each test. Files run sequentially.
- External HTTP — `mockFetch` from `test/helpers.ts` (`vi.stubGlobal('fetch')`), emails — the `memory` transport (`getSentEmails()`), time — `travelTo`/`travelBy` (only `Date` is replaced).
- A test calls the facades the same way the applications do and checks codes, data and DB state.

## How to add an operation

1. The operation folder in the right layer; the contract with `*Data` and `static readonly requestName`, the types with the error code enum, the handler with `@requestHandler`, a validator if needed.
2. The handler import and the re-exports in the module's `index.ts`, the contract goes into the union.
3. All dependency failures — `switch` + `assertNever`.
4. A test in `test/`, an entry in the README (for a process — a row in the API table).
