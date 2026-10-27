/**
 * The agent's memory through the core: the consent to it and its journal, the agent's answers told
 * apart by their codes, the shape of what comes back. The agent itself is stubbed through fetch.
 * Every text here is made up for the tests.
 */
import { randomUUID } from 'node:crypto'
import { asc, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import {
  MEMORY_CONSENT_ACTIONS,
  OPTIONAL_CONSENT_KINDS,
  USER_CONSENT_KINDS,
  memoryConsentEvents,
  userConsents,
} from '@ryadom/db/schema'
import { AgentUnavailableError, getDb, maskPIIRecursively, ValidationError } from '../src/shared'
import {
  ExportMemoryOperation,
  ForgetMemoryFactOperation,
  ForgetMemoryFactOperationErrorCode,
  ForgetMemoryOperation,
  ForgetMemoryOperationErrorCode,
  GetMemoryChangesOperation,
  GetMemoryChangesOperationErrorCode,
  GetMemoryOperation,
  GetMemoryOperationErrorCode,
  memoryProcess,
  UpdateMemoryFactOperation,
  UpdateMemoryFactOperationErrorCode,
  UpdateMemorySettingsOperation,
  UpdateMemorySettingsOperationErrorCode,
} from '../src/processes/memory'
import { GetConsentStatusOperation, consentsProcess } from '../src/processes/consents'
import { StartDialogOperation, StartDialogOperationErrorCode, dialogsProcess } from '../src/processes/dialogs'
import { DeleteAccountOperation, accountDeletionProcess } from '../src/processes/account-deletion'
import {
  OFFER_VERSION,
  acceptConsents,
  json,
  mockAgent,
  mockFetch,
  noContent,
  registerConfirmedUser,
} from './helpers'

const MEMORY_VERSION = '2026-10-12'
const AGENT = 'http://agent.test/v1/users/*/memory'

function agentFact(overrides: Record<string, unknown> = {}) {
  return {
    id: 'f-1',
    category: 'works',
    text: 'Прогулки у воды помогают',
    slots: null,
    importance: 4,
    confidence: 0.9,
    status: 'active',
    origin: 'auto',
    sensitivity: 'normal',
    sources: [{ dialogId: 'd-1', date: '2026-10-12' }],
    createdAt: '2026-10-12T10:00:00.000Z',
    updatedAt: '2026-10-12T10:05:00.000Z',
    expiresAt: '2027-10-12T00:00:00.000Z',
    seenByUser: false,
    ...overrides,
  }
}

function agentNote(overrides: Record<string, unknown> = {}) {
  return {
    id: 'n-1',
    kind: 'interest',
    text: 'Прогулки у воды помогают',
    sensitive: false,
    eventDate: null,
    createdAt: '2026-10-12T10:00:00.000Z',
    updatedAt: '2026-10-12T10:05:00.000Z',
    dialogId: 'd-1',
    ...overrides,
  }
}

function agentMemory(overrides: Record<string, unknown> = {}) {
  return {
    available: true,
    mode: 'on',
    enabled: true,
    consentVersion: MEMORY_VERSION,
    consentAt: '2026-10-12T09:00:00.000Z',
    rulesVersion: 'rules-1',
    limits: { maxFacts: 60 },
    facts: [agentFact()],
    ...overrides,
  }
}

/** The agent's error body: `{ error: { code, message, details } }`. */
function agentError(status: number, code: string, details: unknown = null): Response {
  return json({ error: { code, message: 'отказ агента', details } }, status)
}

const settings = (
  userId: string,
  data: { enabled: boolean; consentAccepted?: boolean; consentVersion?: string | null } = { enabled: true },
) =>
  memoryProcess.execute(
    new UpdateMemorySettingsOperation({
      userId,
      enabled: data.enabled,
      consentAccepted: data.consentAccepted ?? data.enabled,
      consentVersion:
        data.consentVersion === undefined ? (data.enabled ? MEMORY_VERSION : null) : data.consentVersion,
    }),
  )

/** The agent answering the switch the way the real one does. */
function settingsAgent() {
  return mockFetch({
    [`PUT ${AGENT}/settings`]: ({ body }) => {
      const sent = JSON.parse(body) as { enabled: boolean; consentVersion: string | null }
      return json({
        enabled: sent.enabled,
        consentVersion: sent.consentVersion ?? MEMORY_VERSION,
        consentAt: '2026-10-12T09:00:00.000Z',
      })
    },
  })
}

const consentRows = (userId: string) =>
  getDb().select().from(userConsents).where(eq(userConsents.userId, userId))

const journal = (userId: string) =>
  getDb()
    .select()
    .from(memoryConsentEvents)
    .where(eq(memoryConsentEvents.userId, userId))
    .orderBy(asc(memoryConsentEvents.at))

const DELETED_OR_MISSING = '00000000-0000-4000-8000-000000000000'

describe('согласие на память не обязательное (ловушка MEM-11.3)', () => {
  it('memory нет среди обязательных согласий первого экрана, наборы не пересекаются', () => {
    expect(USER_CONSENT_KINDS).not.toContain('memory')
    expect(OPTIONAL_CONSENT_KINDS).toEqual(['memory', 'self_check'])
    for (const kind of OPTIONAL_CONSENT_KINDS) expect(USER_CONSENT_KINDS).not.toContain(kind)
    expect(MEMORY_CONSENT_ACTIONS).toEqual(['granted', 'revoked', 'paused', 'resumed'])
  })

  it('принятие первого экрана не записывает согласие на память', async () => {
    const user = await registerConfirmedUser()
    const kinds = (await consentRows(user.id)).map((row) => row.kind).sort()
    expect(kinds).toEqual(['age_confirmed', 'disclaimer', 'offer'])
  })

  it('без обязательных согласий одно согласие на память не открывает разговор и не делает статус полным', async () => {
    const { calls } = mockAgent()
    const user = await registerConfirmedUser({ consents: false })
    await getDb()
      .insert(userConsents)
      .values({ id: randomUUID(), userId: user.id, kind: 'memory', version: MEMORY_VERSION })

    const status = await consentsProcess.execute(new GetConsentStatusOperation({ userId: user.id }))
    expect(status.status).toEqual({ completed: false, offerVersion: null })
    expect(await dialogsProcess.execute(new StartDialogOperation({ userId: user.id }))).toEqual({
      success: false,
      error: StartDialogOperationErrorCode.CONSENT_REQUIRED,
    })
    expect(calls).toHaveLength(0)
  })

  it('с обязательными согласиями наличие или отсутствие memory ничего не меняет: статус и разговор те же', async () => {
    mockAgent()
    const without = await registerConfirmedUser()
    const withMemory = await registerConfirmedUser()
    // Newer than the terms on purpose: the version of the terms must not be taken from it.
    await getDb()
      .insert(userConsents)
      .values({ id: randomUUID(), userId: withMemory.id, kind: 'memory', version: '2099-01-01' })

    for (const user of [without, withMemory]) {
      const status = await consentsProcess.execute(new GetConsentStatusOperation({ userId: user.id }))
      expect(status.status).toEqual({ completed: true, offerVersion: OFFER_VERSION })
      expect((await dialogsProcess.execute(new StartDialogOperation({ userId: user.id }))).success).toBe(true)
    }
  })

  it('включение памяти не трогает обязательные согласия: их по-прежнему три', async () => {
    settingsAgent()
    const user = await registerConfirmedUser()
    await settings(user.id)
    await acceptConsents(user.id)

    const kinds = (await consentRows(user.id)).map((row) => row.kind).sort()
    expect(kinds).toEqual(['age_confirmed', 'disclaimer', 'memory', 'offer'])
    const status = await consentsProcess.execute(new GetConsentStatusOperation({ userId: user.id }))
    expect(status.status).toEqual({ completed: true, offerVersion: OFFER_VERSION })
  })
})

describe('включение и выключение памяти', () => {
  it('без принятого листа согласия или без версии — CONSENT_REQUIRED, ничего не пишется, агента не зовут', async () => {
    const { calls } = settingsAgent()
    const user = await registerConfirmedUser()

    for (const data of [
      { enabled: true, consentAccepted: false },
      { enabled: true, consentAccepted: true, consentVersion: null },
    ]) {
      expect(await settings(user.id, data)).toEqual({
        success: false,
        error: UpdateMemorySettingsOperationErrorCode.CONSENT_REQUIRED,
      })
    }
    expect((await consentRows(user.id)).filter((row) => row.kind === 'memory')).toHaveLength(0)
    expect(await journal(user.id)).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })

  it('версия не в виде даты отвергается до записи', async () => {
    settingsAgent()
    const user = await registerConfirmedUser()
    await expect(settings(user.id, { enabled: true, consentVersion: 'latest' })).rejects.toBeInstanceOf(
      ValidationError,
    )
    expect(await journal(user.id)).toHaveLength(0)
  })

  it('включение: согласие memory с версией и строка granted пишутся до вызова агента; агенту уходит версия', async () => {
    const { calls } = settingsAgent()
    const user = await registerConfirmedUser()

    const result = await settings(user.id)

    expect(result).toEqual({
      success: true,
      settings: {
        enabled: true,
        sensitiveEnabled: false,
        chatSearchEnabled: true,
        consentVersion: MEMORY_VERSION,
        consentAt: new Date('2026-10-12T09:00:00.000Z'),
      },
    })
    const memoryConsent = (await consentRows(user.id)).filter((row) => row.kind === 'memory')
    expect(memoryConsent.map((row) => row.version)).toEqual([MEMORY_VERSION])
    expect((await journal(user.id)).map((row) => [row.action, row.version])).toEqual([
      ['granted', MEMORY_VERSION],
    ])
    expect(calls.at(-1)!.url.pathname).toBe(`/v1/users/${user.id}/memory/settings`)
    expect(JSON.parse(calls.at(-1)!.body)).toEqual({ enabled: true, consentVersion: MEMORY_VERSION })
  })

  it('повторное включение той же версии не падает на уникальности и не плодит строк', async () => {
    settingsAgent()
    const user = await registerConfirmedUser()

    expect((await settings(user.id)).success).toBe(true)
    expect((await settings(user.id)).success).toBe(true)

    expect((await consentRows(user.id)).filter((row) => row.kind === 'memory')).toHaveLength(1)
    expect(await journal(user.id)).toHaveLength(1)
  })

  it('выключение — пауза: след paused с датой и версией, согласие не отзывается; повтор и выключение без согласия следа не оставляют', async () => {
    const { calls } = settingsAgent()
    const user = await registerConfirmedUser()
    const never = await registerConfirmedUser()

    await settings(user.id)
    expect((await settings(user.id, { enabled: false })).success).toBe(true)
    expect((await settings(user.id, { enabled: false })).success).toBe(true)
    expect((await settings(never.id, { enabled: false })).success).toBe(true)

    const rows = await journal(user.id)
    expect(rows.map((row) => [row.action, row.version])).toEqual([
      ['granted', MEMORY_VERSION],
      ['paused', MEMORY_VERSION],
    ])
    expect(rows[1]!.at).toBeInstanceOf(Date)
    expect(await journal(never.id)).toHaveLength(0)
    // Turning off sends no version, and the consent rows stay as the evidence.
    expect(JSON.parse(calls.at(-1)!.body)).toEqual({ enabled: false, consentVersion: null })
    expect((await consentRows(user.id)).filter((row) => row.kind === 'memory')).toHaveLength(1)
  })

  it('включение после паузы — строка resumed, а с новой версией листа — новое согласие granted', async () => {
    settingsAgent()
    const user = await registerConfirmedUser()

    await settings(user.id)
    await settings(user.id, { enabled: false })
    await settings(user.id)
    await settings(user.id, { enabled: true, consentVersion: '2027-01-15' })

    expect((await journal(user.id)).map((row) => [row.action, row.version])).toEqual([
      ['granted', MEMORY_VERSION],
      ['paused', MEMORY_VERSION],
      ['resumed', MEMORY_VERSION],
      ['granted', '2027-01-15'],
    ])
    const versions = (await consentRows(user.id))
      .filter((row) => row.kind === 'memory')
      .map((row) => row.version)
      .sort()
    expect(versions).toEqual([MEMORY_VERSION, '2027-01-15'])
  })

  it('MEMORY_UNAVAILABLE (503) — отказ, а не «агент лёг»; согласие остаётся записанным', async () => {
    mockFetch({ [`PUT ${AGENT}/settings`]: () => agentError(503, 'MEMORY_UNAVAILABLE') })
    const user = await registerConfirmedUser()

    expect(await settings(user.id)).toEqual({
      success: false,
      error: UpdateMemorySettingsOperationErrorCode.MEMORY_UNAVAILABLE,
    })
    expect((await consentRows(user.id)).filter((row) => row.kind === 'memory')).toHaveLength(1)
  })

  it('503 с другим кодом (AGENT_INTERNAL), 500 и сеть — AgentUnavailableError', async () => {
    const user = await registerConfirmedUser()
    for (const answer of [
      () => agentError(503, 'AGENT_INTERNAL'),
      () => agentError(500, 'AGENT_INTERNAL'),
      () => new Response('<html>bad gateway</html>', { status: 502 }),
      () => {
        throw new TypeError('fetch failed')
      },
    ]) {
      mockFetch({ [`PUT ${AGENT}/settings`]: answer })
      await expect(settings(user.id)).rejects.toBeInstanceOf(AgentUnavailableError)
    }
  })

  it('удалённому и несуществующему — USER_NOT_FOUND, и агента не зовут', async () => {
    const { calls } = settingsAgent()
    expect(await settings(DELETED_OR_MISSING)).toEqual({
      success: false,
      error: UpdateMemorySettingsOperationErrorCode.USER_NOT_FOUND,
    })
    expect(calls).toHaveLength(0)
  })

  it('журнал согласия на память переживает удаление аккаунта, как и user_consents', async () => {
    settingsAgent()
    const user = await registerConfirmedUser()
    await settings(user.id)
    await settings(user.id, { enabled: false })

    mockAgent()
    expect(
      (await accountDeletionProcess.execute(new DeleteAccountOperation({ userId: user.id }))).success,
    ).toBe(true)

    // The pause stays in force until the account ends, and the end is written down in the same journal.
    expect((await journal(user.id)).map((row) => row.action)).toEqual(['granted', 'paused', 'revoked'])
    expect((await consentRows(user.id)).filter((row) => row.kind === 'memory')).toHaveLength(1)
  })
})

describe('что помнит агент', () => {
  it('агент на Cognee без лимита фактов (maxFacts: null) — экран получает число, а не 500', async () => {
    const user = await registerConfirmedUser()
    mockFetch({ [`GET ${AGENT}`]: () => json(agentMemory({ limits: { maxFacts: null }, facts: [] })) })

    const result = await memoryProcess.execute(new GetMemoryOperation({ userId: user.id }))

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.memory.maxFacts).toBe(200)
  })

  it('факты приходят с датами, разобранными из строк; путь к агенту — по пользователю', async () => {
    const user = await registerConfirmedUser()
    const { calls } = mockFetch({ [`GET ${AGENT}`]: () => json(agentMemory()) })

    const result = await memoryProcess.execute(new GetMemoryOperation({ userId: user.id }))

    expect(calls.at(-1)!.url.pathname).toBe(`/v1/users/${user.id}/memory`)
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.memory).toMatchObject({
      available: true,
      enabled: true,
      consentVersion: MEMORY_VERSION,
      consentAt: new Date('2026-10-12T09:00:00.000Z'),
      maxFacts: 60,
    })
    expect(result.memory.facts).toEqual([
      {
        id: 'f-1',
        category: 'works',
        text: 'Прогулки у воды помогают',
        slots: null,
        importance: 4,
        confidence: 0.9,
        status: 'active',
        origin: 'auto',
        sensitivity: 'normal',
        sources: [{ dialogId: 'd-1', date: '2026-10-12' }],
        createdAt: new Date('2026-10-12T10:00:00.000Z'),
        updatedAt: new Date('2026-10-12T10:05:00.000Z'),
        expiresAt: new Date('2027-10-12T00:00:00.000Z'),
        seenByUser: false,
      },
    ])
  })

  it('факт неизвестной формы выпадает, остальные приходят; лишние поля агента не проходят', async () => {
    const user = await registerConfirmedUser()
    mockFetch({
      [`GET ${AGENT}`]: () =>
        json(
          agentMemory({
            facts: [
              agentFact({ id: 'f-bad', category: 'personality' }),
              agentFact({ id: 'f-ok', internalScore: 17, slots: { role: 'сестра', name: 'Оля', extra: 1 } }),
            ],
          }),
        ),
    })

    const result = await memoryProcess.execute(new GetMemoryOperation({ userId: user.id }))
    expect(result.success && result.memory.facts.map((fact) => fact.id)).toEqual(['f-ok'])
    expect(result.success && result.memory.facts[0]).not.toHaveProperty('internalScore')
    expect(result.success && result.memory.facts[0]!.slots).toEqual({ role: 'сестра', name: 'Оля' })
  })

  it('ответ агента не той формы — ошибка, а не пустая память', async () => {
    const user = await registerConfirmedUser()
    mockFetch({ [`GET ${AGENT}`]: () => json({ facts: [] }) })
    await expect(memoryProcess.execute(new GetMemoryOperation({ userId: user.id }))).rejects.toThrow(
      /malformed/,
    )
  })

  it('удалённому — USER_NOT_FOUND без вызова агента', async () => {
    const { calls } = mockFetch({ [`GET ${AGENT}`]: () => json(agentMemory()) })
    expect(await memoryProcess.execute(new GetMemoryOperation({ userId: DELETED_OR_MISSING }))).toEqual({
      success: false,
      error: GetMemoryOperationErrorCode.USER_NOT_FOUND,
    })
    expect(calls).toHaveLength(0)
  })
})

