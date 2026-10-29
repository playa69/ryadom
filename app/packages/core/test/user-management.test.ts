/**
 * Admin actions and the audit log.
 */
import { describe, expect, it } from 'vitest'
import {
  accountDeletionProcess,
  DeleteUserAccountOperation,
  DeleteUserAccountOperationErrorCode,
} from '../src/processes/account-deletion'
import {
  ConfirmUserEmailOperation,
  RevokeUserSessionsOperation,
  ToggleUserActivationOperation,
  ToggleUserActivationOperationErrorCode,
  userManagementProcess,
} from '../src/processes/user-management'
import { LoginOperationErrorCode } from '../src/processes/authentication'
import {
  getEnqueuedJobs,
  memoryJobQueueTransport,
  registerJobQueueTransport,
} from '../src/services/job-queue-service'
import {
  ADMIN_EMAIL,
  auditRows,
  getUserRow,
  login,
  mockAgent,
  registerConfirmedUser,
  registerUser,
} from './helpers'

const toggle = (userId: string) =>
  userManagementProcess.execute(new ToggleUserActivationOperation({ adminEmail: ADMIN_EMAIL, userId }))

describe('блокировка', () => {
  it('блокирует и разблокирует, пишет в журнал', async () => {
    const user = await registerConfirmedUser()

    expect(await toggle(user.id)).toEqual({ success: true, isActive: false })
    expect(await login(user.email)).toEqual({ success: false, error: LoginOperationErrorCode.USER_INACTIVE })

    expect(await toggle(user.id)).toEqual({ success: true, isActive: true })
    expect((await login(user.email)).success).toBe(true)

    const journal = await auditRows()
    expect(journal.map((row) => row.action)).toEqual(['USER_BLOCKED', 'USER_UNBLOCKED'])
    expect(journal[0]).toMatchObject({
      adminEmail: ADMIN_EMAIL,
      targetUserId: user.id,
      targetEmail: user.email,
    })
  })

  it('удалённый аккаунт не блокируется', async () => {
    const user = await registerConfirmedUser()
    mockAgent()
    await accountDeletionProcess.execute(
      new DeleteUserAccountOperation({ adminEmail: ADMIN_EMAIL, userId: user.id }),
    )
    expect(await toggle(user.id)).toEqual({
      success: false,
      error: ToggleUserActivationOperationErrorCode.USER_DELETED,
    })
  })
})

describe('подтверждение почты админом', () => {
  it('открывает вход и пишет в журнал', async () => {
    const user = await registerUser()
    expect(await login(user.email)).toEqual({
      success: false,
      error: LoginOperationErrorCode.EMAIL_NOT_CONFIRMED,
    })

    const result = await userManagementProcess.execute(
      new ConfirmUserEmailOperation({ adminEmail: ADMIN_EMAIL, userId: user.id }),
    )
    expect(result).toEqual({ success: true })
    expect((await login(user.email)).success).toBe(true)
    expect((await auditRows()).map((row) => row.action)).toEqual(['USER_EMAIL_CONFIRMED'])
  })
})

describe('удаление аккаунта админом', () => {
  it('стирает данные у агента, анонимизирует и оставляет след в журнале', async () => {
    const user = await registerConfirmedUser()
    const { calls } = mockAgent()

    const result = await accountDeletionProcess.execute(
      new DeleteUserAccountOperation({ adminEmail: ADMIN_EMAIL, userId: user.id }),
    )
    expect(result).toEqual({ success: true })
    expect(
      calls.some((call) => call.method === 'DELETE' && call.url.pathname === `/v1/users/${user.id}`),
    ).toBe(true)

    const row = await getUserRow(user.id)
    expect(row?.isDeleted).toBe(true)
    expect(row?.properties).toMatchObject({ deletion: { reason: 'admin_request' } })

    // The target address is snapshotted before anonymization, otherwise the log would keep the anonymized one.
    const [entry] = await auditRows()
    expect(entry).toMatchObject({
      action: 'USER_ACCOUNT_DELETED',
      adminEmail: ADMIN_EMAIL,
      targetEmail: user.email,
    })
  })

  it('повтор — ALREADY_DELETED', async () => {
    const user = await registerConfirmedUser()
    mockAgent()
    await accountDeletionProcess.execute(
      new DeleteUserAccountOperation({ adminEmail: ADMIN_EMAIL, userId: user.id }),
    )
    expect(
      await accountDeletionProcess.execute(
        new DeleteUserAccountOperation({ adminEmail: ADMIN_EMAIL, userId: user.id }),
      ),
    ).toEqual({ success: false, error: DeleteUserAccountOperationErrorCode.ALREADY_DELETED })
  })
})

describe('действия админки, кроме удаления, не ставят задач в очередь', () => {
  // Blocking, confirming an address and ending sessions need no transport and queue nothing; the deletion by an administrator
  // erases what the person's own request erases and queues the erasure in analytics (test/account-erasure.test.ts).
  it('блокировка, подтверждение почты и отзыв сессий работают без транспорта и ничего не ставят', async () => {
    registerJobQueueTransport(undefined)
    const user = await registerUser()
    const other = await registerConfirmedUser()

    expect(await toggle(other.id)).toEqual({ success: true, isActive: false })
    expect(await toggle(other.id)).toEqual({ success: true, isActive: true })
    expect(
      await userManagementProcess.execute(
        new ConfirmUserEmailOperation({ adminEmail: ADMIN_EMAIL, userId: user.id }),
      ),
    ).toEqual({ success: true })
    expect(
      await userManagementProcess.execute(
        new RevokeUserSessionsOperation({ adminEmail: ADMIN_EMAIL, userId: other.id }),
      ),
    ).toMatchObject({ success: true })

    registerJobQueueTransport(memoryJobQueueTransport)
    expect(getEnqueuedJobs()).toEqual([])
  })
})
