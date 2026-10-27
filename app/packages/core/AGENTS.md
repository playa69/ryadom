# Правила: packages/core (`@ryadom/core`)

Правила для кода ядра: слои, импорты, транзакции, тесты. Здесь они записаны один раз, чтобы каждый новый модуль не приходилось обсуждать заново.

Общее для всего `app/` — конфигурация сервера, логи, заголовки трассировки, язык комментариев — в [`app/AGENTS.md`](../../AGENTS.md), здесь не повторяется. Комментарии в примерах кода ниже — по-английски и только о причинах, как в самом коде.

> **Принцип:** делай только то, что описано здесь. Если ситуация не покрыта — не импровизируй: спроси или сначала допиши правило.

---

## Что такое core

`@ryadom/core` — вся бизнес-логика продукта: аккаунты, пароли, коды из писем, письма, разговоры с агентом, действия админа с журналом, схемы env. Приложения (`services/api`, `apps/admin`) — тонкий слой: разобрать запрос, вызвать фасад ядра, перевести результат в свой ответ.

- **Сессий в ядре нет.** Ядро не знает, кто его вызывает — сайт, админка или приложение: оно проверяет учётные данные и выполняет операции над аккаунтом. Сессии — забота приложений: `app` выдаёт свои JWT (jose), `admin` — подписанную cookie. Так срок жизни и формат токенов можно менять, не трогая домен.
  Одно исключение: `refresh-tokens-manager` хранит реестр refresh-токенов приложения (id, срок, отзыв), не зная их формата. Он нужен сценариям смены и сброса пароля, блокировки и удаления: отозвать выданное — часть их смысла, и приложение сделать этого за них не может. Выдача, проверка подписи и ротация остаются в `services/api`.

- Ядро не импортирует из `apps/*`. Зависимости ядра: npm-пакеты и `@ryadom/db`.
- Снаружи к ядру обращаются **только через фасады** модулей (`index.ts`) и `@ryadom/core/config`.
- Пакет не собирается: `exports` указывает на исходники (`./shared`, `./config`, `./managers/*`, `./processes/*`, `./services/*`, `./integrations/*`).

## Слои

```
src/
├── managers/      # одна сущность: CRUD, доменная валидация, БД (Drizzle)
├── processes/     # бизнес-сценарии: оркестрация managers / services / integrations
├── services/      # технические возможности: пароли, токены, рендер и отправка почты, health
├── integrations/  # внешние API: agent-api
├── shared/        # единый mediatr, pipeline behaviors, логгер, БД и транзакции, ошибки, ПДн
└── config/        # схемы env, getEnv/loadEnv, производные хелперы, правила ввода
```

### Направление зависимостей

```
processes  →  managers
           →  services
           →  integrations
```

- Managers, services и integrations **никогда не вызывают друг друга** — только через process.
- Processes **не вызывают другие processes**. Общий шаг двух сценариев (например, отправка письма подтверждения при регистрации и при повторной отправке) повторяется в обоих: так сценарий читается целиком в одном файле, а изменение одного не тянет за собой другой.
- Внутри одного process общие функции лежат в его `shared/` (например, сборка DTO диалога в `dialogs/shared/dialog.dto.ts`). Импортировать `shared/` чужого process нельзя; импортировать _типы_ из фасада другого модуля можно.
- Импорты относительные и без расширений: `import { usersManager } from '../../../managers/users-manager'`.

---

## MediatR

- Используй только `mediatr` из `src/shared`. Никогда не создавай `new Mediator()` в модулях.
- Handler регистрируется декоратором `@requestHandler(Contract)` при импорте файла. Первый блок `index.ts` модуля — импорты всех его `*.handler.ts`. Отдельной регистрации в `shared/index.ts` нет: фасад, импортированный кем угодно, регистрирует свои handlers сам.
- Pipeline (порядок задан в `shared/mediator/index.ts`): `LoggingBehavior` (debug-лог с маскированием ПДн, ошибка логируется один раз) → `ConcurrencyBehavior` (повтор при `ConcurrencyError`).

### Декораторы

`tsconfig.json` пакета включает `experimentalDecorators`: `mediatr-ts` требует легаси-семантики. `@requestHandler` и `@pipelineBehavior` — декораторы класса, `@hasPII` написан так, что работает и в легаси-, и в стандартной (TC39) семантике: ядро переживёт сборку потребителем без этого флага.

---

## Контракты и результаты

Каждая операция — папка из файлов `{operation}.{command|query|operation|request}.ts` (контракт), `{operation}.handler.ts`, `{operation}.types.ts` и при необходимости `{operation}.validator.ts`.

Контракт — класс, наследник `RequestData<Result>`, с обязательным интерфейсом `*Data` (даже для одного поля; для пустого — `Record<string, never>` и конструктор `(_data = {})`):

