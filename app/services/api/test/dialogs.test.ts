/**
 * Dialogs: REST and the WebSocket gateway against an agent started inside the test.
 */
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import opus from '@evan/opus/wasm/index.js'
import { serve } from '@hono/node-server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import {
  DialogApiErrorCode,
  DialogClientFrame,
  DialogCloseCode,
  DialogMode,
  DialogServerFrame,
  DialogWsErrorCode,
  SafetyLevel,
  DialogRecapApiErrorCode,
  type DeleteDialogApiResponse,
  type DialogSettingsApiResponse,
  type DraftDialogRecapApiResponse,
  type EndDialogApiResponse,
  type ListDialogRecapsApiResponse,
  type ListDialogsApiResponse,
  type PutDialogRecapApiResponse,
  type StartDialogApiResponse,
} from '@ryadom/contracts/api/dialogs'
import { DialogMemoryMode } from '@ryadom/contracts/api/memory'
import { ApiPath } from '@ryadom/contracts/api/paths'
import { eq } from 'drizzle-orm'
import { diarySummaries } from '@ryadom/db/schema'
import { diaryProcess } from '@ryadom/core/processes/diary'
import { getEnqueuedJobs } from '@ryadom/core/services/job-queue-service'
import { getDb } from '@ryadom/core/shared'
import { afterDeleteJob } from '../src/jobs/after-delete'
import { closeAllDialogSessions, handleDialogSocket } from '../src/dialogs/gateway'
import { resetDraining, startDraining } from '../src/lib/lifecycle'
import { createJwt } from '../src/lib/jwt'
import { createSessions } from '../src/lib/sessions'
import { parseEnv } from '../src/lib/env'
import {
  PASSWORD,
  call,
  json,
  makeApp,
  mockAgent,
  ok,
  recordingAnalytics,
  refusedWith,
  signUpAndIn,
} from './helpers'

const { app, resetLimits } = makeApp()

/** The dialog events reported for a person: signing up reports others, which are not what these tests look at. */
const dialogEvents = (analytics: ReturnType<typeof recordingAnalytics>, userId: string) =>
  analytics.events.filter((entry) => entry.userId === userId && entry.event.startsWith('dialog_')).map((entry) => entry.event)

