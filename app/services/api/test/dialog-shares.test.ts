/**
 * Links to one conversation (`REQ-DATA-05`): the owner's routes and the open view.
 */
import { describe, expect, it } from 'vitest'
import { getDb } from '@ryadom/core/shared'
import { dialogShares } from '@ryadom/db/schema'
import { eq } from 'drizzle-orm'
import { DialogApiErrorCode } from '@ryadom/contracts/api/dialogs'
import {
  DialogShareApiErrorCode,
  type DialogShareApiResponse,
  type SharedDialogApiResponse,
} from '@ryadom/contracts/api/dialog-shares'
import { call, json, makeApp, mockAgent, ok, refusedWith, signUpAndIn } from './helpers'

const { app, resetLimits } = makeApp()

const dialog = (endedAt: string | null = '2026-10-01T20:30:00.000Z') =>
  json({
    dialogId: 'd-1',
    mode: 'vent',
    startedAt: '2026-10-01T20:00:00.000Z',
    endedAt,
    summary: { title: 'Про работу', themes: ['работа'], tensionBefore: 7, tensionAfter: 4 },
    messages: [
      { id: 'm1', role: 'assistant', text: 'Привет', createdAt: '2026-10-01T20:00:01.000Z' },
      { id: 'm2', role: 'user', text: 'Тяжёлый день', createdAt: '2026-10-01T20:01:00.000Z' },
    ],
  })

const tokenOf = (url: string) => url.slice(url.lastIndexOf('/') + 1)

