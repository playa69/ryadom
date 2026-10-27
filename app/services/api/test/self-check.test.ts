/**
 * Tests inside the app over HTTP (`REQ-WELL-06`…`08`, `openspec/changes/add-self-check-tests`): the switch, the
 * consent, saving with a recount on the server, history, deletion, the withdrawal of the consent and the account's
 * deletion. The core and the database are real.
 */
import { asc, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { selfCheckConsentEvents, selfCheckResults, userConsents } from '@ryadom/db/schema'
import { getDb, maskPIIRecursively } from '@ryadom/core/shared'
import { SaveSelfCheckResultOperation } from '@ryadom/core/processes/self-check'
import {
  SELF_CHECK_CONSENT_VERSION,
  SelfCheckApiErrorCode,
  type DeleteSelfCheckApiResponse,
  type SelfCheckConsentApiResponse,
  type SelfCheckLatestApiResponse,
  type SelfCheckResultApi,
  type SelfCheckResultsApiResponse,
} from '@ryadom/contracts/api/self-check'
import { call, makeApp, mockAgent, ok, recordingAnalytics, refusedWith, signUpAndIn } from './helpers'

const analytics = recordingAnalytics()
const { app, resetLimits } = makeApp({ analytics })

async function signedIn() {
  resetLimits()
  const login = await signUpAndIn(app)
  return { token: login.tokens.accessToken, userId: login.user.id }
}

const consent = (token: string) =>
  call<SelfCheckConsentApiResponse>(
    app,
    'POST',
    '/api/self-check/consent',
    { version: SELF_CHECK_CONSENT_VERSION },
    token,
  )
// GAD-7: 1+2+1+1+1+1+1 = 8 из 21, «лёгкая выраженность».
const GAD7 = { testId: 'gad7', testVersion: 1, answers: [1, 2, 1, 1, 1, 1, 1] }

describe('сессия', () => {
  it('без сессии — 401', async () => {
    resetLimits()
    expect((await call(app, 'GET', '/api/self-check/latest')).status).toBe(401)
    expect((await call(app, 'POST', '/api/self-check/results', GAD7)).status).toBe(401)
  })
})

describe('согласие и сохранение', () => {
  it('первое сохранение: без согласия отказ CONSENT_REQUIRED, после согласия — результат; балл считает сервер', async () => {
    const { token } = await signedIn()
    expect(
      ok<SelfCheckConsentApiResponse>(await call(app, 'GET', '/api/self-check/consent', undefined, token)),
    ).toEqual({
      given: false,
      version: null,
    })
    refusedWith(
      await call(app, 'POST', '/api/self-check/results', GAD7, token),
      SelfCheckApiErrorCode.CONSENT_REQUIRED,
    )

    expect(ok<SelfCheckConsentApiResponse>(await consent(token))).toEqual({
      given: true,
      version: SELF_CHECK_CONSENT_VERSION,
    })
    // «Подменённый балл»: лишние поля тела (балл, уровень) сервер не читает, балл он считает сам по ответам.
    const saved = ok<SelfCheckResultApi>(
      await call(app, 'POST', '/api/self-check/results', { ...GAD7, score: 99, band: 'ничего' }, token),
    )
    expect(saved).toMatchObject({
      testId: 'gad7',
      testVersion: 1,
      score: 8,
      band: 'лёгкая выраженность',
      subscores: null,
    })

    const latest = ok<SelfCheckLatestApiResponse>(
      await call(app, 'GET', '/api/self-check/latest', undefined, token),
    )
    expect(latest.items).toHaveLength(1)
    expect(latest.items[0]).toMatchObject({ id: saved.id, score: 8 })
  })

  it('повторное согласие той же версии не ломается', async () => {
    const { token } = await signedIn()
    ok(await consent(token))
    ok(await consent(token))
  })

  it('неверные ответы, неизвестный тест и версия — 422', async () => {
    const { token } = await signedIn()
    ok(await consent(token))
    for (const body of [
      { ...GAD7, answers: [1, 2, 1] },
      { ...GAD7, answers: [1, 2, 1, 1, 1, 1, 9] },
      { ...GAD7, testId: 'нет-такого' },
      { ...GAD7, testVersion: 7 },
    ]) {
      expect((await call(app, 'POST', '/api/self-check/results', body, token)).status).toBe(422)
    }
  })

  it('подшкалы сохраняются строками, ответов в таблице нет', async () => {
    const { token, userId } = await signedIn()
    ok(await consent(token))
    const saved = ok<SelfCheckResultApi>(
      await call(
        app,
        'POST',
        '/api/self-check/results',
        { testId: 'mini-ipip', testVersion: 1, answers: Array.from({ length: 20 }, () => 3) },
        token,
      ),
    )
    expect(saved.subscores).toHaveLength(5)
    const [row] = await getDb().select().from(selfCheckResults).where(eq(selfCheckResults.userId, userId))
    expect(Object.keys(row ?? {}).sort()).toEqual([
      'band',
      'createdAt',
      'id',
      'score',
      'subscores',
      'takenAt',
      'testId',
      'testVersion',
      'userId',
    ])
  })

  it('ответы не попадают в журнал: у операции они замаскированы', () => {
    const masked = JSON.stringify(
      maskPIIRecursively(
        new SaveSelfCheckResultOperation({
          userId: 'u',
          testId: 'gad7',
          testVersion: 1,
          answers: [3, 3, 3, 3, 3, 3, 3],
        }),
      ),
    )
    expect(masked).not.toContain('[3,3,3,3,3,3,3]')
    expect(masked).toContain('gad7')
  })

  it('аналитика: только test_id, без баллов и уровней', async () => {
    analytics.events.length = 0
    const { token } = await signedIn()
    ok(await consent(token))
    ok(await call(app, 'POST', '/api/self-check/results', GAD7, token))
    const saved = analytics.events.filter((e) => e.event === 'self_check_saved')
    expect(saved).toHaveLength(1)
    expect(saved[0]?.properties).toEqual({ test_id: 'gad7' })
  })
})

describe('история и удаление', () => {
  async function withThree() {
    const { token, userId } = await signedIn()
    ok(await consent(token))
    const ids: string[] = []
    for (const [i, answers] of [
      [0, 0, 0, 0, 0, 0, 1],
      [1, 1, 1, 1, 1, 1, 1],
      [3, 3, 3, 3, 3, 3, 3],
    ].entries()) {
      const taken = new Date(Date.now() - (3 - i) * 86_400_000).toISOString()
      ids.push(
        ok<SelfCheckResultApi>(
          await call(app, 'POST', '/api/self-check/results', { ...GAD7, answers, takenAt: taken }, token),
        ).id,
      )
    }
    return { token, userId, ids }
  }

  it('история: новые сверху, страницы по limit, nextBefore', async () => {
    const { token, ids } = await withThree()
    const first = ok<SelfCheckResultsApiResponse>(
      await call(app, 'GET', '/api/self-check/results?testId=gad7&limit=2', undefined, token),
    )
    expect(first.items.map((r) => r.id)).toEqual([ids[2], ids[1]])
    expect(first.nextBefore).not.toBeNull()
    const next = ok<SelfCheckResultsApiResponse>(
      await call(
        app,
        'GET',
        `/api/self-check/results?testId=gad7&limit=2&before=${encodeURIComponent(first.nextBefore as string)}`,
        undefined,
        token,
      ),
    )
    expect(next.items.map((r) => r.id)).toEqual([ids[0]])
    expect(next.nextBefore).toBeNull()
  })

  it('удалить один, затем все результаты теста, затем все; чужой результат — 404', async () => {
    const { token, ids } = await withThree()
    const other = await signedIn()
    expect(
      (await call(app, 'DELETE', `/api/self-check/results/${ids[0]}`, undefined, other.token)).status,
    ).toBe(404)
    expect((await call(app, 'DELETE', '/api/self-check/results/not-a-uuid', undefined, token)).status).toBe(
      404,
    )

    expect(
      ok<DeleteSelfCheckApiResponse>(
        await call(app, 'DELETE', `/api/self-check/results/${ids[0]}`, undefined, token),
      ),
    ).toEqual({ deleted: 1 })
    expect((await call(app, 'DELETE', `/api/self-check/results/${ids[0]}`, undefined, token)).status).toBe(
      404,
    )
    expect(
      ok<DeleteSelfCheckApiResponse>(
        await call(app, 'DELETE', '/api/self-check/results?testId=gad7', undefined, token),
      ),
    ).toEqual({ deleted: 2 })
    ok(await call(app, 'POST', '/api/self-check/results', GAD7, token))
    ok(
      await call(
        app,
        'POST',
        '/api/self-check/results',
        { testId: 'k6', testVersion: 1, answers: [1, 1, 1, 1, 1, 1] },
        token,
      ),
    )
    expect(
      ok<DeleteSelfCheckApiResponse>(await call(app, 'DELETE', '/api/self-check/results', undefined, token))
        .deleted,
    ).toBe(2)
    expect(
      ok<SelfCheckLatestApiResponse>(await call(app, 'GET', '/api/self-check/latest', undefined, token))
        .items,
    ).toEqual([])
  })

  it('отзыв согласия удаляет все результаты и снова требует согласия', async () => {
    const { token } = await withThree()
    expect(
      ok<DeleteSelfCheckApiResponse>(await call(app, 'DELETE', '/api/self-check/consent', undefined, token))
        .deleted,
    ).toBe(3)
    expect(
      ok<SelfCheckResultsApiResponse>(await call(app, 'GET', '/api/self-check/results', undefined, token))
        .items,
    ).toEqual([])
    expect(
      ok<SelfCheckConsentApiResponse>(await call(app, 'GET', '/api/self-check/consent', undefined, token))
        .given,
    ).toBe(false)
    refusedWith(
      await call(app, 'POST', '/api/self-check/results', GAD7, token),
      SelfCheckApiErrorCode.CONSENT_REQUIRED,
    )
  })

  it('удаление аккаунта стирает результаты до ответа', async () => {
    const { token, userId } = await withThree()
    mockAgent()
    expect(ok(await call(app, 'DELETE', '/api/auth/me', undefined, token))).toBeNull()
    expect(await getDb().select().from(selfCheckResults).where(eq(selfCheckResults.userId, userId))).toEqual(
      [],
    )
  })
})

describe('журнал согласия', () => {
  it('выдано → отозвано → выдано: три события по порядку, первая запись согласия остаётся', async () => {
    const { token, userId } = await signedIn()
    ok(await consent(token))
    ok(await consent(token)) // a repeat adds nothing
    ok(await call(app, 'DELETE', '/api/self-check/consent', undefined, token))
    ok(await call(app, 'DELETE', '/api/self-check/consent', undefined, token)) // already withdrawn: nothing more
    ok(await consent(token))
    const events = await getDb()
      .select()
      .from(selfCheckConsentEvents)
      .where(eq(selfCheckConsentEvents.userId, userId))
      .orderBy(asc(selfCheckConsentEvents.at))
    expect(events.map((e) => e.action)).toEqual(['granted', 'revoked', 'granted'])
    expect(events.every((e) => e.version === SELF_CHECK_CONSENT_VERSION)).toBe(true)
    expect(await getDb().select().from(userConsents).where(eq(userConsents.userId, userId))).toHaveLength(4) // 3 of the first screen + this one
    expect(
      ok<SelfCheckConsentApiResponse>(await call(app, 'GET', '/api/self-check/consent', undefined, token))
        .given,
    ).toBe(true)
  })
})

describe('счётчик кризисных ответов', () => {
  it('растёт без входа и без человека; неизвестный тест не считается; метрики читаются на /metrics', async () => {
    resetLimits()
    const before = await (await app.request('/metrics')).text()
    const base = Number(/self_check_crisis_total\{test="phq9"\} (\d+)/.exec(before)?.[1] ?? 0)
    expect(ok(await call(app, 'POST', '/api/self-check/crisis', { testId: 'phq9' }))).toBeNull()
    expect(ok(await call(app, 'POST', '/api/self-check/crisis', { testId: 'нет-такого' }))).toBeNull()
    const after = await (await app.request('/metrics')).text()
    expect(after).toContain(`self_check_crisis_total{test="phq9"} ${base + 1}`)
    expect(after).not.toContain('нет-такого')
  })
})