```typescript
export interface CreateUserCommandData {
  userId: string
  /** Null makes an anonymous account. */
  email: string | null
  name: string | null
  isEmailConfirmed: boolean
}

export class CreateUserCommand extends RequestData<CreateUserCommandResult> {
  /** Survives minification: CreateUserCommand.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'CreateUserCommand'

  public readonly userId: string

  @hasPII()
  public readonly email: string | null

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

- `static readonly requestName` — строка с именем класса, первая строка тела. `LoggingBehavior` берёт имя запроса отсюда, а не из `constructor.name`: продовая сборка web (Turbopack) минифицирует имена классов, а строковый литерал минификатор не трогает. Без этого поля в логах вместо `CreateUserCommand started` будет однобуквенное имя.
- `@hasPII()` — частичная маска (почта), `@hasPII(true)` — полная (пароли, токены, хеши, ссылки с токенами, тексты писем). Помечай всё, что нельзя увидеть в debug-логе.

Результат — дискриминированное объединение по `success` с **именованным** полезным грузом:

```typescript
export enum GetUserByIdQueryErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
}

export type GetUserByIdQueryResult =
  { success: true; user: UserDTO } | { success: false; error: GetUserByIdQueryErrorCode }
```

- Нет доменных отказов — нет enum: `{ success: true; … }` у managers и processes, простой интерфейс результата у services, `*Response` у integrations.
- `errorMessage` не бывает: текст для человека живёт в интерфейсе, ядро отдаёт только код.

### Команды менеджеров не возвращают данные

Команда менеджера меняет состояние и отвечает только «получилось» или «нет, и вот почему»: `{ success: true }` или `{ success: false, error }`. Данные (DTO, списки, счётчики) возвращают **только queries**. Идентификатор новой сущности генерирует вызывающий — process — и передаёт в команду: ему не нужно ждать ответа, чтобы знать id, а повтор команды с тем же id упирается в первичный ключ, а не создаёт дубль.

```typescript
// command: only success or a refusal code
export enum CreateUserCommandErrorCode {
  USER_ALREADY_EXISTS = 'USER_ALREADY_EXISTS',
}

export type CreateUserCommandResult = { success: true } | { success: false; error: CreateUserCommandErrorCode }

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

Operations процессов возвращают то, что нужно вызывающему (пользователя после входа, настройки после сохранения): это граница ядра, а не команда менеджера.

## Обработка ошибок

| Тип ошибки                                             | Обработка                                                                                 |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Доменный отказ, на который пользователь может повлиять | `{ success: false, error: XxxErrorCode.CODE }`                                            |
| Невалидный вход в операцию                             | zod-схема в `*.validator.ts` + `validateInput(schema, input)` → бросает `ValidationError` |
| Технический сбой (БД, сеть, провайдер лёг)             | `throw`                                                                                   |
| Невозможное состояние (баг)                            | `throw new Error('…')`                                                                    |

- Коды — только то, на что можно отреагировать: без `UNKNOWN`, `INTERNAL_ERROR`, `NETWORK_ERROR`, `STORAGE_FAILED`.
- Приложения проверяют ввод сами до ядра (422 в API, валидация формы в админке); валидатор ядра — вторая линия.
- **Каждый** `{ success: false }` зависимости разбирается `switch` по коду с `default: assertNever(result.error)` (`import assertNever from 'assert-never'`). Ветка определяется тем, кто может разрешить ситуацию:

| Ситуация                             | Ветка                                                      |
| ------------------------------------ | ---------------------------------------------------------- |
| Пользователь может исправить         | `return { success: false, error: OperationErrorCode.XYZ }` |
| Ожидаемый edge-case, идемпотентность | `break` (+ `logger.info`)                                  |
| Невозможное состояние                | `throw new Error('…')`                                     |
| Исчерпывающая проверка               | `default: assertNever(result.error)`                       |

Сокращение `if (!result.success) return …` без `switch` не используем: новый код в зависимости должен сломать компиляцию во всех местах, где его не обработали.

---

## Именование

| Элемент           | Правило                       | Пример                                                                     |
| ----------------- | ----------------------------- | -------------------------------------------------------------------------- |
| Директория модуля | kebab-case + суффикс слоя     | `users-manager`, `token-service`, `admin-authentication`, `agent-api`      |
| Класс фасада      | PascalCase + суффикс слоя     | `UsersManager`, `TokenService`, `AuthenticationProcess`, `AgentApiIntegration` |
| Интерфейс фасада  | `I` + класс                   | `IUsersManager`                                                            |
| Singleton         | camelCase                     | `usersManager`, `authenticationProcess`                                    |
| Handler           | `{FullContractName}Handler`   | `CreateUserCommandHandler`, `LoginOperationHandler`                        |
| Data-интерфейс    | `{FullContractName}Data`      | `CreateUserCommandData`, `LoginOperationData`                              |
| ErrorCode enum    | `{FullContractName}ErrorCode` | `CreateUserCommandErrorCode`, `LoginOperationErrorCode`                    |

