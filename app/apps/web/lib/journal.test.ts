import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@ryadom/client-core/errors'
import type { RyadomClient } from '@ryadom/client-core/client'
import type { DialogListItemApiResponse, ListDialogsApiResponse } from '@ryadom/contracts/api/dialogs'
import { DialogMode } from '@ryadom/contracts/api/dialogs'
import { formatJournalDate, journal, tensionLabel } from './journal'

// The hooks are not under test, and auth.tsx is JSX that a bare vitest run (tsconfig: jsx preserve) cannot parse.
vi.mock('./auth', () => ({ useAuth: vi.fn(), useClient: vi.fn() }))

function item(
  dialogId: string,
  summary: DialogListItemApiResponse['summary'] = null,
): DialogListItemApiResponse {
  return { dialogId, mode: DialogMode.Vent, startedAt: '2026-10-01T11:30:00.000Z', endedAt: null, summary }
}

interface Deferred {
  promise: Promise<ListDialogsApiResponse>
  resolve(items: DialogListItemApiResponse[]): void
  reject(error: unknown): void
}

function deferred(): Deferred {
  let resolve!: Deferred['resolve']
  let reject!: Deferred['reject']
  const promise = new Promise<ListDialogsApiResponse>((res, rej) => {
    resolve = (items) => res({ items, next: null })
    reject = rej
  })
  return { promise, resolve, reject }
}

function clientWith(listDialogs: (before?: string) => Promise<ListDialogsApiResponse>): RyadomClient {
  return { listDialogs } as unknown as RyadomClient
}

afterEach(() => journal.reset())

describe('журнал: список', () => {
  it('загружает список и сбрасывает ошибку', async () => {
    const client = clientWith(() => Promise.resolve({ items: [item('a')], next: null }))
    await journal.refresh(client, 'user-1')
    expect(journal.snapshot().items).toEqual([item('a')])
    expect(journal.snapshot().error).toBe('')
  })

  it('параллельные вызовы делят один запрос', async () => {
    const listDialogs = vi.fn(() => Promise.resolve({ items: [], next: null }))
    const client = clientWith(listDialogs)
    await Promise.all([journal.refresh(client, 'user-1'), journal.refresh(client, 'user-1')])
    expect(listDialogs).toHaveBeenCalledTimes(1)
  })

  it('неудачное обновление не стирает загруженный список', async () => {
    await journal.refresh(
      clientWith(() => Promise.resolve({ items: [item('a')], next: null })),
      'user-1',
    )
    await journal.refresh(
      clientWith(() => Promise.reject(new ApiError(500))),
      'user-1',
    )
    expect(journal.snapshot().items).toEqual([item('a')])
    expect(journal.snapshot().error).not.toBe('')
  })

  it('первая неудача даёт пустой список с ошибкой', async () => {
    await journal.refresh(
      clientWith(() => Promise.reject(new ApiError(0))),
      'user-1',
    )
    expect(journal.snapshot().items).toEqual([])
    expect(journal.snapshot().error).not.toBe('')
  })
})

