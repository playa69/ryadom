/**
 * "Erase everything": the agent's data first, then the account.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  accountDeletionProcess,
  DeleteAccountOperation,
  DeleteAccountOperationErrorCode,
} from '../src/processes/account-deletion'
import { refreshTokensManager } from '../src/managers/refresh-tokens-manager'
import { ERASE_PERSON_DELAY_SECONDS, getEnqueuedJobs } from '../src/services/job-queue-service'
import { AgentUnavailableError } from '../src/shared'
import { LoginOperationErrorCode } from '../src/processes/authentication'
import {
  countRows,
  getUserRow,
  json,
  login,
  mockAgent,
  mockFetch,
  noContent,
  registerConfirmedUser,
  registerUser,
} from './helpers'

const deleteAccount = (userId: string) =>
  accountDeletionProcess.execute(new DeleteAccountOperation({ userId }))

describe('удаление аккаунта', () => {
  it('стирает данные у агента, анонимизирует строку и освобождает почту', async () => {
    const user = await registerConfirmedUser()
    const { calls } = mockAgent()

    expect(await deleteAccount(user.id)).toEqual({ success: true })

    // The agent was called with our userId; otherwise there would be nothing to erase.
    const erase = calls.find((call) => call.method === 'DELETE')
    expect(erase?.url.pathname).toBe(`/v1/users/${user.id}`)

    const row = await getUserRow(user.id)
    expect(row?.isDeleted).toBe(true)
    expect(row?.email).toMatch(/anonymized/)
    expect(row?.name).toBeNull()
    expect(row?.properties).toMatchObject({
      deletion: { reason: 'user_request', agent_data_erased: true, profile: { email: user.email } },
    })

    // The password and the codes are gone, so signing in is impossible.
    expect(await countRows(user.id, user.email)).toEqual({ credentials: 0, codes: 0 })
    expect(await login(user.email)).toEqual({
      success: false,
      error: LoginOperationErrorCode.INVALID_CREDENTIALS,
    })

    // The address is free for a new registration.
    const fresh = await registerUser({ email: user.email })
    expect(fresh.id).not.toBe(user.id)
  })

  it('повтор — ALREADY_DELETED, неизвестный id — USER_NOT_FOUND', async () => {
    const user = await registerConfirmedUser()
    mockAgent()
    expect(await deleteAccount(user.id)).toEqual({ success: true })
    expect(await deleteAccount(user.id)).toEqual({
      success: false,
      error: DeleteAccountOperationErrorCode.ALREADY_DELETED,
    })
    expect(await deleteAccount('00000000-0000-4000-8000-000000000000')).toEqual({
      success: false,
      error: DeleteAccountOperationErrorCode.USER_NOT_FOUND,
    })
  })

  it('агент не стёр данные — аккаунт остаётся на месте', async () => {
    const user = await registerConfirmedUser()
    mockFetch({ 'DELETE http://agent.test/v1/users/*': () => json({ error: 'boom' }, 503) })

    await expect(deleteAccount(user.id)).rejects.toBeInstanceOf(AgentUnavailableError)

    // Nothing was touched: the promise to erase everything was not kept, so nothing may be deleted.
    expect((await getUserRow(user.id))?.isDeleted).toBe(false)
    expect((await countRows(user.id, user.email)).credentials).toBe(1)
    expect((await login(user.email)).success).toBe(true)
  })

  it('агенту нечего стирать (404) — это успех', async () => {
    const user = await registerConfirmedUser()
    mockFetch({ 'DELETE http://agent.test/v1/users/*': () => json({ error: 'not_found' }, 404) })
    expect(await deleteAccount(user.id)).toEqual({ success: true })
    expect((await getUserRow(user.id))?.isDeleted).toBe(true)
  })

  it('204 без тела разбирается как успех', async () => {
    const user = await registerConfirmedUser()
    mockFetch({ 'DELETE http://agent.test/v1/users/*': () => noContent() })
    expect(await deleteAccount(user.id)).toEqual({ success: true })
  })
})

describe('стирание профиля в аналитике ставится вместе с удалением', () => {
  // `openspec/changes/archive/2026-10-27-add-job-queue`, «Профиль и события в аналитике»: «(API) Удаление человеком», «(API) Удаление не состоялось».
  it('(API) Удаление человеком: в очереди задача на стирание с выдержкой 30 секунд и ключом-человеком', async () => {
    const user = await registerConfirmedUser()
    mockAgent()

    expect(await deleteAccount(user.id)).toEqual({ success: true })

    // Only the identifier: no text, no email, no name (design D6).
    expect(getEnqueuedJobs()).toEqual([
      expect.objectContaining({
        queue: 'analytics.erase-person',
        data: { userId: user.id },
        startAfterSeconds: ERASE_PERSON_DELAY_SECONDS,
        singletonKey: user.id,
      }),
    ])
    expect(ERASE_PERSON_DELAY_SECONDS).toBe(30)
  })

  it('(API) Удаление не состоялось: агент не стёр данные, аккаунт на месте и задачи нет', async () => {
    const user = await registerConfirmedUser()
    mockFetch({ 'DELETE http://agent.test/v1/users/*': () => json({ error: 'boom' }, 503) })

    await expect(deleteAccount(user.id)).rejects.toBeInstanceOf(AgentUnavailableError)

    expect(getEnqueuedJobs()).toEqual([])
  })

  it('(API) Удаление не состоялось: сбой на последнем шаге транзакции — задача не ставится (она последняя в транзакции)', async () => {
    const user = await registerConfirmedUser()
    mockAgent()
    const failing = vi.spyOn(refreshTokensManager, 'execute').mockRejectedValueOnce(new Error('the database failed'))

    await expect(deleteAccount(user.id)).rejects.toThrow('the database failed')
    failing.mockRestore()

    expect((await getUserRow(user.id))?.isDeleted).toBe(false)
    expect(getEnqueuedJobs()).toEqual([])
    // The same request goes through afterwards, and then the job is queued.
    expect(await deleteAccount(user.id)).toEqual({ success: true })
    expect(getEnqueuedJobs()).toHaveLength(1)
  })

  it('повторный запрос на удаление не ставит вторую задачу', async () => {
    const user = await registerConfirmedUser()
    mockAgent()

    await deleteAccount(user.id)
    await deleteAccount(user.id)

    expect(getEnqueuedJobs()).toHaveLength(1)
  })

  it('без транспорта очереди удаление не проходит: аккаунт остаётся, профиль в аналитике не теряется молча', async () => {
    const { registerJobQueueTransport } = await import('../src/services/job-queue-service')
    const user = await registerConfirmedUser()
    mockAgent()
    registerJobQueueTransport(undefined)

    await expect(deleteAccount(user.id)).rejects.toThrow('No job queue transport')

    // The transaction rolled back with the failed step: the account is whole, the person can ask again.
    expect((await getUserRow(user.id))?.isDeleted).toBe(false)
  })
})