По слоям:

|                  | managers                                       | processes                               | services                                         | integrations                                              |
| ---------------- | ---------------------------------------------- | --------------------------------------- | ------------------------------------------------ | --------------------------------------------------------- |
| Контракт         | `{Verb}{Entity}Command` / `…Query`             | `{OperationName}Operation`              | `{Verb}{Capability}Request`                      | `{Verb}{Resource}Request`                                 |
| Файл контракта   | `.command.ts` / `.query.ts`                    | `.operation.ts`                         | `.request.ts`                                    | `.request.ts`                                             |
| Результат        | `{Contract}Result` (`CreateUserCommandResult`) | `{OperationName}Result` (`LoginResult`) | `{Contract}Result` (`HashPasswordRequestResult`) | `{Verb}{Resource}Response` (`StartAgentDialogResponse`) |
| Union контрактов | `{Entity}ManagerRequests`                      | `{ScenarioName}Operations`              | `{ServiceName}Requests`                          | `{ProviderName}IntegrationRequests`                       |
| Операции         | `commands/{op}/`, `queries/{op}/`              | `{op}/`                                 | `{op}/`                                          | `{op}/`                                                   |

Имена контрактов уникальны во всём ядре: при совпадении добавляй уточнение (`DeleteAccountOperation` — человек удаляет себя, `DeleteUserAccountOperation` — админ удаляет аккаунт).

## Фасад (`index.ts`)