describe('REST диалогов', () => {
  it('старт передаёт агенту только голос человека (по умолчанию мужской), режим и клиента нет, отвечает диалогом с числом сообщений и временем последней активности', async () => {
    resetLimits()
    const { user, tokens } = await signUpAndIn(app)
    const { calls } = mockAgent({
      'POST http://agent.test/v1/users/*/dialogs': () =>
        json({
          dialogId: 'd-7',
          resumed: true,
          greeting: 'Продолжим?',
          sinceLastDialogHours: 48,
          messageCount: 5,
          lastActivityAt: '2026-10-01T20:12:00.000Z',
        }),
    })

    const started = ok<StartDialogApiResponse>(
      await call(app, 'POST', '/api/dialogs', { mode: DialogMode.Vent }, tokens.accessToken, {
        'X-Platform': 'android',
        'X-App-Version': '12',
      }),
    )
    expect(started).toEqual({
      dialogId: 'd-7',
      resumed: true,
      greeting: 'Продолжим?',
      sinceLastDialogHours: 48,
      messageCount: 5,
      lastActivityAt: '2026-10-01T20:12:00.000Z',
      memoryMode: DialogMemoryMode.On,
      saved: true,
      memoryEnabled: false,
    })

    const agentCall = calls.at(-1)!
    expect(agentCall.url.pathname).toBe(`/v1/users/${user.id}/dialogs`)
    expect(JSON.parse(agentCall.body)).toEqual({ voice: 'male' })
  })

  it('агент не прислал messageCount и lastActivityAt — в ответе 0 и null, клиент ничего не спрашивает', async () => {
    resetLimits()
    const { tokens } = await signUpAndIn(app)
    mockAgent({
      'POST http://agent.test/v1/users/*/dialogs': () => json({ dialogId: 'd-5', resumed: true }),
    })

    const started = ok<StartDialogApiResponse>(await call(app, 'POST', '/api/dialogs', {}, tokens.accessToken))

    expect(started).toEqual({
      dialogId: 'd-5',
      resumed: true,
      greeting: null,
      sinceLastDialogHours: null,
      messageCount: 0,
      lastActivityAt: null,
      memoryMode: DialogMemoryMode.On,
      saved: true,
      memoryEnabled: false,
    })
  })

  it('«без памяти»: memory: off уходит агенту, в ответе режим диалога и включена ли память у человека', async () => {
    resetLimits()
    const { tokens } = await signUpAndIn(app)
    const { calls } = mockAgent({
      'POST http://agent.test/v1/users/*/dialogs': () =>
        json({ dialogId: 'd-6', resumed: false, memoryMode: 'off', memoryEnabled: true }),
    })

    const started = ok<StartDialogApiResponse>(
      await call(
        app,
        'POST',
        '/api/dialogs',
        { startNew: true, memory: DialogMemoryMode.Off },
        tokens.accessToken,
      ),
    )

    expect(started).toMatchObject({ dialogId: 'd-6', memoryMode: DialogMemoryMode.Off, memoryEnabled: true })
    expect(JSON.parse(calls.at(-1)!.body)).toEqual({ voice: 'male', new: true, memory: 'off' })
  })

  it('«не сохранять»: saved: false уходит агенту отдельно от memory, ответ несёт то, что подтвердил агент, аналитика молчит', async () => {
    // add-unsaved-dialog, «Старт разговора» и «Разговор без следа».
    const analytics = recordingAnalytics()
    const { app: tracked, resetLimits: resetTracked } = makeApp({ analytics })
    resetTracked()
    const { user, tokens } = await signUpAndIn(tracked)
    const { calls } = mockAgent({
      'POST http://agent.test/v1/users/*/dialogs': () =>
        json({ dialogId: 'd-u1', resumed: false, memoryMode: 'off', saved: false, memoryEnabled: true }),
    })

    const started = ok<StartDialogApiResponse>(
      await call(tracked, 'POST', '/api/dialogs', { startNew: true, saved: false }, tokens.accessToken),
    )

    expect(started).toMatchObject({ dialogId: 'd-u1', saved: false, memoryMode: DialogMemoryMode.Off })
    expect(JSON.parse(calls.at(-1)!.body)).toEqual({ voice: 'male', new: true, saved: false })
    expect(dialogEvents(analytics, user.id)).toEqual([]) // ни dialog_started, ничего другого
  })

  it('«без памяти» и «не сохранять» не смешиваются: memory: off уходит без saved и аналитика о старте остаётся', async () => {
    const analytics = recordingAnalytics()
    const { app: tracked, resetLimits: resetTracked } = makeApp({ analytics })
    resetTracked()
    const { user, tokens } = await signUpAndIn(tracked)
    const { calls } = mockAgent({
      'POST http://agent.test/v1/users/*/dialogs': () =>
        json({ dialogId: 'd-u2', resumed: false, memoryMode: 'off', memoryEnabled: true }),
    })

    const started = ok<StartDialogApiResponse>(
      await call(tracked, 'POST', '/api/dialogs', { memory: DialogMemoryMode.Off }, tokens.accessToken),
    )

    expect(started).toMatchObject({ memoryMode: DialogMemoryMode.Off, saved: true })
    expect(JSON.parse(calls.at(-1)!.body)).toEqual({ voice: 'male', memory: 'off' })
    expect(dialogEvents(analytics, user.id)).toEqual(['dialog_started'])
  })

  it('saved не булево — 400, агента не трогаем', async () => {
    resetLimits()
    const { tokens } = await signUpAndIn(app)
    const { calls } = mockAgent()
    const response = await call(app, 'POST', '/api/dialogs', { saved: 'нет' }, tokens.accessToken)
    expect(response.status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it('завершение не сохраняемого разговора по REST: аналитика о конце молчит', async () => {
    const analytics = recordingAnalytics()
    const { app: tracked, resetLimits: resetTracked } = makeApp({ analytics })
    resetTracked()
    const { user, tokens } = await signUpAndIn(tracked)
    mockAgent({
      'POST http://agent.test/v1/users/*/dialogs/*/end': () =>
        json({ summary: { title: 'Разговор', themes: [], recapAvailable: false }, saved: false }),
    })

    const ended = ok<EndDialogApiResponse>(
      await call(tracked, 'POST', '/api/dialogs/d-u3/end', { takeaway: 'секретный вывод' }, tokens.accessToken),
    )

    expect(ended.summary?.recapAvailable).toBe(false)
    expect(dialogEvents(analytics, user.id)).toEqual([])
  })

  it('memory не из списка — 400, агента не трогаем', async () => {
    resetLimits()
    const { tokens } = await signUpAndIn(app)
    const { calls } = mockAgent()

    const response = await call(app, 'POST', '/api/dialogs', { memory: 'never' }, tokens.accessToken)

    expect(response.status).toBe(400)
    expect(calls).toEqual([])
  })

  it('startNew: true уходит агенту как new: true; без него старт ничего не завершает', async () => {
    resetLimits()
    const { user, tokens } = await signUpAndIn(app)
    const { calls, dialogs } = mockAgent()

    const first = ok<StartDialogApiResponse>(await call(app, 'POST', '/api/dialogs', {}, tokens.accessToken))
    expect(first).toMatchObject({ dialogId: 'd-1', resumed: false, messageCount: 0 })
    dialogs.say(user.id, 3)

    // The plain start finds the dialog the person left and hands it back with what the client needs to ask.
    const again = ok<StartDialogApiResponse>(await call(app, 'POST', '/api/dialogs', {}, tokens.accessToken))
    expect(again).toMatchObject({ dialogId: 'd-1', resumed: true, messageCount: 3 })
    expect(typeof again.lastActivityAt).toBe('string')
    expect(dialogs.ended).toEqual([])
    expect(JSON.parse(calls.at(-1)!.body)).toEqual({ voice: 'male' })

    // The person answered "end it and begin a new one".
    const fresh = ok<StartDialogApiResponse>(
      await call(app, 'POST', '/api/dialogs', { startNew: true }, tokens.accessToken),
    )
    expect(fresh).toMatchObject({ dialogId: 'd-2', resumed: false, messageCount: 0, lastActivityAt: null })
    expect(JSON.parse(calls.at(-1)!.body)).toEqual({ voice: 'male', new: true })
    expect(dialogs.ended).toEqual(['d-1'])
    expect(dialogs.openOf(user.id)).toBe('d-2')
  })

  it('startNew не булево — 400, агента не трогаем', async () => {
    resetLimits()
    const { tokens } = await signUpAndIn(app)
    const { calls } = mockAgent()

    const response = await call(app, 'POST', '/api/dialogs', { startNew: 'yes' }, tokens.accessToken)

    expect(response.status).toBe(400)
    expect(calls).toEqual([])
  })

  it('выбранный в профиле голос уходит агенту при каждом старте и ответом не отдаётся', async () => {
    resetLimits()
    const { tokens } = await signUpAndIn(app)
    const { calls } = mockAgent({
      'POST http://agent.test/v1/users/*/dialogs': () =>
        json({ dialogId: 'd-9', resumed: false, voice: 'female' }),
    })

    ok(await call(app, 'PATCH', '/api/auth/me', { voice: 'female' }, tokens.accessToken))
    const started = ok<StartDialogApiResponse>(
      await call(app, 'POST', '/api/dialogs', {}, tokens.accessToken),
    )
    expect(JSON.parse(calls.at(-1)!.body)).toEqual({ voice: 'female' })
    // The voice is the profile's business: the dialog answer keeps its shape.
    expect(started).toEqual({
      dialogId: 'd-9',
      resumed: false,
      greeting: null,
      sinceLastDialogHours: null,
      messageCount: 0,
      lastActivityAt: null,
      memoryMode: DialogMemoryMode.On,
      saved: true,
      memoryEnabled: false,
    })

    ok(await call(app, 'PATCH', '/api/auth/me', { voice: 'male' }, tokens.accessToken))
    ok(await call(app, 'POST', '/api/dialogs', {}, tokens.accessToken))
    expect(JSON.parse(calls.at(-1)!.body)).toEqual({ voice: 'male' })
  })

  it('старый клиент шлёт режим, новый нет — оба получают диалог', async () => {
    resetLimits()
    const { tokens } = await signUpAndIn(app)
    mockAgent({
      'POST http://agent.test/v1/users/*/dialogs': () => json({ dialogId: 'd-8', resumed: false }),
    })

    for (const body of [{ mode: DialogMode.Vent }, {}]) {
      const started = ok<StartDialogApiResponse>(
        await call(app, 'POST', '/api/dialogs', body, tokens.accessToken),
      )
      expect(started).toMatchObject({ dialogId: 'd-8', resumed: false })
    }
  })

  it('журнал отдаёт даты строками ISO', async () => {
    resetLimits()
    const { tokens } = await signUpAndIn(app)
    mockAgent({
      'GET http://agent.test/v1/users/*/dialogs': () =>
        json({
          items: [
            {
              dialogId: 'd-1',
              mode: 'vent',
              startedAt: '2026-10-01T20:00:00.000Z',
              endedAt: null,
              summary: { title: 'Про работу', themes: ['работа'], tensionBefore: 7, tensionAfter: 4 },
            },
          ],
          next: null,
        }),
    })

    const listed = ok<ListDialogsApiResponse>(
      await call(app, 'GET', '/api/dialogs', undefined, tokens.accessToken),
    )
    expect(listed.items[0]).toMatchObject({
      dialogId: 'd-1',
      startedAt: '2026-10-01T20:00:00.000Z',
      endedAt: null,
      summary: { title: 'Про работу', tensionAfter: 4 },
    })
  })

  it('чужой диалог — DIALOG_NOT_FOUND; агент лёг — 503', async () => {
    resetLimits()
    const { tokens } = await signUpAndIn(app)
    mockAgent({ 'GET http://agent.test/v1/users/*/dialogs/*': () => json({ error: 'not_found' }, 404) })
    refusedWith(
      await call(app, 'GET', '/api/dialogs/d-x', undefined, tokens.accessToken),
      DialogApiErrorCode.DIALOG_NOT_FOUND,
    )

    mockAgent({ 'GET http://agent.test/v1/users/*/dialogs/*': () => json({ error: 'boom' }, 502) })
    const response = await app.request('/api/dialogs/d-x', {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    })
    expect(response.status).toBe(503)
  })

  it('без токена — 401', async () => {
    const response = await app.request('/api/dialogs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: DialogMode.Vent }),
    })
    expect(response.status).toBe(401)
  })

  it('старт по access-токену завершённой сессии — 401 и агента не трогает: подпись ещё верна, сессии нет', async () => {
    resetLimits()
    const { user, tokens } = await signUpAndIn(app)
    const phone = ok<{ tokens: { accessToken: string } }>(
      await call(app, 'POST', '/api/auth/login', { email: user.email, password: PASSWORD }),
    ).tokens
    ok(await call(app, 'POST', '/api/auth/logout-all', { keepCurrent: true }, tokens.accessToken))
    const { calls } = mockAgent()

    const started = await call(app, 'POST', '/api/dialogs', {}, phone.accessToken)

    expect(started.status).toBe(401)
    expect(calls).toEqual([])
    // The session that was kept still starts a dialog.
    mockAgent({
      'POST http://agent.test/v1/users/*/dialogs': () => json({ dialogId: 'd-kept', resumed: false }),
    })
    ok(await call(app, 'POST', '/api/dialogs', {}, tokens.accessToken))
  })
})

describe('итог разговора, удаление и настройка', () => {
  const RECAP = 'Ты рассказал про работу и решил поговорить с руководителем до пятницы.'
  const dialog = { dialogId: 'd-1', startedAt: '2026-10-20T10:00:00.000Z', endedAt: '2026-10-20T10:10:00.000Z', summary: null, messages: [] }

  it('завершение несёт «Что забираешь» (оно же итог) агенту; в ответе итог и его статус, без служебного recapAt', async () => {
    resetLimits()
    const { tokens } = await signUpAndIn(app)
    const { calls } = mockAgent({
      'POST http://agent.test/v1/users/*/dialogs/*/end': () =>
        json({ summary: { title: 'Разговор', themes: [], recap: RECAP, recapStatus: 'ready', recapSource: 'manual', recapAt: '2026-10-20T10:11:00Z' } }),
    })
    const result = ok<EndDialogApiResponse>(
      await call(app, 'POST', '/api/dialogs/d-1/end', { takeaway: RECAP, tensionAfter: 4, recapSource: 'draft' }, tokens.accessToken),
    )
    expect(result.summary).toMatchObject({ recap: RECAP, recapStatus: 'ready', recapSource: 'manual' })
    expect(JSON.stringify(result)).not.toContain('recapAt')
    expect(JSON.parse(calls.at(-1)!.body)).toEqual({ takeaway: RECAP, tensionAfter: 4, recapSource: 'draft' })
  })

  it('итог длиннее правил или пустой — 400, агента не трогаем', async () => {
    resetLimits()
    const { tokens } = await signUpAndIn(app)
    const { calls } = mockAgent()
    for (const recap of ['', '   ', 'я'.repeat(501)]) {
      expect((await call(app, 'PUT', '/api/dialogs/d-1/recap', { recap }, tokens.accessToken)).status).toBe(400)
    }
    expect((await call(app, 'POST', '/api/dialogs/d-1/end', { takeaway: 'я'.repeat(501) }, tokens.accessToken)).status).toBe(400)
    expect(calls).toEqual([])
  })

  it('«Удалить разговор»: агент стирает его, ссылка гаснет, итог недели этого разговора пропадает сразу, остальные недели целы', async () => {
    resetLimits()
    const { user, tokens } = await signUpAndIn(app)
    const week = (periodStart: string) => ({ userId: user.id, kind: 'week' as const, periodStart, text: 'Итог недели.', status: 'ready' as const })
    // The conversation began on Tuesday 20 Oct 2026 (the week of the 19th); the week before has its text too.
    await getDb().insert(diarySummaries).values([week('2026-10-19'), week('2026-10-12')])
    const { calls } = mockAgent({
      'GET http://agent.test/v1/users/*/dialogs/*': () => json(dialog),
      'DELETE http://agent.test/v1/users/*/dialogs/*': () => new Response(null, { status: 204 }),
    })
    const deleted = ok<DeleteDialogApiResponse>(await call(app, 'DELETE', '/api/dialogs/d-1', undefined, tokens.accessToken))
    expect(deleted).toEqual({ deleted: true })
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([`GET /v1/users/${user.id}/dialogs/d-1`, `DELETE /v1/users/${user.id}/dialogs/d-1`])
    const rows = await getDb().select().from(diarySummaries).where(eq(diarySummaries.userId, user.id))
    // The week of the conversation lost its text at once and waits for the tick as an empty marker; the other week is whole.
    const byWeek = Object.fromEntries(rows.map((r) => [r.periodStart, r]))
    expect(byWeek['2026-10-19']).toMatchObject({ status: 'pending', text: '' })
    expect(byWeek['2026-10-12']).toMatchObject({ status: 'ready', text: 'Итог недели.' })
  })

  // `openspec/changes/archive/2026-10-27-add-job-queue`, «Когда пересчитываются итоги недели»: сценарии «Сброс после удаления не удался»
  // и «Удаление разговора не состоялось».
  describe('сброс недели после удаления разговора идёт через очередь', () => {
    const week = (userId: string) => ({
      userId,
      kind: 'week' as const,
      periodStart: '2026-10-19',
      text: 'Итог недели.',
      status: 'ready' as const,
    })
    const weekRow = async (userId: string) =>
      (await getDb().select().from(diarySummaries).where(eq(diarySummaries.userId, userId)))[0]
    /** The follow-up job as the worker runs it, on the job that stands in the queue. */
    const runQueuedJob = async () => {
      const [queued] = getEnqueuedJobs()
      expect(queued?.queue).toBe('dialogs.after-delete')
      await afterDeleteJob()(queued!.data as never, {} as never)
    }

    it('после успешного сброса в запросе задача отменена: ждать нечего', async () => {
      resetLimits()
      const { user, tokens } = await signUpAndIn(app)
      await getDb().insert(diarySummaries).values(week(user.id))
      mockAgent({
        'GET http://agent.test/v1/users/*/dialogs/*': () => json(dialog),
        'DELETE http://agent.test/v1/users/*/dialogs/*': () => new Response(null, { status: 204 }),
      })

      ok<DeleteDialogApiResponse>(await call(app, 'DELETE', '/api/dialogs/d-1', undefined, tokens.accessToken))

      expect(await weekRow(user.id)).toMatchObject({ status: 'pending', text: '' })
      expect(getEnqueuedJobs()).toEqual([])
    })

    it('Сброс после удаления не удался: запрос ответил, неделя не сброшена, задача лежит и сбрасывает её сама', async () => {
      resetLimits()
      const { user, tokens } = await signUpAndIn(app)
      await getDb().insert(diarySummaries).values(week(user.id))
      mockAgent({
        'GET http://agent.test/v1/users/*/dialogs/*': () => json(dialog),
        'DELETE http://agent.test/v1/users/*/dialogs/*': () => new Response(null, { status: 204 }),
      })
      // The pod restarted or the database did not answer between the agent's answer and the reset.
      const failing = vi.spyOn(diaryProcess, 'execute').mockRejectedValueOnce(new Error('the database did not answer'))

      const deleted = ok<DeleteDialogApiResponse>(
        await call(app, 'DELETE', '/api/dialogs/d-1', undefined, tokens.accessToken),
      )
      failing.mockRestore()

      expect(deleted).toEqual({ deleted: true })
      // The text still retells the deleted conversation, and the job that will reset it is waiting.
      expect(await weekRow(user.id)).toMatchObject({ status: 'ready', text: 'Итог недели.' })
      expect(getEnqueuedJobs()).toEqual([
        expect.objectContaining({
          queue: 'dialogs.after-delete',
          data: { userId: user.id, dialogId: 'd-1', dialogAt: '2026-10-20T10:00:00.000Z' },
          startAfterSeconds: 120,
        }),
      ])

      // Two minutes later the agent confirms that the conversation is gone, and the job resets the week.
      mockAgent({
        'GET http://agent.test/v1/users/*/dialogs/*': () => json({ error: { code: 'AGENT_DIALOG_NOT_FOUND' } }, 404),
      })
      await runQueuedJob()
      expect(await weekRow(user.id)).toMatchObject({ status: 'pending', text: '' })
    })

    it('Удаление разговора не состоялось: агент отказал — 503, разговор на месте, а задача ничего не сбрасывает', async () => {
      resetLimits()
      const { user, tokens } = await signUpAndIn(app)
      await getDb().insert(diarySummaries).values(week(user.id))
      mockAgent({
        'GET http://agent.test/v1/users/*/dialogs/*': () => json(dialog),
        'DELETE http://agent.test/v1/users/*/dialogs/*': () => json({ error: 'boom' }, 502),
      })

      expect((await call(app, 'DELETE', '/api/dialogs/d-1', undefined, tokens.accessToken)).status).toBe(503)
      expect(getEnqueuedJobs()).toHaveLength(1)

      // The conversation is still at the agent, so the job leaves the week text as it is.
      mockAgent({ 'GET http://agent.test/v1/users/*/dialogs/*': () => json(dialog) })
      await runQueuedJob()
      expect(await weekRow(user.id)).toMatchObject({ status: 'ready', text: 'Итог недели.' })
    })
  })

  it('чужого и несуществующего разговора нет; без сессии — 401; агент лёг — 503', async () => {
    resetLimits()
    const { tokens } = await signUpAndIn(app)
    mockAgent({ 'GET http://agent.test/v1/users/*/dialogs/*': () => json({ error: { code: 'AGENT_DIALOG_NOT_FOUND' } }, 404) })
    refusedWith(await call(app, 'DELETE', '/api/dialogs/d-x', undefined, tokens.accessToken), DialogApiErrorCode.DIALOG_NOT_FOUND)
    expect((await call(app, 'DELETE', '/api/dialogs/d-x')).status).toBe(401)
    mockAgent({ 'GET http://agent.test/v1/users/*/dialogs/*': () => json({ error: 'boom' }, 502) })
    expect((await call(app, 'DELETE', '/api/dialogs/d-x', undefined, tokens.accessToken)).status).toBe(503)
  })

  it('список итогов, черновик, запись итога из журнала', async () => {
    resetLimits()
    const { tokens } = await signUpAndIn(app)
    mockAgent({
      'GET http://agent.test/v1/users/*/recaps': () =>
        json({ items: [{ dialogId: 'd-2', startedAt: '2026-10-24T09:00:00Z', title: 'Работа', recap: RECAP, recapSource: 'auto', recapAt: '2026-10-24T09:01:00Z' }], next: null }),
      'POST http://agent.test/v1/users/*/dialogs/*/recap/draft': () => json({ recap: RECAP }),
      'PUT http://agent.test/v1/users/*/dialogs/*/recap': () =>
        json({ summary: { title: 'Работа', themes: [], recap: RECAP, recapStatus: 'ready', recapSource: 'draft' } }),
    })
    const list = ok<ListDialogRecapsApiResponse>(await call(app, 'GET', '/api/recaps', undefined, tokens.accessToken))
    expect(list).toEqual({
      items: [{ dialogId: 'd-2', startedAt: '2026-10-24T09:00:00.000Z', title: 'Работа', recap: RECAP, recapSource: 'auto' }],
      next: null,
    })
    expect(ok<DraftDialogRecapApiResponse>(await call(app, 'POST', '/api/dialogs/d-2/recap/draft', undefined, tokens.accessToken))).toEqual({ recap: RECAP })
    const saved = ok<PutDialogRecapApiResponse>(await call(app, 'PUT', '/api/dialogs/d-2/recap', { recap: RECAP, source: 'draft' }, tokens.accessToken))
    expect(saved.summary).toMatchObject({ recap: RECAP, recapSource: 'draft' })
  })

  it('черновик: нет итога у разговора, модель не написала — отказы с кодами; запись для короткого — RECAP_NOT_AVAILABLE', async () => {
    resetLimits()
    const { tokens } = await signUpAndIn(app)
    mockAgent({ 'POST http://agent.test/v1/users/*/dialogs/*/recap/draft': () => json({ error: { code: 'RECAP_NOT_AVAILABLE' } }, 409) })
    refusedWith(await call(app, 'POST', '/api/dialogs/d-1/recap/draft', undefined, tokens.accessToken), DialogRecapApiErrorCode.RECAP_NOT_AVAILABLE)
    mockAgent({ 'POST http://agent.test/v1/users/*/dialogs/*/recap/draft': () => json({ error: { code: 'RECAP_UNAVAILABLE' } }, 502) })
    refusedWith(await call(app, 'POST', '/api/dialogs/d-1/recap/draft', undefined, tokens.accessToken), DialogRecapApiErrorCode.RECAP_UNAVAILABLE)
    mockAgent({ 'PUT http://agent.test/v1/users/*/dialogs/*/recap': () => json({ error: { code: 'RECAP_NOT_AVAILABLE' } }, 409) })
    refusedWith(await call(app, 'PUT', '/api/dialogs/d-1/recap', { recap: RECAP }, tokens.accessToken), DialogRecapApiErrorCode.RECAP_NOT_AVAILABLE)
  })

  it('«Подводить итог автоматически»: читается и сохраняется, отдельно от памяти; не булево — 400', async () => {
    resetLimits()
    const { tokens } = await signUpAndIn(app)
    const { calls } = mockAgent({
      'GET http://agent.test/v1/users/*/dialog-settings': () => json({ recapEnabled: true }),
      'PUT http://agent.test/v1/users/*/dialog-settings': () => json({ recapEnabled: false }),
    })
    expect(ok<DialogSettingsApiResponse>(await call(app, 'GET', '/api/dialog-settings', undefined, tokens.accessToken))).toEqual({ recapEnabled: true })
    expect(ok<DialogSettingsApiResponse>(await call(app, 'PUT', '/api/dialog-settings', { recapEnabled: false }, tokens.accessToken))).toEqual({ recapEnabled: false })
    expect(JSON.parse(calls.at(-1)!.body)).toEqual({ recapEnabled: false })
    expect((await call(app, 'PUT', '/api/dialog-settings', { recapEnabled: 'нет' }, tokens.accessToken)).status).toBe(400)
  })

})

// ─── WebSocket gateway ────────────────────────────────────────────────────────

interface AgentConnection {
  socket: WebSocket
  /** Headers of the handshake the gateway made. */
  headers: IncomingHttpHeaders
  received: unknown[]
  binaryFrames: Buffer[]
}

interface FakeAgent {
  url: string
  /** Connection by dialog id: each test has its own, so tests do not interfere with each other. */
  waitFor: (dialogId: string) => Promise<AgentConnection>
  /** Whether the gateway has opened a connection for this dialog. */
  opened: (dialogId: string) => boolean
  /** The agent has no such dialog: its handshake is refused with `404`, as a restarted agent refuses an unsaved one. */
  forget: (dialogId: string) => void
  close: () => Promise<void>
}

/**
 * A tiny WebSocket agent: it accepts frames at the user-scoped address and lets the test answer with
 * its own. Connections are keyed by dialog, otherwise a test would answer into the previous test's
 * socket.
 */
async function startFakeAgent(): Promise<FakeAgent> {
  const server = createServer()
  const forgotten = new Set<string>()
  const wss = new WebSocketServer({
    server,
    verifyClient: (info, done) => {
      const parts = (info.req.url ?? '').split('?')[0]!.split('/').filter(Boolean)
      if (forgotten.has(decodeURIComponent(parts[4] ?? ''))) done(false, 404, 'Not Found')
      else done(true)
    },
  })
  const connections = new Map<string, AgentConnection>()

  wss.on('connection', (socket, request) => {
    // /v1/users/{userId}/dialogs/{dialogId}/ws
    const parts = (request.url ?? '').split('?')[0]!.split('/').filter(Boolean)
    const dialogId = decodeURIComponent(parts[4] ?? '')
    const connection: AgentConnection = {
      socket: socket as unknown as WebSocket,
      headers: request.headers,
      received: [],
      binaryFrames: [],
    }
    connections.set(dialogId, connection)
    socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) connection.binaryFrames.push(data)
      else connection.received.push(JSON.parse(data.toString('utf8')))
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    async waitFor(dialogId) {
      await vi.waitFor(() => expect(connections.has(dialogId)).toBe(true), { timeout: 5000 })
      return connections.get(dialogId)!
    },
    opened: (dialogId) => connections.has(dialogId),
    forget: (dialogId) => void forgotten.add(dialogId),
    close: () =>
      new Promise<void>((resolve) => {
        // terminate rather than close: otherwise wss.close waits for clients and the hook times out.
        for (const connection of connections.values()) connection.socket.terminate()
        wss.close(() => server.close(() => resolve()))
      }),
  }
}

/** An open dialog asks about its session every second here, not every 30: the tests would wait that long. */
const sessionCheckEnv = { DIALOG_SESSION_CHECK_SEC: '1' }
/** The gateway offers every codec; a client that names none still gets PCM16, which the tests below rely on. */
const codecEnv = { DIALOG_AUDIO_CODECS: 'opus,mulaw' }

/** The app with WebSocket: as in production, the upgrade is intercepted before Hono. */
async function startGatewayServer(agentUrl: string) {
  // The agent address reaches the gateway through the app env rather than the core's getEnv():
  // otherwise clearing the stubs in setup.ts between tests would point the socket at the real address.
  const gatewayEnv = { AGENT_API_URL: agentUrl, ...sessionCheckEnv, ...codecEnv }
  const env = parseEnv({ ...process.env, ...gatewayEnv })
  const { app: hono, resetLimits: resetGatewayLimits } = makeApp({ env: gatewayEnv })
  const jwt = createJwt(env.MOBILE_JWT_SECRET)
  const sessions = createSessions(jwt)
  // What the gateway reports to PostHog is read back by the tests below.
  const analytics = recordingAnalytics()

  const server = serve({ fetch: hono.fetch, port: 0, createServer }) as unknown as Server
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (request, socket, head) => {
    if ((request.url ?? '').split('?')[0] !== ApiPath.DialogsWs) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(request, socket, head, (ws) =>
      handleDialogSocket(ws as never, { env, jwt, sessions, analytics }, request),
    )
  })
  await new Promise<void>((resolve) => setTimeout(resolve, 50))
  const { port } = server.address() as AddressInfo
  return {
    wsUrl: `ws://127.0.0.1:${port}${ApiPath.DialogsWs}`,
    jwt,
    sessions,
    analytics,
    /** A real account with a registered session: the gateway asks the registry, so a token minted by hand would be refused. */
    async signIn() {
      resetGatewayLimits()
      const { user, tokens } = await signUpAndIn(hono, undefined, { consents: false })
      return { userId: user.id, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken }
    },
    close: () =>
      new Promise<void>((resolve) => {
        wss.close(() => server.close(() => resolve()))
      }),
  }
}

function nextFrame(socket: WebSocket, type?: string, timeoutMs = 3000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no frame ${type ?? ''} in ${timeoutMs} ms`)), timeoutMs)
    const onMessage = (data: Buffer, isBinary: boolean) => {
      if (isBinary) return
      const frame = JSON.parse(data.toString('utf8')) as Record<string, unknown>
      if (type && frame.type !== type) return
      clearTimeout(timer)
      socket.off('message', onMessage)
      resolve(frame)
    }
    socket.on('message', onMessage)
  })
}

function waitOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', reject)
  })
}

describe('WebSocket-шлюз', () => {
  let agent: FakeAgent
  let gateway: Awaited<ReturnType<typeof startGatewayServer>>

  beforeAll(async () => {
    agent = await startFakeAgent()
    gateway = await startGatewayServer(agent.url)
  })

  afterAll(async () => {
    await gateway.close()
    await agent.close()
  })

  it('hello с токеном открывает диалог и пропускает кадры в обе стороны', async () => {
    const { accessToken } = await gateway.signIn()
    const client = new WebSocket(gateway.wsUrl)
    await waitOpen(client)

    client.send(JSON.stringify({ type: DialogClientFrame.Hello, token: accessToken, dialogId: 'd-1' }))
    const agentSide = await agent.waitFor('d-1')
    agentSide.socket.send(JSON.stringify({ type: 'ready', greeting: 'Я рядом.' }))

    const ready = await nextFrame(client, DialogServerFrame.Ready)
    expect(ready).toMatchObject({ v: 1, dialogId: 'd-1', greeting: 'Я рядом.' })

    client.send(JSON.stringify({ type: DialogClientFrame.Message, clientId: 'c-1', text: 'тяжело' }))
    await vi.waitFor(() =>
      expect(agentSide.received).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'user_message', id: 'c-1', text: 'тяжело' }),
        ]),
      ),
    )

    agentSide.socket.send(JSON.stringify({ type: 'ack', id: 'c-1', messageId: 'm-1' }))
    expect(await nextFrame(client, DialogServerFrame.Ack)).toMatchObject({
      clientId: 'c-1',
      messageId: 'm-1',
    })

    client.close()
  })

  it('заголовки трассировки из рукопожатия клиента уходят агенту, а userId подменяется проверенным', async () => {
    const { userId, accessToken } = await gateway.signIn()
    const client = new WebSocket(gateway.wsUrl, {
      headers: {
        'x-trace-id': 'trace-ws-1',
        'x-request-time': '2026-10-04T10:00:00.000Z',
        'x-client-id': 'ryadom-test',
        'x-session-id': 'session-ws-1',
        'x-user-id': 'forged-user',
      },
    })
    await waitOpen(client)
    client.send(JSON.stringify({ type: DialogClientFrame.Hello, token: accessToken, dialogId: 'd-trace-1' }))

    const agentSide = await agent.waitFor('d-trace-1')
    expect(agentSide.headers).toMatchObject({
      'x-trace-id': 'trace-ws-1',
      'x-request-time': '2026-10-04T10:00:00.000Z',
      'x-client-id': 'ryadom-test',
      'x-session-id': 'session-ws-1',
      'x-user-id': userId,
    })
    client.close()
  })

  it('к агенту шлюз не просит сжатия сообщений (permessage-deflate): внутри кластера оно только съедает CPU', async () => {
    const { accessToken } = await gateway.signIn()
    const client = new WebSocket(gateway.wsUrl)
    await waitOpen(client)
    client.send(
      JSON.stringify({ type: DialogClientFrame.Hello, token: accessToken, dialogId: 'd-no-deflate' }),
    )

    const agentSide = await agent.waitFor('d-no-deflate')
    expect(agentSide.headers['sec-websocket-extensions']).toBeUndefined()
    client.close()
  })

  it('сокет без заголовков (браузер их задать не может): агенту уходят все пять пустыми', async () => {
    const { userId, accessToken } = await gateway.signIn()
    const client = new WebSocket(gateway.wsUrl)
    await waitOpen(client)
    client.send(JSON.stringify({ type: DialogClientFrame.Hello, token: accessToken, dialogId: 'd-trace-2' }))

    const agentSide = await agent.waitFor('d-trace-2')
    // No trace id is made up, but the account is known from the token.
    expect(agentSide.headers['x-trace-id']).toBe('')
    expect(agentSide.headers['x-request-time']).toBe('')
    expect(agentSide.headers['x-client-id']).toBe('')
    expect(agentSide.headers['x-session-id']).toBe('')
    expect(agentSide.headers['x-user-id']).toBe(userId)
    client.close()
  })

  it('кадр safety без линий помощи дополняется нашими', async () => {
    const { accessToken } = await gateway.signIn()
    const client = new WebSocket(gateway.wsUrl)
    await waitOpen(client)
    client.send(JSON.stringify({ type: DialogClientFrame.Hello, token: accessToken, dialogId: 'd-2' }))
    const agentSide = await agent.waitFor('d-2')

    agentSide.socket.send(JSON.stringify({ type: 'safety', level: 'crisis', text: 'я рядом' }))
    const safety = await nextFrame(client, DialogServerFrame.Safety)
    expect(safety.level).toBe(SafetyLevel.Crisis)
    // The SOS screen must not open empty even when the agent supplied no hotlines.
    expect((safety.hotlines as unknown[]).length).toBeGreaterThan(0)

    client.close()
  })

  it('кадр mood от агента доходит до клиента, чужие значения отбрасываются (PROTEUS-168)', async () => {
    const { accessToken } = await gateway.signIn()
    const client = new WebSocket(gateway.wsUrl)
    await waitOpen(client)
    client.send(JSON.stringify({ type: DialogClientFrame.Hello, token: accessToken, dialogId: 'd-mood-1' }))
    const agentSide = await agent.waitFor('d-mood-1')

    agentSide.socket.send(JSON.stringify({ type: 'mood', tone: 'furious', intensity: 1 }))
    agentSide.socket.send(JSON.stringify({ type: 'mood', tone: 'angry', intensity: 7, risk: 'self_harm', at: 5 }))
    const mood = await nextFrame(client, DialogServerFrame.Mood)
    expect(mood).toEqual({ v: 1, type: 'mood', tone: 'angry', intensity: 1, at: 5 })
    client.close()
  })

  it('аналитика: завершённый диалог — счётчики реплик, длительность и перемена напряжения, но не текст', async () => {
    const { userId, accessToken } = await gateway.signIn()
    const client = new WebSocket(gateway.wsUrl)
    await waitOpen(client)
    client.send(JSON.stringify({ type: DialogClientFrame.Hello, token: accessToken, dialogId: 'd-an-1' }))
    const agentSide = await agent.waitFor('d-an-1')

    client.send(JSON.stringify({ type: DialogClientFrame.Message, clientId: 'c-1', text: 'секретная реплика' }))
    await vi.waitFor(() => expect(agentSide.received).toContainEqual(expect.objectContaining({ type: 'user_message' })))
    // One spoken turn: only the final transcript counts, the partial one does not. The agent also
    // sends a final one with no text for silence or an echo, and stores no message for it.
    agentSide.socket.send(JSON.stringify({ type: 'transcript', text: 'ну', final: false }))
    agentSide.socket.send(JSON.stringify({ type: 'transcript', text: 'ну вот', final: true, messageId: 'm-9' }))
    agentSide.socket.send(JSON.stringify({ type: 'transcript', text: '', final: true }))
    agentSide.socket.send(JSON.stringify({ type: 'transcript', text: '   ', final: true }))
    agentSide.socket.send(JSON.stringify({ type: 'assistant_end', messageId: 'm-2', text: 'секретный ответ' }))
    client.send(JSON.stringify({ type: DialogClientFrame.End, takeaway: 'секретный вывод', tensionAfter: 3 }))
    await vi.waitFor(() => expect(agentSide.received).toContainEqual(expect.objectContaining({ type: 'end' })))
    agentSide.socket.send(
      JSON.stringify({
        type: 'ended',
        summary: { title: 'секретный заголовок', themes: [], tensionBefore: 7, tensionAfter: 3 },
      }),
    )
    await nextFrame(client, DialogServerFrame.Ended)
    await new Promise<void>((resolve) => client.once('close', () => resolve()))

    const mine = gateway.analytics.events.filter((entry) => entry.userId === userId)
    // Two accepted replies (one typed, one spoken) are two turns; the end is one event.
    expect(mine.map((entry) => entry.event)).toEqual(['dialog_turn', 'dialog_turn', 'dialog_ended'])
    expect(mine.slice(0, 2).map((entry) => entry.properties.input)).toEqual(['text', 'voice'])
    const ended = mine[2]!
    expect(ended).toMatchObject({
      event: 'dialog_ended',
      properties: {
        via: 'socket',
        // The agent did not count the whole dialog, so these are what this connection saw, and say so.
        counts: 'connection',
        user_messages: 2,
        assistant_messages: 1,
        has_takeaway: true,
        tension_delta: -4,
        tension_improved: true,
      },
    })
    expect(typeof ended.properties.duration_s).toBe('number')
    expect(JSON.stringify(mine)).not.toMatch(/секретн/)
  })

  it('аналитика: у событий диалога есть dialog_id, а счётчики берутся за весь диалог, если их знает агент', async () => {
    const dialogId = '6f1d6c1e-2f43-4a53-9d77-0a3d3a8f7b11'
    const { userId, accessToken } = await gateway.signIn()
    const client = new WebSocket(gateway.wsUrl)
    await waitOpen(client)
    client.send(JSON.stringify({ type: DialogClientFrame.Hello, token: accessToken, dialogId }))
    const agentSide = await agent.waitFor(dialogId)

    client.send(JSON.stringify({ type: DialogClientFrame.Message, clientId: 'c-1', text: 'привет' }))
    await vi.waitFor(() => expect(agentSide.received).toContainEqual(expect.objectContaining({ type: 'user_message' })))
    // The agent saw a dialog of 9 replies over three connections; this connection saw one.
    agentSide.socket.send(
      JSON.stringify({
        type: 'ended',
        summary: {
          title: 'Разговор',
          themes: [],
          tensionBefore: null,
          tensionAfter: null,
          userMessages: 9,
          assistantMessages: 9,
        },
      }),
    )
    const ended = await nextFrame(client, DialogServerFrame.Ended)
    await new Promise<void>((resolve) => client.once('close', () => resolve()))

    // The counts are for analytics: the client's summary is the contract's, nothing more.
    expect(ended.summary).toEqual({ title: 'Разговор', themes: [], tensionBefore: null, tensionAfter: null })
    const mine = gateway.analytics.events.filter((entry) => entry.userId === userId)
    expect(mine.map((entry) => entry.event)).toEqual(['dialog_turn', 'dialog_ended'])
    expect(mine[0]!.properties).toEqual({ dialog_id: dialogId, input: 'text' })
    expect(mine[1]!.properties).toMatchObject({
      dialog_id: dialogId,
      counts: 'dialog',
      user_messages: 9,
      assistant_messages: 9,
    })
  })

  it('аналитика: кадр component от агента становится component_called, лишнего из кадра не берётся', async () => {
    const dialogId = 'a4b9f0c2-6d1e-4c70-8a55-1f2e9d3c4b21'
    const { userId, accessToken } = await gateway.signIn()
    const client = new WebSocket(gateway.wsUrl)
    await waitOpen(client)
    client.send(JSON.stringify({ type: DialogClientFrame.Hello, token: accessToken, dialogId }))
    const agentSide = await agent.waitFor(dialogId)

    agentSide.socket.send(
      JSON.stringify({ type: 'component', component: 'tts', outcome: 'ok', cached: true, prompt: 'секретный промпт' }),
    )
    agentSide.socket.send(
      JSON.stringify({ type: 'component', component: 'llm', outcome: 'error', error: 'секретная ошибка вендора' }),
    )
    // A name outside the set is not reported: the report cannot be made to carry an arbitrary string.
    agentSide.socket.send(JSON.stringify({ type: 'component', component: 'секретный компонент', outcome: 'ok' }))
    await vi.waitFor(() =>
      expect(gateway.analytics.events.filter((entry) => entry.userId === userId)).toHaveLength(2),
    )

    const mine = gateway.analytics.events.filter((entry) => entry.userId === userId)
    expect(mine.map((entry) => [entry.event, entry.properties])).toEqual([
      ['component_called', { dialog_id: dialogId, component: 'tts', outcome: 'ok', cached: true }],
      ['component_called', { dialog_id: dialogId, component: 'llm', outcome: 'error', cached: false }],
    ])
    expect(JSON.stringify(mine)).not.toMatch(/секретн/)
    client.close()
  })

  it('аналитика: идентификатор диалога, который не является идентификатором, в событие не попадает', async () => {
    const { userId, accessToken } = await gateway.signIn()
    const client = new WebSocket(gateway.wsUrl)
    await waitOpen(client)
    client.send(JSON.stringify({ type: DialogClientFrame.Hello, token: accessToken, dialogId: 'not-an-id-at-all' }))
    const agentSide = await agent.waitFor('not-an-id-at-all')
    client.send(JSON.stringify({ type: DialogClientFrame.Message, clientId: 'c-1', text: 'привет' }))
    await vi.waitFor(() => expect(agentSide.received).toContainEqual(expect.objectContaining({ type: 'user_message' })))
    await vi.waitFor(() => expect(gateway.analytics.events.some((entry) => entry.userId === userId)).toBe(true))

    const mine = gateway.analytics.events.filter((entry) => entry.userId === userId)
    expect(mine[0]!.properties).toEqual({ input: 'text' })
    client.close()
  })

  it('не сохраняемый разговор (ready с saved: false): ни реплик, ни вызовов частей агента, ни конца в аналитике, текст идёт как обычно', async () => {
    const dialogId = 'e7c1a9d2-3b44-4f08-9a61-5d2b8c0e1f77'
    const { userId, accessToken } = await gateway.signIn()
    const client = new WebSocket(gateway.wsUrl)
    await waitOpen(client)
    client.send(JSON.stringify({ type: DialogClientFrame.Hello, token: accessToken, dialogId }))
    const agentSide = await agent.waitFor(dialogId)
    agentSide.socket.send(JSON.stringify({ type: 'ready', saved: false }))
    await nextFrame(client, DialogServerFrame.Ready)

    client.send(JSON.stringify({ type: DialogClientFrame.Message, clientId: 'c-1', text: 'секретная реплика' }))
    await vi.waitFor(() => expect(agentSide.received).toContainEqual(expect.objectContaining({ type: 'user_message' })))
    agentSide.socket.send(JSON.stringify({ type: 'transcript', text: 'ну вот', final: true, messageId: 'm-9' }))
    agentSide.socket.send(JSON.stringify({ type: 'component', component: 'tts', outcome: 'ok', cached: true }))
    agentSide.socket.send(JSON.stringify({ type: 'assistant_end', messageId: 'm-2', text: 'секретный ответ' }))
    client.send(JSON.stringify({ type: DialogClientFrame.End, takeaway: 'секретный вывод' }))
    await vi.waitFor(() => expect(agentSide.received).toContainEqual(expect.objectContaining({ type: 'end' })))
    agentSide.socket.send(JSON.stringify({ type: 'ended', summary: { title: 'Разговор', themes: [] } }))
    const ended = await nextFrame(client, DialogServerFrame.Ended)
    await new Promise<void>((resolve) => client.once('close', () => resolve()))

    expect(ended.summary).toMatchObject({ title: 'Разговор' }) // клиент получает сводку как обычно
    expect(gateway.analytics.events.filter((entry) => entry.userId === userId)).toEqual([])
  })

  it('не сохраняемый разговор: оборвавшаяся связь не даёт dialog_interrupted', async () => {
    const dialogId = 'b3f5d7a1-9c20-4e66-8d14-7a0e2c6b9f35'
    const { userId, accessToken } = await gateway.signIn()
    const client = new WebSocket(gateway.wsUrl)
    await waitOpen(client)
    client.send(JSON.stringify({ type: DialogClientFrame.Hello, token: accessToken, dialogId }))
    const agentSide = await agent.waitFor(dialogId)
    agentSide.socket.send(JSON.stringify({ type: 'ready', saved: false }))
    await nextFrame(client, DialogServerFrame.Ready)
    client.send(JSON.stringify({ type: DialogClientFrame.Message, clientId: 'c-1', text: 'привет' }))
    await vi.waitFor(() => expect(agentSide.received).toContainEqual(expect.objectContaining({ type: 'user_message' })))

    client.close()
    await new Promise<void>((resolve) => setTimeout(resolve, 300))
    expect(gateway.analytics.events.filter((entry) => entry.userId === userId)).toEqual([])
  })

  it('агент отвечает 404 на рукопожатие (разговор потерян при перезапуске): DIALOG_NOT_FOUND и закрытие 4011, а не «агент недоступен»', async () => {
    const dialogId = 'c9d2e4f6-1a3b-4c5d-8e7f-0a1b2c3d4e5f'
    agent.forget(dialogId)
    const { userId, accessToken } = await gateway.signIn()
    const client = new WebSocket(gateway.wsUrl)
    await waitOpen(client)
    const closed = new Promise<number>((resolve) => client.once('close', (code) => resolve(code)))
    const error = nextFrame(client, DialogServerFrame.Error)
    client.send(JSON.stringify({ type: DialogClientFrame.Hello, token: accessToken, dialogId }))

    expect(await error).toMatchObject({ code: DialogWsErrorCode.DIALOG_NOT_FOUND })
    expect(await closed).toBe(DialogCloseCode.DialogGone)
    // A lost dialog is not an interruption worth reporting: the client has nothing to reconnect to.
    expect(gateway.analytics.events.filter((entry) => entry.userId === userId)).toEqual([])
  })

  it('аналитика: клиент оборвал связь после реплики — dialog_interrupted, и ровно один раз', async () => {
    const { userId, accessToken } = await gateway.signIn()
    const client = new WebSocket(gateway.wsUrl)
    await waitOpen(client)
    client.send(JSON.stringify({ type: DialogClientFrame.Hello, token: accessToken, dialogId: 'd-an-2' }))
    const agentSide = await agent.waitFor('d-an-2')
    client.send(JSON.stringify({ type: DialogClientFrame.Message, clientId: 'c-1', text: 'привет' }))
    await vi.waitFor(() => expect(agentSide.received).toContainEqual(expect.objectContaining({ type: 'user_message' })))

    client.close()
    const interrupted = () =>
      gateway.analytics.events.filter((entry) => entry.userId === userId && entry.event === 'dialog_interrupted')
    await vi.waitFor(() => expect(interrupted()).toHaveLength(1))
    // Give a possible duplicate (socket close after dispose) time to show itself.
    await new Promise<void>((resolve) => setTimeout(resolve, 150))
    expect(interrupted()).toHaveLength(1)
    expect(interrupted()[0]).toMatchObject({
      event: 'dialog_interrupted',
      properties: { reason: 'client_closed', user_messages: 1 },
    })
    // The reply itself was reported once, as a turn.
    expect(
      gateway.analytics.events.filter((entry) => entry.userId === userId && entry.event === 'dialog_turn'),
    ).toHaveLength(1)
  })

  it('аналитика: подключение без единой реплики ничего не сообщает (переподключения — не новость)', async () => {
    const { userId, accessToken } = await gateway.signIn()
    const client = new WebSocket(gateway.wsUrl)
    await waitOpen(client)
    client.send(JSON.stringify({ type: DialogClientFrame.Hello, token: accessToken, dialogId: 'd-an-3' }))
    await agent.waitFor('d-an-3')
    client.close()
    await new Promise<void>((resolve) => setTimeout(resolve, 200))
    expect(gateway.analytics.events.filter((entry) => entry.userId === userId)).toEqual([])
  })

  it('аналитика: кризисный сигнал считается без человека', async () => {
    const before = gateway.analytics.events.length
    const { accessToken } = await gateway.signIn()
    const client = new WebSocket(gateway.wsUrl)
    await waitOpen(client)
    client.send(JSON.stringify({ type: DialogClientFrame.Hello, token: accessToken, dialogId: 'd-an-4' }))
    const agentSide = await agent.waitFor('d-an-4')

    agentSide.socket.send(JSON.stringify({ type: 'safety', level: 'crisis', text: 'я рядом' }))
    await nextFrame(client, DialogServerFrame.Safety)

    const signals = gateway.analytics.events.slice(before).filter((entry) => entry.event === 'safety_signal')
    expect(signals).toEqual([{ userId: null, event: 'safety_signal', properties: { level: 'crisis' } }])
    client.close()
  })

  it('без hello соединение закрывается как неавторизованное', async () => {
    const client = new WebSocket(gateway.wsUrl)
    await waitOpen(client)
    client.send(JSON.stringify({ type: DialogClientFrame.Message, clientId: 'c-1', text: 'привет' }))

    const error = await nextFrame(client, DialogServerFrame.Error)
    expect(error.code).toBe(DialogWsErrorCode.UNAUTHORIZED)
    const code = await new Promise<number>((resolve) => client.once('close', resolve))
    expect(code).toBe(DialogCloseCode.Unauthorized)
  })

  it('битый токен — UNAUTHORIZED', async () => {
    const client = new WebSocket(gateway.wsUrl)
    await waitOpen(client)
    client.send(JSON.stringify({ type: DialogClientFrame.Hello, token: 'garbage', dialogId: 'd-3' }))
    const error = await nextFrame(client, DialogServerFrame.Error)
    expect(error.code).toBe(DialogWsErrorCode.UNAUTHORIZED)
  })

  it('слишком длинная реплика отклоняется, соединение живёт', async () => {
    const { accessToken } = await gateway.signIn()
    const client = new WebSocket(gateway.wsUrl)
    await waitOpen(client)
    client.send(JSON.stringify({ type: DialogClientFrame.Hello, token: accessToken, dialogId: 'd-4' }))
    await agent.waitFor('d-4')

    client.send(JSON.stringify({ type: DialogClientFrame.Message, clientId: 'c-x', text: 'x'.repeat(5000) }))
    const error = await nextFrame(client, DialogServerFrame.Error)
    expect(error.code).toBe(DialogWsErrorCode.MESSAGE_TOO_LONG)
    expect(client.readyState).toBe(WebSocket.OPEN)

    client.close()
  })

  it('второе соединение того же человека закрывает первое', async () => {
    const { accessToken } = await gateway.signIn()
    const first = new WebSocket(gateway.wsUrl)
    await waitOpen(first)
    first.send(JSON.stringify({ type: DialogClientFrame.Hello, token: accessToken, dialogId: 'd-5' }))
    await agent.waitFor('d-5')

    const closed = new Promise<number>((resolve) => first.once('close', resolve))
    const second = new WebSocket(gateway.wsUrl)
    await waitOpen(second)
    second.send(JSON.stringify({ type: DialogClientFrame.Hello, token: accessToken, dialogId: 'd-5' }))

    expect(await closed).toBe(DialogCloseCode.Superseded)
    second.close()
  })

  it('бинарные кадры аудио идут агенту как есть', async () => {
    const { accessToken } = await gateway.signIn()
    const client = new WebSocket(gateway.wsUrl)
    await waitOpen(client)
    client.send(JSON.stringify({ type: DialogClientFrame.Hello, token: accessToken, dialogId: 'd-6' }))
    const agentSide = await agent.waitFor('d-6')

    const frame = Buffer.alloc(325)
    frame.writeUInt8(0x01, 0)
    frame.writeUInt32BE(1, 1)
    client.send(frame)

    await vi.waitFor(() => expect(agentSide.binaryFrames.length).toBeGreaterThan(0))
    expect(agentSide.binaryFrames.at(-1)!.readUInt8(0)).toBe(0x01)

    client.close()
  })

  describe('озвучка агента в кодеке, который выбрал клиент', () => {
    /** A frame of the agent's speech: kind 0x02, number, PCM16 at 24 kHz (a 220 Hz tone). */
    function speechFrame(sequence: number, samples = 4800): Buffer {
      const frame = Buffer.alloc(5 + samples * 2)
      frame.writeUInt8(0x02, 0)
      frame.writeUInt32BE(sequence, 1)
      for (let i = 0; i < samples; i++) {
        frame.writeInt16LE(
          Math.round(8000 * Math.sin((2 * Math.PI * 220 * (sequence * 4800 + i)) / 24_000)),
          5 + i * 2,
        )
      }
      return frame
    }

    type Received = Record<string, unknown> | Buffer

    /**
     * The client says `hello` with `codecs`, the agent voices one message (a full frame, the short end of
     * a sentence, another full frame) and then starts the next reply. Returns what the client got, in order.
     */
    async function voiceOneMessage(dialogId: string, codecs?: string[]) {
      const { accessToken } = await gateway.signIn()
      const client = new WebSocket(gateway.wsUrl)
      await waitOpen(client)
      const received: Received[] = []
      const done = new Promise<void>((resolve) => {
        client.on('message', (data: Buffer, isBinary: boolean) => {
          if (isBinary) return void received.push(data)
          const frame = JSON.parse(data.toString('utf8')) as Record<string, unknown>
          received.push(frame)
          if (frame.type === DialogServerFrame.AssistantStart) resolve()
        })
      })
      client.send(
        JSON.stringify({
          type: DialogClientFrame.Hello,
          token: accessToken,
          dialogId,
          ...(codecs ? { codecs } : {}),
        }),
      )
      const agentSide = await agent.waitFor(dialogId)
      const sent = [speechFrame(0), speechFrame(1, 1000), speechFrame(2)]
      agentSide.socket.send(JSON.stringify({ type: 'tts_start', messageId: 'm-1' }))
      for (const frame of sent) agentSide.socket.send(frame)
      agentSide.socket.send(JSON.stringify({ type: 'tts_end', messageId: 'm-1' }))
      agentSide.socket.send(JSON.stringify({ type: 'assistant_start', messageId: 'm-2' }))
      await done
      client.close()
      return { sent, received }
    }

    const kinds = (received: Received[]) =>
      received.map((entry) => (Buffer.isBuffer(entry) ? `audio ${entry.readUInt32BE(1)}` : entry.type))

    it('клиент без codecs в hello (старая сборка) получает PCM16 байт в байт, как раньше', async () => {
      const { sent, received } = await voiceOneMessage('d-codec-1')

      expect(kinds(received)).toEqual([
        'tts_start',
        'audio 0',
        'audio 1',
        'audio 2',
        'tts_end',
        'assistant_start',
      ])
      expect(received[0]).toMatchObject({ codec: 'pcm16', sampleRate: 24_000 })
      expect(received.filter(Buffer.isBuffer)).toEqual(sent)
    })

    it('mulaw: тот же кадр и номер, по байту на сэмпл, вдвое меньше', async () => {
      const { sent, received } = await voiceOneMessage('d-codec-2', ['mulaw', 'pcm16'])

      expect(received[0]).toMatchObject({
        type: DialogServerFrame.TtsStart,
        codec: 'mulaw',
        sampleRate: 24_000,
      })
      expect(kinds(received)).toEqual([
        'tts_start',
        'audio 0',
        'audio 1',
        'audio 2',
        'tts_end',
        'assistant_start',
      ])
      const audio = received.filter(Buffer.isBuffer)
      expect(audio.map((frame) => frame.length)).toEqual(sent.map((frame) => 5 + (frame.length - 5) / 2))
    })

    it('opus: пакеты по 20 мс с длиной впереди, хвост — отдельным кадром до tts_end, и всё это снова звук', async () => {
      const { received } = await voiceOneMessage('d-codec-3', ['opus', 'mulaw', 'pcm16'])

      expect(received[0]).toMatchObject({
        type: DialogServerFrame.TtsStart,
        codec: 'opus',
        sampleRate: 24_000,
      })
      // The tail of the short frame waits for the next one; what is left at the end comes as frame 3.
      expect(kinds(received)).toEqual([
        'tts_start',
        'audio 0',
        'audio 1',
        'audio 2',
        'audio 3',
        'tts_end',
        'assistant_start',
      ])

      const decoder = new opus.Decoder({ channels: 1, sample_rate: 24_000 })
      const packetCounts: number[] = []
      let samples = 0
      let bytes = 0
      for (const frame of received.filter(Buffer.isBuffer)) {
        bytes += frame.length
        let packets = 0
        for (let at = 5; at < frame.length; packets++) {
          const length = frame.readUInt16BE(at)
          samples += decoder.decode(frame.subarray(at + 2, at + 2 + length)).length / 2
          at += 2 + length
        }
        packetCounts.push(packets)
      }
      decoder.drop()
      expect(packetCounts).toEqual([10, 2, 10, 1])
      // 10600 samples went in; the decoder gives them back in whole packets.
      expect(samples).toBe(23 * 480)
      // 0.44 s of speech: PCM16 would be 21 KB.
      expect(bytes).toBeLessThan(3000)
    })

    it('агент договорил, прислал ended и сразу закрыл сокет: весь звук и ended доходят до закрытия', async () => {
      const { accessToken } = await gateway.signIn()
      const client = new WebSocket(gateway.wsUrl)
      await waitOpen(client)
      const received: string[] = []
      client.on('message', (data: Buffer, isBinary: boolean) => {
        received.push(isBinary ? 'audio' : (JSON.parse(data.toString('utf8')) as { type: string }).type)
      })
      const closed = new Promise<number>((resolve) => client.once('close', resolve))
      client.send(
        JSON.stringify({
          type: DialogClientFrame.Hello,
          token: accessToken,
          dialogId: 'd-codec-4',
          codecs: ['opus'],
        }),
      )
      const agentSide = await agent.waitFor('d-codec-4')

      agentSide.socket.send(JSON.stringify({ type: 'tts_start', messageId: 'bye' }))
      for (let sequence = 0; sequence < 10; sequence++) agentSide.socket.send(speechFrame(sequence))
      agentSide.socket.send(JSON.stringify({ type: 'tts_end', messageId: 'bye' }))
      agentSide.socket.send(JSON.stringify({ type: 'ended', summary: null }))
      agentSide.socket.close(1000, 'dialog ended')

      expect(await closed).toBe(DialogCloseCode.Done)
      expect(received).toEqual(['tts_start', ...Array<string>(10).fill('audio'), 'tts_end', 'ended'])
    })
  })

  it('пока под останавливают, новый сокет отвергается сразу кодом 1012', async () => {
    startDraining()
    try {
      const client = new WebSocket(gateway.wsUrl)
      const code = await new Promise<number>((resolve) => client.once('close', resolve))
      expect(code).toBe(DialogCloseCode.Restarting)
    } finally {
      resetDraining()
    }
  })

  it('перекат закрывает все диалоги кодом 1012, растянув закрытие во времени', async () => {
    const clients: WebSocket[] = []
    for (const index of [0, 1, 2]) {
      const { accessToken } = await gateway.signIn()
      const client = new WebSocket(gateway.wsUrl)
      await waitOpen(client)
      client.send(
        JSON.stringify({ type: DialogClientFrame.Hello, token: accessToken, dialogId: `d-roll-${index}` }),
      )
      await agent.waitFor(`d-roll-${index}`)
      clients.push(client)
    }

    const closedAt: number[] = []
    const started = Date.now()
    const closing = clients.map(
      (client) =>
        new Promise<number>((resolve) =>
          client.once('close', (code) => {
            closedAt.push(Date.now() - started)
            resolve(code)
          }),
        ),
    )
    closeAllDialogSessions(600)
    // All three got the code, and none later than the spread allows.
    const codes = await Promise.all(closing)
    expect(codes).toEqual([
      DialogCloseCode.Restarting,
      DialogCloseCode.Restarting,
      DialogCloseCode.Restarting,
    ])
    expect(Math.max(...closedAt)).toBeLessThan(1500)
  })

  /** A 100 ms microphone frame: kind byte, sequence number, then samples. */
  function micFrame(sequence: number): Buffer {
    const frame = Buffer.alloc(3205)
    frame.writeUInt8(0x01, 0)
    frame.writeUInt32BE(sequence, 1)
    return frame
  }

  it('долгая реплика и всплеск кадров после подвисания не рвут соединение', async () => {
    const { accessToken } = await gateway.signIn()
    const client = new WebSocket(gateway.wsUrl)
    await waitOpen(client)
    client.send(JSON.stringify({ type: DialogClientFrame.Hello, token: accessToken, dialogId: 'd-7' }))
    const agentSide = await agent.waitFor('d-7')

    client.send(JSON.stringify({ type: DialogClientFrame.AudioStart, sampleRate: 16000 }))
    // Four seconds of speech arriving at once: the count used to be per utterance, so anything
    // longer than two seconds cut the connection.
    for (let sequence = 0; sequence < 40; sequence++) client.send(micFrame(sequence))

    await vi.waitFor(() => expect(agentSide.binaryFrames).toHaveLength(40))
    expect(client.readyState).toBe(WebSocket.OPEN)

    client.close()
  })

  it('поток кадров быстрее, чем говорит человек, — RATE_LIMITED', async () => {
    const { accessToken } = await gateway.signIn()
    const client = new WebSocket(gateway.wsUrl)
    await waitOpen(client)
    client.send(JSON.stringify({ type: DialogClientFrame.Hello, token: accessToken, dialogId: 'd-8' }))
    await agent.waitFor('d-8')

    const closed = new Promise<number>((resolve) => client.once('close', resolve))
    client.send(JSON.stringify({ type: DialogClientFrame.AudioStart, sampleRate: 16000 }))
    for (let sequence = 0; sequence < 200; sequence++) client.send(micFrame(sequence))

    expect((await nextFrame(client, DialogServerFrame.Error)).code).toBe(DialogWsErrorCode.RATE_LIMITED)
    expect(await closed).toBe(DialogCloseCode.RateLimited)
  })

  describe('сессия, которую завершили', () => {
    /** Opens a dialog and waits until the agent side sees it, so the socket is past `hello`. */
    async function openDialog(accessToken: string, dialogId: string) {
      const client = new WebSocket(gateway.wsUrl)
      await waitOpen(client)
      client.send(JSON.stringify({ type: DialogClientFrame.Hello, token: accessToken, dialogId }))
      await agent.waitFor(dialogId)
      return client
    }
    const closedWith = (client: WebSocket) => new Promise<number>((resolve) => client.once('close', resolve))

    it('открытый диалог закрывается кодом Unauthorized после отзыва сессии', async () => {
      const { userId, accessToken } = await gateway.signIn()
      const client = await openDialog(accessToken, 'd-revoked-1')
      const closed = closedWith(client)

      await gateway.sessions.endAll(userId, null)

      expect(await closed).toBe(DialogCloseCode.Unauthorized)
    })

    it('закрывается и после выхода (logout) этой сессии, а чужая сессия того же человека не страдает', async () => {
      const { userId, accessToken, refreshToken } = await gateway.signIn()
      const client = await openDialog(accessToken, 'd-signed-out')
      const closed = closedWith(client)
      const payload = await gateway.jwt.verifyToken(refreshToken, 'refresh')
      await gateway.sessions.end(payload!.jti!)
      expect(await closed).toBe(DialogCloseCode.Unauthorized)

      // Another session of the same person is not touched by the first one's sign-out.
      const other = await gateway.sessions.start(userId, { clientId: null, userAgent: null })
      const second = await openDialog(other.accessToken, 'd-other-session')
      await new Promise((resolve) => setTimeout(resolve, 2500))
      expect(second.readyState).toBe(WebSocket.OPEN)
      second.close()
    })

    it('живой диалог не трогают: проверки проходят, соединение остаётся', async () => {
      const { accessToken } = await gateway.signIn()
      const client = await openDialog(accessToken, 'd-alive')

      // Two intervals of the check have passed by now.
      await new Promise((resolve) => setTimeout(resolve, 2500))

      expect(client.readyState).toBe(WebSocket.OPEN)
      client.close()
    })

    it('hello с access-токеном завершённой сессии отвергается: подпись ещё верна, а сессии нет', async () => {
      const { userId, accessToken } = await gateway.signIn()
      await gateway.sessions.endAll(userId, null)
      const client = new WebSocket(gateway.wsUrl)
      await waitOpen(client)

      client.send(
        JSON.stringify({ type: DialogClientFrame.Hello, token: accessToken, dialogId: 'd-late-hello' }),
      )

      const error = await nextFrame(client, DialogServerFrame.Error)
      expect(error.code).toBe(DialogWsErrorCode.UNAUTHORIZED)
      expect(await closedWith(client)).toBe(DialogCloseCode.Unauthorized)
      // The agent was never opened for it.
      expect(agent.opened('d-late-hello')).toBe(false)
    })

    it('токен, которого нет в реестре, отвергается: без записи о сессии доверять нечему', async () => {
      const { accessToken } = await gateway.jwt.issueTokenPair('99999999-9999-4999-8999-999999999999')
      const client = new WebSocket(gateway.wsUrl)
      await waitOpen(client)

      client.send(
        JSON.stringify({ type: DialogClientFrame.Hello, token: accessToken, dialogId: 'd-unknown-session' }),
      )

      expect((await nextFrame(client, DialogServerFrame.Error)).code).toBe(DialogWsErrorCode.UNAUTHORIZED)
    })
  })
})