describe('правка заметки', () => {
  const update = (userId: string, text = 'Гуляю по вечерам') =>
    memoryProcess.execute(new UpdateMemoryFactOperation({ userId, factId: 'n-1', text }))

  it('агенту уходит только текст, путь — к заметке этого человека, ответ — заметка в форме факта', async () => {
    const user = await registerConfirmedUser()
    const { calls } = mockFetch({
      [`PATCH ${AGENT}/notes/*`]: () => json(agentNote({ text: 'Гуляю по вечерам' })),
    })

    expect(await update(user.id, '  Гуляю по вечерам  ')).toMatchObject({
      success: true,
      fact: { id: 'n-1', category: 'interest', text: 'Гуляю по вечерам', status: 'active', sources: [{ dialogId: 'd-1' }] },
    })
    expect(calls.at(-1)!.url.pathname).toBe(`/v1/users/${user.id}/memory/notes/n-1`)
    expect(JSON.parse(calls.at(-1)!.body)).toEqual({ text: 'Гуляю по вечерам' })
  })

  it('чужая или забытая заметка — FACT_NOT_FOUND; отказы по кодам, а не по статусу', async () => {
    const user = await registerConfirmedUser()
    const cases: [() => Response, unknown][] = [
      [() => agentError(404, 'NOTE_NOT_FOUND'), { error: UpdateMemoryFactOperationErrorCode.FACT_NOT_FOUND }],
      [
        () => agentError(422, 'NOTE_REJECTED', { reason: 'diagnosis' }),
        { error: UpdateMemoryFactOperationErrorCode.FACT_REJECTED, reason: 'diagnosis' },
      ],
      [
        () => agentError(503, 'MEMORY_UNAVAILABLE'),
        { error: UpdateMemoryFactOperationErrorCode.MEMORY_UNAVAILABLE },
      ],
      [() => agentError(422, 'AGENT_VALIDATION'), { error: UpdateMemoryFactOperationErrorCode.INVALID_FACT }],
    ]
    for (const [answer, expected] of cases) {
      mockFetch({ [`PATCH ${AGENT}/notes/*`]: answer })
      expect(await update(user.id)).toEqual({ success: false, ...(expected as object) })
    }
  })

  it('причина отказа, похожая на текст, а не на код, не пропускается дальше', async () => {
    const user = await registerConfirmedUser()
    mockFetch({
      [`PATCH ${AGENT}/notes/*`]: () => agentError(422, 'NOTE_REJECTED', { reason: 'Мой номер 8 900 000 00 00' }),
    })
    expect(await update(user.id)).toEqual({
      success: false,
      error: UpdateMemoryFactOperationErrorCode.FACT_REJECTED,
      reason: null,
    })
  })

  it('404 без кода NOTE_NOT_FOUND (нет такого маршрута у агента) — ошибка, а не «заметка не найдена»', async () => {
    const user = await registerConfirmedUser()
    mockFetch({ [`PATCH ${AGENT}/notes/*`]: () => agentError(404, 'AGENT_VALIDATION') })
    await expect(update(user.id)).rejects.toThrow()
  })

  it('неизвестный отказ агента — ошибка, и в её тексте нет текста заметки', async () => {
    const user = await registerConfirmedUser()
    mockFetch({ [`PATCH ${AGENT}/notes/*`]: () => agentError(418, 'SOMETHING_NEW') })
    const error = await update(user.id, 'Секретная строка для проверки').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(Error)
    expect(String((error as Error).message)).not.toContain('Секретная')
  })

  it('пустой и слишком длинный текст ядро не пропускает, агента не зовут', async () => {
    const user = await registerConfirmedUser()
    const { calls } = mockFetch({})
    await expect(update(user.id, '   ')).rejects.toBeInstanceOf(ValidationError)
    await expect(update(user.id, 'а'.repeat(201))).rejects.toBeInstanceOf(ValidationError)
    expect(calls).toHaveLength(0)
  })

  it('удалённому — USER_NOT_FOUND без вызова агента', async () => {
    const { calls } = mockFetch({})
    expect(await update(DELETED_OR_MISSING)).toEqual({
      success: false,
      error: UpdateMemoryFactOperationErrorCode.USER_NOT_FOUND,
    })
    expect(calls).toHaveLength(0)
  })

  it('текст помечен как ПДн: в журнал запроса он не попадает', () => {
    const masked = JSON.stringify(
      maskPIIRecursively(new UpdateMemoryFactOperation({ userId: 'u-1', factId: 'n-1', text: 'Секретная строка' })),
    )
    expect(masked).not.toContain('Секретная')
  })
})