describe('журнал: страницы', () => {
  const ids = (): string[] => (journal.snapshot().items ?? []).map((i) => i.dialogId)

  it('запоминает курсор следующей страницы', async () => {
    await journal.refresh(
      clientWith(() => Promise.resolve({ items: [item('a')], next: 'c1' })),
      'user-1',
    )
    expect(journal.snapshot().next).toBe('c1')
  })

  it('«показать ещё» дописывает страницу по курсору и берёт новый', async () => {
    const listDialogs = vi.fn((before?: string) =>
      Promise.resolve(before ? { items: [item('b')], next: null } : { items: [item('a')], next: 'c1' }),
    )
    const client = clientWith(listDialogs)
    await journal.refresh(client, 'user-1')
    await journal.loadMore(client, 'user-1')
    expect(listDialogs).toHaveBeenLastCalledWith('c1')
    expect(ids()).toEqual(['a', 'b'])
    expect(journal.snapshot().next).toBeNull()
  })

  it('без курсора ничего не запрашивает, параллельные вызовы делят один запрос', async () => {
    const listDialogs = vi.fn((before?: string) =>
      Promise.resolve(before ? { items: [item('b')], next: null } : { items: [item('a')], next: 'c1' }),
    )
    const client = clientWith(listDialogs)
    await journal.loadMore(client, 'user-1')
    expect(listDialogs).not.toHaveBeenCalled()

    await journal.refresh(client, 'user-1')
    await Promise.all([journal.loadMore(client, 'user-1'), journal.loadMore(client, 'user-1')])
    expect(listDialogs).toHaveBeenCalledTimes(2)
    expect(ids()).toEqual(['a', 'b'])
  })

  it('обновление не сворачивает открытые страницы и не дублирует разговоры', async () => {
    await journal.refresh(
      clientWith(() => Promise.resolve({ items: [item('a'), item('b')], next: 'c1' })),
      'user-1',
    )
    await journal.loadMore(
      clientWith(() => Promise.resolve({ items: [item('c'), item('d')], next: 'c2' })),
      'user-1',
    )
    // A new conversation pushed "b" off the newest page: it must stay once, in its place.
    await journal.refresh(
      clientWith(() => Promise.resolve({ items: [item('n'), item('a')], next: 'c0' })),
      'user-1',
    )
    expect(ids()).toEqual(['n', 'a', 'b', 'c', 'd'])
    expect(journal.snapshot().next).toBe('c2')
  })

  it('если новая страница целиком новее загруженного, остаётся только она', async () => {
    await journal.refresh(
      clientWith(() => Promise.resolve({ items: [item('a')], next: 'c1' })),
      'user-1',
    )
    await journal.refresh(
      clientWith(() => Promise.resolve({ items: [item('x'), item('y')], next: 'c9' })),
      'user-1',
    )
    expect(ids()).toEqual(['x', 'y'])
    expect(journal.snapshot().next).toBe('c9')
  })

  it('сбой «показать ещё» оставляет список и курсор для повтора', async () => {
    const client = clientWith(() => Promise.resolve({ items: [item('a')], next: 'c1' }))
    await journal.refresh(client, 'user-1')
    await journal.loadMore(
      clientWith(() => Promise.reject(new ApiError(500))),
      'user-1',
    )
    expect(ids()).toEqual(['a'])
    expect(journal.snapshot()).toMatchObject({ next: 'c1' })
    expect(journal.snapshot().error).not.toBe('')
  })

  it('страница прошлого аккаунта не попадает в список нового', async () => {
    const slow = deferred()
    await journal.refresh(
      clientWith(() => Promise.resolve({ items: [item('a')], next: 'c1' })),
      'user-1',
    )
    const pending = journal.loadMore(
      clientWith(() => slow.promise),
      'user-1',
    )
    await journal.refresh(
      clientWith(() => Promise.resolve({ items: [item('b')], next: null })),
      'user-2',
    )
    slow.resolve([item('z')])
    await pending
    expect(ids()).toEqual(['b'])
    expect(journal.snapshot().owner).toBe('user-2')
  })
})

describe('журнал: смена аккаунта', () => {
  it('ответ на запрос прошлого аккаунта не попадает в состояние нового', async () => {
    const slow = deferred()
    const first = journal.refresh(
      clientWith(() => slow.promise),
      'user-1',
    )

    const second = journal.refresh(
      clientWith(() => Promise.resolve({ items: [item('b')], next: null })),
      'user-2',
    )
    await second
    slow.resolve([item('a')])
    await first

    expect(journal.snapshot().owner).toBe('user-2')
    expect(journal.snapshot().items).toEqual([item('b')])
  })

  it('сброс во время запроса отбрасывает его результат', async () => {
    const slow = deferred()
    const pending = journal.refresh(
      clientWith(() => slow.promise),
      'user-1',
    )
    journal.reset()
    slow.resolve([item('a')])
    await pending
    expect(journal.snapshot().items).toBeNull()
  })

  it('новый аккаунт не наследует список и ошибку прошлого', async () => {
    await journal.refresh(
      clientWith(() => Promise.reject(new ApiError(500))),
      'user-1',
    )
    expect(journal.snapshot().error).not.toBe('')
    await journal.refresh(
      clientWith(() => Promise.resolve({ items: [item('b')], next: null })),
      'user-2',
    )
    expect(journal.snapshot()).toMatchObject({ owner: 'user-2', items: [item('b')], error: '' })
  })
})

describe('журнал: подписи', () => {
  it('показывает напряжение до и после', () => {
    const summary = { title: 'Т', themes: [], tensionBefore: 7, tensionAfter: 4 }
    expect(tensionLabel(item('a', summary))).toBe('7 → 4')
    expect(tensionLabel(item('a', { ...summary, tensionAfter: null }))).toBe('было 7')
    expect(tensionLabel(item('a', { ...summary, tensionBefore: null }))).toBeNull()
    expect(tensionLabel(item('a'))).toBeNull()
  })

  it('форматирует дату как «1 октября, 14:30»', () => {
    expect(formatJournalDate('2026-10-01T11:30:00.000Z')).toMatch(/^\d{1,2} октября, \d{2}:\d{2}$/)
    expect(formatJournalDate('не дата')).toBe('')
  })
})
