import { describe, expect, it, vi } from 'vitest'
import { createAnalyticsAdmin } from '../src/admin'

function makeAdmin(respond: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: URL; init: RequestInit }[] = []
  const fetchStub = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input))
    calls.push({ url, init })
    return respond(url, init)
  })
  const admin = createAnalyticsAdmin({
    apiHost: 'https://eu.posthog.com/',
    projectId: '300786',
    personalApiKey: 'phx_secret',
    fetch: fetchStub as unknown as typeof fetch,
  })
  return { admin, calls }
}

const accepted = () =>
  new Response(
    JSON.stringify({ persons_found: 1, persons_queued_for_deletion: 1, events_queued_for_deletion: true, deletion_errors: [] }),
    { status: 202 },
  )

describe('createAnalyticsAdmin', () => {
  it('просит PostHog стереть человека, события и записи — на хосте приложения, с личным ключом', async () => {
    const { admin, calls } = makeAdmin(accepted)
    expect(await admin.deletePerson('user-1')).toBe(true)

    const { url, init } = calls[0]!
    expect(url.href).toBe('https://eu.posthog.com/api/projects/300786/persons/bulk_delete/')
    expect(init.method).toBe('POST')
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer phx_secret')
    expect(JSON.parse(String(init.body))).toEqual({
      distinct_ids: ['user-1'],
      delete_events: true,
      delete_recordings: true,
    })
  })

  it('успех без тела (204) — тоже успех, а не ошибка разбора', async () => {
    const empty = makeAdmin(() => new Response(null, { status: 204 }))
    expect(await empty.admin.deletePerson('user-1')).toBe(true)
    const blank = makeAdmin(() => new Response('  ', { status: 202 }))
    expect(await blank.admin.deletePerson('user-1')).toBe(true)
  })

  it('ошибки удаления, отказ и сбой сети — false, а не исключение', async () => {
    const withErrors = makeAdmin(
      () => new Response(JSON.stringify({ deletion_errors: [{ distinct_id: 'user-1' }] }), { status: 202 }),
    )
    expect(await withErrors.admin.deletePerson('user-1')).toBe(false)

    const forbidden = makeAdmin(() => new Response('{"detail":"no"}', { status: 403 }))
    expect(await forbidden.admin.deletePerson('user-1')).toBe(false)

    const down = makeAdmin(() => {
      throw new Error('network down')
    })
    expect(await down.admin.deletePerson('user-1')).toBe(false)
  })
})