describe('«Забыть» и «Забыть всё»', () => {
  it('заметка: 204 и повтор (404) — успех; MEMORY_UNAVAILABLE — отказ; 503 с другим кодом — агент недоступен', async () => {
    const user = await registerConfirmedUser()
    const forget = () =>
      memoryProcess.execute(new ForgetMemoryFactOperation({ userId: user.id, factId: 'f-1' }))

    const { calls } = mockFetch({ [`DELETE ${AGENT}/notes/*`]: () => noContent() })
    expect(await forget()).toEqual({ success: true })
    expect(calls.at(-1)!.url.pathname).toBe(`/v1/users/${user.id}/memory/notes/f-1`)

    mockFetch({ [`DELETE ${AGENT}/notes/*`]: () => agentError(404, 'NOTE_NOT_FOUND') })
    expect(await forget()).toEqual({ success: true })

    mockFetch({ [`DELETE ${AGENT}/notes/*`]: () => agentError(503, 'MEMORY_UNAVAILABLE') })
    expect(await forget()).toEqual({
      success: false,
      error: ForgetMemoryFactOperationErrorCode.MEMORY_UNAVAILABLE,
    })

    mockFetch({ [`DELETE ${AGENT}/notes/*`]: () => agentError(503, 'AGENT_INTERNAL') })
    await expect(forget()).rejects.toBeInstanceOf(AgentUnavailableError)
  })

  it('всё: 204 — успех, MEMORY_UNAVAILABLE — отказ, согласие и журнал не трогаются', async () => {
    settingsAgent()
    const user = await registerConfirmedUser()
    await settings(user.id)
    const forgetAll = () => memoryProcess.execute(new ForgetMemoryOperation({ userId: user.id }))

    const { calls } = mockFetch({ [`DELETE ${AGENT}`]: () => noContent() })
    expect(await forgetAll()).toEqual({ success: true })
    expect(calls.at(-1)!.url.pathname).toBe(`/v1/users/${user.id}/memory`)

    mockFetch({ [`DELETE ${AGENT}`]: () => agentError(503, 'MEMORY_UNAVAILABLE') })
    expect(await forgetAll()).toEqual({
      success: false,
      error: ForgetMemoryOperationErrorCode.MEMORY_UNAVAILABLE,
    })

    expect(await journal(user.id)).toHaveLength(1)
    expect((await consentRows(user.id)).filter((row) => row.kind === 'memory')).toHaveLength(1)
  })
})