```typescript
// 1. Handler imports
import './commands/create-user/create-user.handler'
import './queries/get-user-by-id/get-user-by-id.handler'

import type { RequestData } from 'mediatr-ts'
import { mediatr } from '../../shared'

// 2. Contract re-exports
export { CreateUserCommand } from './commands/create-user/create-user.command'
export type { CreateUserCommandData } from './commands/create-user/create-user.command'

// 3. Type re-exports (an enum as a value, everything else as `export type`)
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

Process может добавить функции-обёртки для частых вызовов — только обёртки, без логики.

---

## Managers

Manager = доменная логика **одной сущности** (таблицы): CRUD, доменная валидация, чтение и запись через Drizzle. Commands возвращают только успех или код отказа, queries — DTO.

- Не оркестрируют несколько сущностей, не вызывают другие managers, services и integrations. Исключение — вспомогательное **чтение** связанной таблицы в том же запросе.
- Структура: `commands/{op}/`, `queries/{op}/`, `shared/{entity}.dto.ts` с интерфейсом DTO и маппером `to{Entity}DTO(row)`.
- DTO — внутренние типы ядра. В них могут быть служебные поля (хеш пароля у `UserCredentialsDTO`); process не отдаёт такие DTO наружу, а строит свой.
- Идентификаторы приходят и из URL: не-UUID сразу превращается в `…_NOT_FOUND` (`isUuid` из shared), а не в ошибку Postgres.
- Конфликты уникальности — через `ON CONFLICT DO NOTHING … RETURNING` и проверку пустого результата, а не перехватом 23505: исключение внутри транзакции процесса обрывает всю транзакцию. Если без исключения не обойтись (UPDATE уникального поля), оборачивай запрос в `withSavepoint` и проверяй `isUniqueViolation` / `isForeignKeyViolation`.

## Processes

Process = бизнес-сценарий от начала до конца и **единственный** оркестратор.

- Не работают с БД напрямую (кроме границы транзакции, см. ниже), не реализуют техническую логику, не ходят во внешние API — всё через фасады слоёв.
- Структура: `{op}/` на операцию, `shared/` для общих DTO и функций операций этого process, `src/processes/config.ts` (`PROCESSES_CONFIG`) — сроки и константы сценариев.
- Письма и внешние вызовы — **после** транзакции. Исключение — постановка задачи в очередь (`job-queue-service`, `EnqueueJobRequest`): это запись в нашу базу, её делают внутри `inTransaction` процесса, чтобы действие и задача случались вместе или не случались; выполняет задачу воркер в `services/api` уже после коммита. Сбой письма, которое лишь сопровождает действие (приветствие, «пароль изменён», «аккаунт удалён»), логируется и не отменяет действие; письмо, ради которого вызвана операция (повторное подтверждение, ссылка смены почты), при сбое бросает исключение.

## Services

Service = техническая возможность без знания о доменных сущностях: хеширование паролей, токены, рендер и отправка писем, проверка подписи Telegram, health.

- Не вызывают managers, processes, integrations и не хранят состояние.
- Настройки — в `config.ts` модуля (сроки, ключи из `getEnv()`). Handler читает `getEnv()` напрямую только ради одного секрета или флага, как `telegram-service`.
- Отправка почты живёт в `email-sender-service`: транспорт (SMTP, консоль, память для тестов) — техническая деталь сервиса, а не сценария.

## Integrations

Integration = тонкая обёртка над внешним API: собрать запрос, вызвать, вернуть ответ в формате провайдера (`shared/{provider}.types.ts`), без доменных DTO.

- HTTP-ошибки — `throw`. `ErrorCode` — только для статусов, которые API явно возвращает и которые вызывающий обрабатывает (`DIALOG_NOT_FOUND` на 404 у `DeleteAgentDialogRequest`).
- Вызывают глобальный `fetch` в момент запроса (тесты подменяют его `vi.stubGlobal`), с таймаутом `AbortSignal.timeout`. Вызовы к агенту идут через `callAgent` (`agent-api/shared/request.ts`): он добавляет токен и заголовки трассировки (`tracingHeaders()`, см. `app/AGENTS.md`), а сбой сети превращает в `AgentUnavailableError`.
- Состояния между запросами не хранят.

---

## БД и транзакции

- `getDb()` из `shared` — исполнитель запросов: общий пул (ленивый синглтон по `DATABASE_URL`) или транзакция текущего async-контекста.
- Границу транзакции задаёт **process**: `await inTransaction(async () => { …вызовы managers… })`. Managers внутри транзакции получают её через `getDb()` (AsyncLocalStorage) и ничего о ней не знают. Вложенный `inTransaction` присоединяется к внешнему. Границу знает только сценарий: manager не может решить за него, где заканчивается атомарность.
- Ранний выход с доменной ошибкой внутри транзакции — через возвращаемое значение колбэка (`return ErrorCode.X`), откат — через `throw`.
- `withSavepoint(fn)` — изолированный кусок внутри транзакции, ошибка которого не обрывает её.
- В сыром ``sql`…` `` drizzle не преобразует `Date` (сериализаторы дат драйвера прозрачные): передавай `date.toISOString()` с явным `::timestamptz`.
- Время сравнивается в JS (`new Date()` передаётся параметром), а не `now()` в SQL: тесты двигают часы через fake `Date`.

## Конфигурация

Схемы env, проверка при старте и правило новой переменной — в `app/AGENTS.md`, «Конфигурация сервера». Для ядра:

- Ядро читает env только через `getEnv()` (`config/env.ts`, проверка схемой `coreEnvSchema` при первом обращении): сроки и ключи — в `config.ts` модуля и `processes/config.ts`, одиночный секрет или флаг — `getEnv()` прямо в коде, которому он нужен (`dialog-shares/shared/share-token.ts`, вход в админку). БД и логи — исключения: `getDb()` читает `DATABASE_URL`, логгер — `LOG_LEVEL` и `APP_ENV` сами, чтобы тесты и миграции не требовали всего env.

## Логи и ПДн

Логгер, маскирование и заголовки трассировки в целом — `app/AGENTS.md`, «Логи» и «Заголовки трассировки». Для ядра:

- `createLogger('module-name')` из `shared`: `debug/info(message, data)`, `warn/error(message, error, data)`; уровень — `LOG_LEVEL`. Поля трассировки из `RequestContext` каждая запись внутри запроса получает сама: в вызове их не передают.
- В лог не пишем пароли, токены, коды OAuth, ссылки с токенами, тексты писем: поля контрактов помечены `@hasPII` (маски — в «Контракты и результаты»), параметры запросов из ошибок drizzle ядро вырезает само. Какие ещё ключи вырезать (`password`, `token`, заголовки…), ядро не решает: список задаёт приложение при старте через `configureLogger`. Идентификаторы (userId) логировать можно.

## Тесты

- `test/*.test.ts`, vitest, настоящий Postgres: у каждого прогона своя база из шаблона с применёнными миграциями (`packages/db/src/test-db.ts`; сервер и порядок запуска — скилл `local-dev`), `test/setup.ts` чистит таблицы перед каждым тестом. Файлы идут последовательно.
- Внешние HTTP — `mockFetch` из `test/helpers.ts` (`vi.stubGlobal('fetch')`), письма — транспорт `memory` (`getSentEmails()`), время — `travelBy` (подменяется только `Date`).
- Тест вызывает фасады так же, как приложения, и проверяет коды, данные и состояние БД.

## Как добавить операцию

1. Папка операции в нужном слое; контракт с `*Data` и `static readonly requestName`, типы с enum кодов, handler с `@requestHandler`, при необходимости валидатор.
2. Импорт handler-а и реэкспорты в `index.ts` модуля, контракт — в union.
3. Все отказы зависимостей — `switch` + `assertNever`.
4. Тест в `test/`. Если меняется публичный API — сначала контракт в `packages/contracts` и обе стороны (`app/AGENTS.md`, «Контракты»); поведение — через change в OpenSpec (скилл `openspec`).