describe('ссылка на разговор', () => {
  it('создаётся, читается повторно той же ссылкой, открывается без входа и не показывает лишнего', async () => {
    resetLimits()
    const { tokens } = await signUpAndIn(app)
    mockAgent({ 'GET http://agent.test/v1/users/*/dialogs/*': () => dialog() })

    expect(ok(await call(app, 'GET', '/api/dialogs/d-1/share', undefined, tokens.accessToken))).toBeNull()
    const created = ok<DialogShareApiResponse>(
      await call(app, 'POST', '/api/dialogs/d-1/share', { ttlHours: 72 }, tokens.accessToken),
    )
    expect(created.url).toMatch(/\/s\/[A-Za-z0-9_-]{43}$/)
    expect(Date.parse(created.expiresAt) - Date.parse(created.createdAt)).toBe(72 * 3_600_000)

    // Seen again, the same link: the token is derived, not stored.
    const again = ok<DialogShareApiResponse>(await call(app, 'GET', '/api/dialogs/d-1/share', undefined, tokens.accessToken))
    expect(again.url).toBe(created.url)

    const rows = await getDb().select().from(dialogShares).where(eq(dialogShares.id, created.shareId))
    expect(JSON.stringify(rows)).not.toContain(tokenOf(created.url))

    // A stranger opens it: no Authorization header.
    const view = await app.request(`/api/shared/${tokenOf(created.url)}`)
    expect(view.status).toBe(200)
    expect(view.headers.get('cache-control')).toBe('no-store')
    expect(view.headers.get('referrer-policy')).toBe('no-referrer')
    expect(view.headers.get('x-robots-tag')).toBe('noindex, nofollow')
    const body = (await view.json()) as { status: true; result: SharedDialogApiResponse }
    expect(body.result.messages.map((m) => m.text)).toEqual(['Привет', 'Тяжёлый день'])
    expect(JSON.stringify(body)).not.toMatch(/summary|tension|themes|dialogId|d-1|userId|email/)

    const counted = ok<DialogShareApiResponse>(await call(app, 'GET', '/api/dialogs/d-1/share', undefined, tokens.accessToken))
    expect(counted.viewCount).toBe(1)
  })

  it('у не сохраняемого разговора ссылку создать нельзя: он есть только в памяти агента', async () => {
    resetLimits()
    const { tokens } = await signUpAndIn(app)
    mockAgent({
      'GET http://agent.test/v1/users/*/dialogs/*': () =>
        json({
          dialogId: 'd-1',
          startedAt: '2026-10-01T20:00:00.000Z',
          endedAt: null,
          summary: null,
          memoryMode: 'off',
          saved: false,
          messages: [{ id: 'm2', role: 'user', text: 'Тяжёлый день', createdAt: '2026-10-01T20:01:00.000Z' }],
        }),
    })
    refusedWith(
      await call(app, 'POST', '/api/dialogs/d-1/share', {}, tokens.accessToken),
      DialogApiErrorCode.DIALOG_NOT_FOUND,
    )
    expect(ok(await call(app, 'GET', '/api/dialogs/d-1/share', undefined, tokens.accessToken))).toBeNull()
  })

  it('одна активная ссылка на разговор, срок только из списка', async () => {
    resetLimits()
    const { tokens } = await signUpAndIn(app)
    mockAgent({ 'GET http://agent.test/v1/users/*/dialogs/*': () => dialog() })
    ok(await call(app, 'POST', '/api/dialogs/d-1/share', {}, tokens.accessToken))
    refusedWith(await call(app, 'POST', '/api/dialogs/d-1/share', {}, tokens.accessToken), DialogShareApiErrorCode.SHARE_EXISTS)
    const bad = await call(app, 'POST', '/api/dialogs/d-2/share', { ttlHours: 1 }, tokens.accessToken)
    expect(bad.status).not.toBe(200)
  })

  it('отзыв: ссылка сразу «больше не действует», потом можно создать новую; отзыв идемпотентен', async () => {
    resetLimits()
    const { tokens } = await signUpAndIn(app)
    mockAgent({ 'GET http://agent.test/v1/users/*/dialogs/*': () => dialog() })
    const first = ok<DialogShareApiResponse>(await call(app, 'POST', '/api/dialogs/d-1/share', {}, tokens.accessToken))
    ok(await call(app, 'DELETE', '/api/dialogs/d-1/share', undefined, tokens.accessToken))
    ok(await call(app, 'DELETE', '/api/dialogs/d-1/share', undefined, tokens.accessToken))
    const gone = await app.request(`/api/shared/${tokenOf(first.url)}`)
    expect(gone.status).toBe(404)
    const second = ok<DialogShareApiResponse>(await call(app, 'POST', '/api/dialogs/d-1/share', {}, tokens.accessToken))
    expect(second.url).not.toBe(first.url)
  })

  it('неизвестная, просроченная и отозванная ссылки отвечают одинаково', async () => {
    resetLimits()
    const { tokens } = await signUpAndIn(app)
    mockAgent({ 'GET http://agent.test/v1/users/*/dialogs/*': () => dialog() })
    const expired = ok<DialogShareApiResponse>(await call(app, 'POST', '/api/dialogs/d-1/share', {}, tokens.accessToken))
    await getDb().update(dialogShares).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(dialogShares.id, expired.shareId))
    const a = await app.request(`/api/shared/${tokenOf(expired.url)}`)
    const b = await app.request('/api/shared/' + 'x'.repeat(43))
    expect(a.status).toBe(404)
    expect(b.status).toBe(404)
    expect(await a.text()).toBe(await b.text())
    expect(b.headers.get('cache-control')).toBe('no-store')
  })

  it('удалённый у агента разговор, недоступный агент, заблокированный владелец', async () => {
    resetLimits()
    const { tokens, user } = await signUpAndIn(app)
    mockAgent({ 'GET http://agent.test/v1/users/*/dialogs/*': () => dialog() })
    const share = ok<DialogShareApiResponse>(await call(app, 'POST', '/api/dialogs/d-1/share', {}, tokens.accessToken))
    const path = `/api/shared/${tokenOf(share.url)}`

    mockAgent({ 'GET http://agent.test/v1/users/*/dialogs/*': () => json({ error: 'not_found' }, 404) })
    expect((await app.request(path)).status).toBe(404)

    mockAgent({ 'GET http://agent.test/v1/users/*/dialogs/*': () => json({ error: 'boom' }, 502) })
    expect((await app.request(path)).status).toBe(503)

    mockAgent({ 'GET http://agent.test/v1/users/*/dialogs/*': () => dialog() })
    expect((await app.request(path)).status).toBe(200)
    const { users } = await import('@ryadom/db/schema')
    await getDb().update(users).set({ isActive: false }).where(eq(users.id, user.id))
    expect((await app.request(path)).status).toBe(404)
  })

  it('граница среза: сообщения после создания ссылки не видны', async () => {
    resetLimits()
    const { tokens } = await signUpAndIn(app)
    let withMore = false
    mockAgent({
      'GET http://agent.test/v1/users/*/dialogs/*': () => {
        const base = [
          { id: 'm1', role: 'assistant', text: 'Привет', createdAt: '2026-10-01T20:00:01.000Z' },
          { id: 'm2', role: 'user', text: 'Тяжёлый день', createdAt: '2026-10-01T20:01:00.000Z' },
        ]
        if (withMore) base.push({ id: 'm3', role: 'user', text: 'Новое, после ссылки', createdAt: '2026-10-01T21:00:00.000Z' })
        return json({ dialogId: 'd-1', mode: 'vent', startedAt: '2026-10-01T20:00:00.000Z', endedAt: null, summary: null, messages: base })
      },
    })
    const share = ok<DialogShareApiResponse>(await call(app, 'POST', '/api/dialogs/d-1/share', {}, tokens.accessToken))
    withMore = true
    const view = (await (await app.request(`/api/shared/${tokenOf(share.url)}`)).json()) as { result: SharedDialogApiResponse }
    expect(view.result.messages.map((m) => m.text)).toEqual(['Привет', 'Тяжёлый день'])
    expect(view.result.isOpen).toBe(true)
  })

  it('чужого или пустого разговора нет; без входа создать нельзя', async () => {
    resetLimits()
    const { tokens } = await signUpAndIn(app)
    mockAgent({ 'GET http://agent.test/v1/users/*/dialogs/*': () => json({ error: 'not_found' }, 404) })
    refusedWith(await call(app, 'POST', '/api/dialogs/d-x/share', {}, tokens.accessToken), DialogApiErrorCode.DIALOG_NOT_FOUND)
    const anon = await app.request('/api/dialogs/d-1/share', { method: 'POST' })
    expect(anon.status).toBe(401)
  })

  it('не больше пяти активных ссылок на аккаунт', async () => {
    resetLimits()
    const { tokens } = await signUpAndIn(app)
    mockAgent({ 'GET http://agent.test/v1/users/*/dialogs/*': () => dialog() })
    for (let i = 1; i <= 5; i++) ok(await call(app, 'POST', `/api/dialogs/d-${i}/share`, {}, tokens.accessToken))
    refusedWith(await call(app, 'POST', '/api/dialogs/d-6/share', {}, tokens.accessToken), DialogShareApiErrorCode.SHARE_LIMIT)
  })
})