describe('карточка «Я запомнил» и выгрузка', () => {
  it('changes: dialogId уходит параметром, факты — в текущем виде', async () => {
    const user = await registerConfirmedUser()
    const { calls } = mockFetch({
      [`GET ${AGENT}/changes`]: () =>
        json({ status: 'ready', reason: null, items: [{ op: 'add', fact: agentFact() }] }),
    })

    const result = await memoryProcess.execute(
      new GetMemoryChangesOperation({ userId: user.id, dialogId: 'd 1' }),
    )

    expect(calls.at(-1)!.url.pathname).toBe(`/v1/users/${user.id}/memory/changes`)
    expect(calls.at(-1)!.url.searchParams.get('dialogId')).toBe('d 1')
    expect(result).toMatchObject({
      success: true,
      changes: { status: 'ready', items: [{ op: 'add', fact: { id: 'f-1' } }] },
    })
  })

  it('pending и skipped приходят как есть', async () => {
    const user = await registerConfirmedUser()
    mockFetch({ [`GET ${AGENT}/changes`]: () => json({ status: 'skipped', reason: 'too_short', items: [] }) })
    expect(
      await memoryProcess.execute(new GetMemoryChangesOperation({ userId: user.id, dialogId: 'd-1' })),
    ).toEqual({
      success: true,
      changes: { status: 'skipped', reason: 'too_short', items: [] },
    })
  })

  it('чужой или несуществующий диалог — DIALOG_NOT_FOUND', async () => {
    const user = await registerConfirmedUser()
    mockFetch({ [`GET ${AGENT}/changes`]: () => agentError(404, 'AGENT_DIALOG_NOT_FOUND') })
    expect(
      await memoryProcess.execute(new GetMemoryChangesOperation({ userId: user.id, dialogId: 'd-x' })),
    ).toEqual({
      success: false,
      error: GetMemoryChangesOperationErrorCode.DIALOG_NOT_FOUND,
    })
  })

  it('выгрузка: настройки, все факты и история без текстов', async () => {
    const user = await registerConfirmedUser()
    mockFetch({
      [`GET ${AGENT}/export`]: () =>
        json({
          exportedAt: '2026-10-12T12:00:00.000Z',
          rulesVersion: 'rules-1',
          settings: {
            enabled: false,
            consentVersion: MEMORY_VERSION,
            consentAt: '2026-10-12T09:00:00.000Z',
            epochAt: '2026-10-12T11:00:00.000Z',
            updatedAt: '2026-10-12T11:00:00.000Z',
          },
          facts: [agentFact({ status: 'candidate' })],
          events: [
            { factId: 'f-1', op: 'add', actor: 'extractor', dialogId: 'd-1', at: '2026-10-12T10:00:00.000Z' },
          ],
        }),
    })

    const result = await memoryProcess.execute(new ExportMemoryOperation({ userId: user.id }))

    expect(result).toMatchObject({
      success: true,
      export: {
        exportedAt: new Date('2026-10-12T12:00:00.000Z'),
        settings: { enabled: false, epochAt: new Date('2026-10-12T11:00:00.000Z') },
        facts: [{ id: 'f-1', status: 'candidate' }],
        events: [{ factId: 'f-1', op: 'add', actor: 'extractor', at: new Date('2026-10-12T10:00:00.000Z') }],
      },
    })
  })
})
