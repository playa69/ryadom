/**
 * The memory routes (`/api/memory...`) against the real core and a stubbed agent: who may call them,
 * what reaches the agent, how its answers become envelopes. Every text here is made up for the tests.
 */
import { asc, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { getDb } from '@ryadom/core/shared'
import { memoryConsentEvents, userConsents } from '@ryadom/db/schema'
import type { ListDialogsApiResponse } from '@ryadom/contracts/api/dialogs'
import {
  CreateMemoryFactApiErrorCode,
  DialogMemoryMode,
  ForgetMemoryApiErrorCode,
  MEMORY_CONSENT_VERSION,
  MemoryChangeOp,
  MemoryChangesApiErrorCode,
  MemoryChangesStatus,
  MemoryFactCategory,
  MemoryFactOrigin,
  MemoryFactStatus,
  MemoryInstructionApiErrorCode,
  MemoryServiceMode,
  UpdateMemoryFactApiErrorCode,
  UpdateMemorySettingsApiErrorCode,
  type MemoryApiResponse,
  type MemoryChangesApiResponse,
  type MemoryExportApiResponse,
  type MemoryFactApiResponse,
  type MemoryInstructionApiResponse,
  type UpdateMemorySettingsApiResponse,
} from '@ryadom/contracts/api/memory'
import { ApiPath, memoryFactPath } from '@ryadom/contracts/api/paths'
import { call, expectTransportError, json, makeApp, mockFetch, ok, refusedWith, signUpAndIn } from './helpers'

const { app, resetLimits } = makeApp()
const AGENT = 'http://agent.test/v1/users/*/memory'

function agentFact(overrides: Record<string, unknown> = {}) {
  return {
    id: 'f-1',
    category: 'person',
    text: 'Сестра Оля: поддерживает',
    slots: { role: 'сестра', name: 'Оля', note: 'поддерживает' },
    importance: 4,
    confidence: 0.9,
    status: 'active',
    origin: 'user_said',
    sensitivity: 'normal',
    sources: [{ dialogId: 'd-1', date: '2026-10-12' }],
    createdAt: '2026-10-12T10:00:00.000Z',
    updatedAt: '2026-10-12T10:05:00.000Z',
    lastConfirmedAt: null,
    expiresAt: null,
    confirmCount: 1,
    seenByUser: true,
    ...overrides,
  }
}

function agentError(status: number, code: string, details: unknown = null): Response {
  return json({ error: { code, message: 'отказ агента', details } }, status)
}

async function signedIn() {
  resetLimits()
  return signUpAndIn(app)
}

describe('доступ к памяти', () => {
  it('без токена — 401 на каждом маршруте, агента не зовут', async () => {
    resetLimits()
    const { calls } = mockFetch({})
    const routes: [string, string, unknown?][] = [
      ['GET', ApiPath.Memory],
      ['DELETE', ApiPath.Memory],
      ['PUT', ApiPath.MemorySettings, { enabled: false }],
      ['POST', ApiPath.MemoryFacts, { category: MemoryFactCategory.Goal, text: 'Выспаться' }],
      ['PATCH', memoryFactPath('f-1'), { confirm: true }],
      ['DELETE', memoryFactPath('f-1')],
      ['GET', `${ApiPath.MemoryChanges}?dialogId=d-1`],
      ['GET', ApiPath.MemoryExport],
    ]
    for (const [method, path, body] of routes) {
      const response = await app.request(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      await expectTransportError(response, 401)
    }
    expect(calls).toEqual([])
  })

  it('после выхода из сессии её access-токен память не читает', async () => {
    const { tokens } = await signedIn()
    const { calls } = mockFetch({ [`GET ${AGENT}`]: () => json({}) })

    ok(await call(app, 'POST', '/api/auth/logout', { refreshToken: tokens.refreshToken }))
    const response = await call(app, 'GET', ApiPath.Memory, undefined, tokens.accessToken)

    expect(response.status).toBe(401)
    expect(calls).toEqual([])
  })

  it('человек берётся только из токена: чужой id в теле и в запросе ни на что не влияет', async () => {
    const { user, tokens } = await signedIn()
    const { calls } = mockFetch({
      [`POST ${AGENT}/facts`]: () =>
        json(agentFact({ category: 'goal', text: 'Выспаться', slots: null }), 201),
      [`GET ${AGENT}/changes`]: () => json({ status: 'pending', reason: null, items: [] }),
    })

    ok(
      await call(
        app,
        'POST',
        ApiPath.MemoryFacts,
        { category: MemoryFactCategory.Goal, text: 'Выспаться', userId: 'someone-else' },
        tokens.accessToken,
      ),
    )
    ok(
      await call(
        app,
        'GET',
        `${ApiPath.MemoryChanges}?dialogId=d-1&userId=someone-else`,
        undefined,
        tokens.accessToken,
      ),
    )

    expect(calls.map((entry) => entry.url.pathname)).toEqual([
      `/v1/users/${user.id}/memory/facts`,
      `/v1/users/${user.id}/memory/changes`,
    ])
    expect(JSON.parse(calls[0]!.body)).toEqual({ category: 'goal', text: 'Выспаться' })
  })
})

describe('GET /api/memory', () => {
  it('отдаёт память в форме контракта: перечисления, даты ISO, слоты по категории', async () => {
    const { tokens } = await signedIn()
    mockFetch({
      [`GET ${AGENT}`]: () =>
        json({
          available: true,
          mode: 'shadow',
          enabled: true,
          consentVersion: MEMORY_CONSENT_VERSION,
          consentAt: '2026-10-12T09:00:00Z',
          rulesVersion: 'rules-1',
          limits: { maxFacts: 60 },
          facts: [
            agentFact(),
            // Slots a non-slot category should never have do not reach the app.
            agentFact({ id: 'f-2', category: 'works', text: 'Прогулки помогают', slots: { role: 'x' } }),
          ],
        }),
    })

    const memory = ok<MemoryApiResponse>(
      await call(app, 'GET', ApiPath.Memory, undefined, tokens.accessToken),
    )

    expect(memory).toMatchObject({
      available: true,
      mode: MemoryServiceMode.Shadow,
      enabled: true,
      consentVersion: MEMORY_CONSENT_VERSION,
      consentAt: '2026-10-12T09:00:00.000Z',
      rulesVersion: 'rules-1',
      limits: { maxFacts: 60 },
    })
    expect(memory.facts[0]).toEqual({
      id: 'f-1',
      category: MemoryFactCategory.Person,
      text: 'Сестра Оля: поддерживает',
      slots: { role: 'сестра', name: 'Оля', note: 'поддерживает' },
      importance: 4,
      confidence: 0.9,
      status: MemoryFactStatus.Active,
      origin: MemoryFactOrigin.UserSaid,
      sensitivity: 'normal',
      sources: [{ dialogId: 'd-1', date: '2026-10-12' }],
      createdAt: '2026-10-12T10:00:00.000Z',
      updatedAt: '2026-10-12T10:05:00.000Z',
      lastConfirmedAt: null,
      expiresAt: null,
      confirmCount: 1,
      seenByUser: true,
    })
    expect(memory.facts[1]!.slots).toBeNull()
  })

  it('агент недоступен — 503, как у диалогов', async () => {
    const { tokens } = await signedIn()
    mockFetch({ [`GET ${AGENT}`]: () => agentError(503, 'AGENT_INTERNAL') })
    const response = await app.request(ApiPath.Memory, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    })
    await expectTransportError(response, 503)
  })
})

describe('PUT /api/memory/settings', () => {
  const journal = (userId: string) =>
    getDb()
      .select()
      .from(memoryConsentEvents)
      .where(eq(memoryConsentEvents.userId, userId))
      .orderBy(asc(memoryConsentEvents.at))

  const memoryConsents = async (userId: string) =>
    (await getDb().select().from(userConsents).where(eq(userConsents.userId, userId))).filter(
      (row) => row.kind === 'memory',
    )

  function settingsAgent() {
    return mockFetch({
      [`PUT ${AGENT}/settings`]: ({ body }) => {
        const sent = JSON.parse(body) as { enabled: boolean; consentVersion: string | null }
        return json({
          enabled: sent.enabled,
          consentVersion: MEMORY_CONSENT_VERSION,
          consentAt: '2026-10-12T09:00:00Z',
        })
      },
    })
  }

  it('включение с согласием: запись согласия и журнала, агенту уходит версия', async () => {
    const { user, tokens } = await signedIn()
    const { calls } = settingsAgent()

    const result = ok<UpdateMemorySettingsApiResponse>(
      await call(
        app,
        'PUT',
        ApiPath.MemorySettings,
        { enabled: true, consentAccepted: true, consentVersion: MEMORY_CONSENT_VERSION },
        tokens.accessToken,
      ),
    )

    expect(result).toEqual({
      enabled: true,
      sensitiveEnabled: false,
      chatSearchEnabled: true,
      consentVersion: MEMORY_CONSENT_VERSION,
      consentAt: '2026-10-12T09:00:00.000Z',
    })
    expect(JSON.parse(calls.at(-1)!.body)).toEqual({ enabled: true, consentVersion: MEMORY_CONSENT_VERSION })
    expect((await memoryConsents(user.id)).map((row) => row.version)).toEqual([MEMORY_CONSENT_VERSION])
    expect((await journal(user.id)).map((row) => row.action)).toEqual(['granted'])

    ok(await call(app, 'PUT', ApiPath.MemorySettings, { enabled: false }, tokens.accessToken))
    expect(JSON.parse(calls.at(-1)!.body)).toEqual({ enabled: false, consentVersion: null })
    expect((await journal(user.id)).map((row) => row.action)).toEqual(['granted', 'revoked'])
  })

  it('без согласия — CONSENT_REQUIRED; версия не дата — 422; без enabled — 400', async () => {
    const { tokens } = await signedIn()
    const { calls } = settingsAgent()

    refusedWith(
      await call(
        app,
        'PUT',
        ApiPath.MemorySettings,
        { enabled: true, consentVersion: MEMORY_CONSENT_VERSION },
        tokens.accessToken,
      ),
      UpdateMemorySettingsApiErrorCode.CONSENT_REQUIRED,
    )
    refusedWith(
      await call(
        app,
        'PUT',
        ApiPath.MemorySettings,
        { enabled: true, consentAccepted: true },
        tokens.accessToken,
      ),
      UpdateMemorySettingsApiErrorCode.CONSENT_REQUIRED,
    )
    const notADate = await call(
      app,
      'PUT',
      ApiPath.MemorySettings,
      { enabled: true, consentAccepted: true, consentVersion: 'v2' },
      tokens.accessToken,
    )
    expect(notADate.status).toBe(422)
    const shapeless = await call(
      app,
      'PUT',
      ApiPath.MemorySettings,
      { consentAccepted: true },
      tokens.accessToken,
    )
    expect(shapeless.status).toBe(400)
    expect(calls).toEqual([])
  })

  it('отказы агента — коды контракта: MEMORY_UNAVAILABLE (503 агента), MEMORY_NOT_ALLOWED', async () => {
    const { tokens } = await signedIn()
    const body = { enabled: true, consentAccepted: true, consentVersion: MEMORY_CONSENT_VERSION }

    mockFetch({ [`PUT ${AGENT}/settings`]: () => agentError(503, 'MEMORY_UNAVAILABLE') })
    refusedWith(
      await call(app, 'PUT', ApiPath.MemorySettings, body, tokens.accessToken),
      UpdateMemorySettingsApiErrorCode.MEMORY_UNAVAILABLE,
    )

    mockFetch({ [`PUT ${AGENT}/settings`]: () => agentError(403, 'MEMORY_NOT_ALLOWED') })
    refusedWith(
      await call(app, 'PUT', ApiPath.MemorySettings, body, tokens.accessToken),
      UpdateMemorySettingsApiErrorCode.MEMORY_NOT_ALLOWED,
    )
  })
})

describe('факты', () => {
  it('POST: факт человека возвращается; слишком длинный текст — 422; лишний слот — 400', async () => {
    const { tokens } = await signedIn()
    const { calls } = mockFetch({
      [`POST ${AGENT}/facts`]: () =>
        json(
          agentFact({
            id: 'f-9',
            category: 'interest',
            text: 'Рисую',
            slots: null,
            status: 'pinned',
            origin: 'user_edit',
          }),
          201,
        ),
    })

    const fact = ok<MemoryFactApiResponse>(
      await call(
        app,
        'POST',
        ApiPath.MemoryFacts,
        { category: MemoryFactCategory.Interest, text: 'Рисую' },
        tokens.accessToken,
      ),
    )
    expect(fact).toMatchObject({
      id: 'f-9',
      status: MemoryFactStatus.Pinned,
      origin: MemoryFactOrigin.UserEdit,
    })

    const tooLong = await call(
      app,
      'POST',
      ApiPath.MemoryFacts,
      { category: MemoryFactCategory.Interest, text: 'а'.repeat(201) },
      tokens.accessToken,
    )
    expect(tooLong.status).toBe(422)
    const unknownSlot = await call(
      app,
      'POST',
      ApiPath.MemoryFacts,
      { category: MemoryFactCategory.Person, slots: { role: 'сестра', age: '30' } },
      tokens.accessToken,
    )
    expect(unknownSlot.status).toBe(400)
    expect(calls).toHaveLength(1)
  })

  it('POST: style и person уходят слотами без текста', async () => {
    const { tokens } = await signedIn()
    const { calls } = mockFetch({
      [`POST ${AGENT}/facts`]: () =>
        json(agentFact({ category: 'style', text: 'На «ты»', slots: { form: 'ty' } }), 201),
    })

    const fact = ok<MemoryFactApiResponse>(
      await call(
        app,
        'POST',
        ApiPath.MemoryFacts,
        { category: MemoryFactCategory.Style, slots: { form: 'ty', tone: 'soft' } },
        tokens.accessToken,
      ),
    )

    expect(JSON.parse(calls.at(-1)!.body)).toEqual({ category: 'style', slots: { form: 'ty', tone: 'soft' } })
    expect(fact.slots).toEqual({ form: 'ty' })
  })

  it('POST: форма по категории — 400 без вызова агента: style и person только слотами, остальные только текстом', async () => {
    const { tokens } = await signedIn()
    const { calls } = mockFetch({})
    for (const body of [
      { category: MemoryFactCategory.Person, text: 'Сестра Оля', slots: { role: 'сестра' } },
      { category: MemoryFactCategory.Person, text: 'Сестра Оля' },
      { category: MemoryFactCategory.Style },
      { category: MemoryFactCategory.Goal },
      { category: MemoryFactCategory.Goal, slots: { role: 'сестра' } },
    ]) {
      expect((await call(app, 'POST', ApiPath.MemoryFacts, body, tokens.accessToken)).status).toBe(400)
    }
    expect(calls).toEqual([])
  })

  it('POST: отказ правил — FACT_REJECTED, в errorMessage код правила и ни слова из факта', async () => {
    const { tokens } = await signedIn()
    mockFetch({ [`POST ${AGENT}/facts`]: () => agentError(422, 'FACT_REJECTED', { reason: 'contact_pii' }) })

    const result = await call(
      app,
      'POST',
      ApiPath.MemoryFacts,
      { category: MemoryFactCategory.Situation, text: 'Мой номер 8 900 000 00 00' },
      tokens.accessToken,
    )

    refusedWith(result, CreateMemoryFactApiErrorCode.FACT_REJECTED)
    const message = result.envelope.status ? '' : result.envelope.errorMessage
    expect(message).toContain('contact_pii')
    expect(message).not.toContain('900')
  })

  it('POST: MEMORY_DISABLED, MEMORY_FULL, MEMORY_UNAVAILABLE — отказы; AGENT_VALIDATION — 422', async () => {
    const { tokens } = await signedIn()
    const body = { category: MemoryFactCategory.Goal, text: 'Выспаться' }
    for (const [answer, code] of [
      [() => agentError(409, 'MEMORY_DISABLED'), CreateMemoryFactApiErrorCode.MEMORY_DISABLED],
      [() => agentError(409, 'MEMORY_FULL'), CreateMemoryFactApiErrorCode.MEMORY_FULL],
      [() => agentError(503, 'MEMORY_UNAVAILABLE'), CreateMemoryFactApiErrorCode.MEMORY_UNAVAILABLE],
    ] as const) {
      mockFetch({ [`POST ${AGENT}/facts`]: answer })
      refusedWith(await call(app, 'POST', ApiPath.MemoryFacts, body, tokens.accessToken), code)
    }
    mockFetch({ [`POST ${AGENT}/facts`]: () => agentError(422, 'AGENT_VALIDATION') })
    expect((await call(app, 'POST', ApiPath.MemoryFacts, body, tokens.accessToken)).status).toBe(422)
  })

  it('PATCH: «закрепить» уходит агенту как status: pinned; чужой факт — FACT_NOT_FOUND; пустое тело — 400', async () => {
    const { user, tokens } = await signedIn()
    const { calls } = mockFetch({ [`PATCH ${AGENT}/facts/*`]: () => json(agentFact({ status: 'pinned' })) })

    const fact = ok<MemoryFactApiResponse>(
      await call(
        app,
        'PATCH',
        memoryFactPath('f-1'),
        { status: MemoryFactStatus.Pinned },
        tokens.accessToken,
      ),
    )
    expect(fact.status).toBe(MemoryFactStatus.Pinned)
    expect(calls.at(-1)!.url.pathname).toBe(`/v1/users/${user.id}/memory/facts/f-1`)
    expect(JSON.parse(calls.at(-1)!.body)).toEqual({ status: 'pinned' })

    expect((await call(app, 'PATCH', memoryFactPath('f-1'), {}, tokens.accessToken)).status).toBe(400)
    expect(
      (
        await call(
          app,
          'PATCH',
          memoryFactPath('f-1'),
          { status: MemoryFactStatus.Expired },
          tokens.accessToken,
        )
      ).status,
    ).toBe(400)

    mockFetch({ [`PATCH ${AGENT}/facts/*`]: () => agentError(404, 'FACT_NOT_FOUND') })
    refusedWith(
      await call(app, 'PATCH', memoryFactPath('f-x'), { confirm: true }, tokens.accessToken),
      UpdateMemoryFactApiErrorCode.FACT_NOT_FOUND,
    )
  })

  it('DELETE факта и DELETE всей памяти: result null; MEMORY_UNAVAILABLE — отказ', async () => {
    const { user, tokens } = await signedIn()
    const { calls } = mockFetch({
      [`DELETE ${AGENT}/facts/*`]: () => new Response(null, { status: 204 }),
      [`DELETE ${AGENT}`]: () => new Response(null, { status: 204 }),
    })

    expect(ok(await call(app, 'DELETE', memoryFactPath('f-1'), undefined, tokens.accessToken))).toBeNull()
    expect(ok(await call(app, 'DELETE', ApiPath.Memory, undefined, tokens.accessToken))).toBeNull()
    expect(calls.map((entry) => `${entry.method} ${entry.url.pathname}`)).toEqual([
      `DELETE /v1/users/${user.id}/memory/facts/f-1`,
      `DELETE /v1/users/${user.id}/memory`,
    ])

    mockFetch({ [`DELETE ${AGENT}`]: () => agentError(503, 'MEMORY_UNAVAILABLE') })
    refusedWith(
      await call(app, 'DELETE', ApiPath.Memory, undefined, tokens.accessToken),
      ForgetMemoryApiErrorCode.MEMORY_UNAVAILABLE,
    )
  })
})

describe('карточка, выгрузка и журнал', () => {
  it('changes: без dialogId — 400; чужой диалог — DIALOG_NOT_FOUND; готовые изменения — в форме контракта', async () => {
    const { tokens } = await signedIn()

    expect((await call(app, 'GET', ApiPath.MemoryChanges, undefined, tokens.accessToken)).status).toBe(400)
    // The agent takes dialog ids of up to 64 characters: a longer one is refused here, not by it.
    const longId = await call(
      app,
      'GET',
      `${ApiPath.MemoryChanges}?dialogId=${'d'.repeat(65)}`,
      undefined,
      tokens.accessToken,
    )
    expect(longId.status).toBe(400)

    mockFetch({ [`GET ${AGENT}/changes`]: () => agentError(404, 'AGENT_DIALOG_NOT_FOUND') })
    refusedWith(
      await call(app, 'GET', `${ApiPath.MemoryChanges}?dialogId=d-x`, undefined, tokens.accessToken),
      MemoryChangesApiErrorCode.DIALOG_NOT_FOUND,
    )

    mockFetch({
      [`GET ${AGENT}/changes`]: () =>
        json({ status: 'ready', reason: null, items: [{ op: 'add', fact: agentFact() }] }),
    })
    const changes = ok<MemoryChangesApiResponse>(
      await call(app, 'GET', `${ApiPath.MemoryChanges}?dialogId=d-1`, undefined, tokens.accessToken),
    )
    expect(changes).toMatchObject({
      status: MemoryChangesStatus.Ready,
      reason: null,
      items: [{ op: MemoryChangeOp.Add, fact: { id: 'f-1', category: MemoryFactCategory.Person } }],
    })
  })

  it('export: всё, включая историю без текстов, датами ISO', async () => {
    const { tokens } = await signedIn()
    mockFetch({
      [`GET ${AGENT}/export`]: () =>
        json({
          exportedAt: '2026-10-12T12:00:00Z',
          rulesVersion: 'rules-1',
          settings: {
            enabled: true,
            consentVersion: MEMORY_CONSENT_VERSION,
            consentAt: null,
            epochAt: null,
            updatedAt: null,
          },
          facts: [agentFact({ status: 'proposed' })],
          events: [
            { factId: 'f-1', op: 'add', actor: 'extractor', dialogId: 'd-1', at: '2026-10-12T10:00:00Z' },
          ],
        }),
    })

    const exported = ok<MemoryExportApiResponse>(
      await call(app, 'GET', ApiPath.MemoryExport, undefined, tokens.accessToken),
    )
    expect(exported).toMatchObject({
      exportedAt: '2026-10-12T12:00:00.000Z',
      settings: { enabled: true, consentVersion: MEMORY_CONSENT_VERSION, consentAt: null },
      facts: [{ id: 'f-1', status: MemoryFactStatus.Proposed }],
      events: [
        { factId: 'f-1', op: 'add', actor: 'extractor', dialogId: 'd-1', at: '2026-10-12T10:00:00.000Z' },
      ],
    })
  })

  it('export ограничен по частоте: шестой за десять минут — 429', async () => {
    const { tokens } = await signedIn()
    mockFetch({
      [`GET ${AGENT}/export`]: () =>
        json({
          exportedAt: '2026-10-12T12:00:00Z',
          rulesVersion: 'rules-1',
          settings: { enabled: false, consentVersion: null, consentAt: null, epochAt: null, updatedAt: null },
          facts: [],
          events: [],
        }),
    })
    for (let attempt = 0; attempt < 5; attempt++) {
      ok(await call(app, 'GET', ApiPath.MemoryExport, undefined, tokens.accessToken))
    }
    expect((await call(app, 'GET', ApiPath.MemoryExport, undefined, tokens.accessToken)).status).toBe(429)
  })

  it('журнал диалогов помечает разговоры «без памяти»; у старого агента без поля — on', async () => {
    const { tokens } = await signedIn()
    mockFetch({
      'GET http://agent.test/v1/users/*/dialogs': () =>
        json({
          items: [
            {
              dialogId: 'd-2',
              startedAt: '2026-10-02T20:00:00Z',
              endedAt: null,
              summary: null,
              memoryMode: 'off',
            },
            { dialogId: 'd-1', startedAt: '2026-10-01T20:00:00Z', endedAt: null, summary: null },
          ],
          next: null,
        }),
    })

    const listed = ok<ListDialogsApiResponse>(
      await call(app, 'GET', ApiPath.Dialogs, undefined, tokens.accessToken),
    )
    expect(listed.items.map((item) => item.memoryMode)).toEqual([DialogMemoryMode.Off, DialogMemoryMode.On])
  })
})

describe('заметки, переключатели и «Скажи, что поправить»', () => {
  const note = (overrides: Record<string, unknown> = {}) => ({
    id: 'n-1',
    kind: 'situation',
    text: 'Работает в продажах',
    sensitive: false,
    eventDate: null,
    createdAt: '2026-10-25T10:00:00Z',
    updatedAt: '2026-10-25T10:00:00Z',
    dialogId: null,
    ...overrides,
  })

  it('GET отдаёт заметки, паузу, переключатели и лимит заметок; прежние facts на месте', async () => {
    const { tokens } = await signedIn()
    mockFetch({
      [`GET ${AGENT}`]: () =>
        json({
          available: true,
          mode: 'on',
          enabled: false,
          paused: true,
          sensitiveEnabled: true,
          chatSearchEnabled: false,
          consentVersion: MEMORY_CONSENT_VERSION,
          consentAt: '2026-10-12T09:00:00Z',
          rulesVersion: 'notes-1',
          limits: { maxFacts: 200, maxNotes: 200 },
          notes: [note(), note({ id: 'n-2', kind: 'wellbeing', text: 'Плохо спит', sensitive: true, eventDate: '2026-11-01' })],
          facts: [],
        }),
    })

    const memory = ok<MemoryApiResponse>(await call(app, 'GET', ApiPath.Memory, undefined, tokens.accessToken))

    expect(memory).toMatchObject({ paused: true, sensitiveEnabled: true, chatSearchEnabled: false })
    expect(memory.limits).toEqual({ maxFacts: 200, maxNotes: 200 })
    expect(memory.notes.map((n) => [n.id, n.kind, n.sensitive, n.eventDate])).toEqual([
      ['n-1', 'situation', false, null],
      ['n-2', 'wellbeing', true, '2026-11-01'],
    ])
  })

  it('старый агент без заметок: пауза следует за enabled, переключатели по умолчанию, notes пуст', async () => {
    const { tokens } = await signedIn()
    mockFetch({
      [`GET ${AGENT}`]: () =>
        json({
          available: true,
          mode: 'on',
          enabled: false,
          consentVersion: null,
          consentAt: null,
          rulesVersion: 'cognee',
          limits: { maxFacts: null },
          facts: [],
        }),
    })
    const memory = ok<MemoryApiResponse>(await call(app, 'GET', ApiPath.Memory, undefined, tokens.accessToken))
    expect(memory).toMatchObject({ paused: true, sensitiveEnabled: false, chatSearchEnabled: true, notes: [] })
    expect(memory.limits.maxFacts).toBe(200)
  })

  it('PUT только с переключателем не требует согласия и уходит агенту без enabled', async () => {
    const { tokens } = await signedIn()
    const { calls } = mockFetch({
      [`PUT ${AGENT}/settings`]: () =>
        json({ enabled: true, sensitiveEnabled: true, chatSearchEnabled: true, consentVersion: MEMORY_CONSENT_VERSION, consentAt: '2026-10-12T09:00:00Z' }),
    })
    const result = ok<UpdateMemorySettingsApiResponse>(
      await call(app, 'PUT', ApiPath.MemorySettings, { sensitiveEnabled: true }, tokens.accessToken),
    )
    expect(result.sensitiveEnabled).toBe(true)
    expect(JSON.parse(calls.at(-1)!.body)).toEqual({ consentVersion: null, sensitiveEnabled: true })
  })

  it('PUT без полей — 400', async () => {
    const { tokens } = await signedIn()
    const { calls } = mockFetch({})
    const response = await call(app, 'PUT', ApiPath.MemorySettings, {}, tokens.accessToken)
    expect(response.status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it('«Скажи, что поправить»: просьба уходит агенту, ответ — что изменено; пустой текст — 400; память выключена — отказ', async () => {
    const { user, tokens } = await signedIn()
    const { calls } = mockFetch({
      [`POST ${AGENT}/notes/instruction`]: () =>
        json({ changes: { added: [], updated: [note({ text: 'Работает в продажах уже год' })], deleted: ['n-9'], blocked: ['medication'] } }),
    })
    const done = ok<MemoryInstructionApiResponse>(
      await call(app, 'POST', ApiPath.MemoryInstruction, { text: 'Убери тему про отца' }, tokens.accessToken),
    )
    expect(done.deleted).toEqual(['n-9'])
    expect(done.updated.map((n) => n.text)).toEqual(['Работает в продажах уже год'])
    expect(done.blocked).toEqual(['medication'])
    expect(calls.at(-1)!.url.pathname).toBe(`/v1/users/${user.id}/memory/notes/instruction`)
    expect(JSON.parse(calls.at(-1)!.body)).toEqual({ text: 'Убери тему про отца' })

    expect((await call(app, 'POST', ApiPath.MemoryInstruction, { text: '   ' }, tokens.accessToken)).status).toBe(400)

    mockFetch({ [`POST ${AGENT}/notes/instruction`]: () => agentError(409, 'MEMORY_DISABLED') })
    refusedWith(
      await call(app, 'POST', ApiPath.MemoryInstruction, { text: 'Убери тему' }, tokens.accessToken),
      MemoryInstructionApiErrorCode.MEMORY_DISABLED,
    )
    mockFetch({ [`POST ${AGENT}/notes/instruction`]: () => agentError(503, 'MEMORY_UNAVAILABLE') })
    refusedWith(
      await call(app, 'POST', ApiPath.MemoryInstruction, { text: 'Убери тему' }, tokens.accessToken),
      MemoryInstructionApiErrorCode.MEMORY_UNAVAILABLE,
    )
  })
})
