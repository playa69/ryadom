/**
 * Admin actions and the audit log.
 */
import { describe, expect, it } from 'vitest'
import {
  ConfirmUserEmailOperation,
  DeleteUserAccountOperation,
  DeleteUserAccountOperationErrorCode,
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
import { ADMIN_EMAIL, auditRows, getUserRow, login, mockAgent, registerConfirmedUser, registerUser } from './helpers'

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
    expect(journal[0]).toMatchObject({ adminEmail: ADMIN_EMAIL, targetUserId: user.id, targetEmail: user.email })
  })

  it('удалённый аккаунт не блокируется', async () => {
    const user = await registerConfirmedUser()
    mockAgent()
    await userManagementProcess.execute(new DeleteUserAccountOperation({ adminEmail: ADMIN_EMAIL, userId: user.id }))
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

    const result = await userManagementProcess.execute(
      new DeleteUserAccountOperation({ adminEmail: ADMIN_EMAIL, userId: user.id }),
    )
    expect(result).toEqual({ success: true })
    expect(calls.some((call) => call.method === 'DELETE' && call.url.pathname === `/v1/users/${user.id}`)).toBe(true)

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
    await userManagementProcess.execute(new DeleteUserAccountOperation({ adminEmail: ADMIN_EMAIL, userId: user.id }))
    expect(
      await userManagementProcess.execute(
        new DeleteUserAccountOperation({ adminEmail: ADMIN_EMAIL, userId: user.id }),
      ),
    ).toEqual({ success: false, error: DeleteUserAccountOperationErrorCode.ALREADY_DELETED })
  })
})

describe('админка не ставит задач в очередь', () => {
  // `openspec/changes/archive/2026-10-27-add-job-queue`, design D9: the admin app registers no transport and works no queue; its actions
  // must neither need one nor queue anything (and, by the spec, they do not erase a profile in analytics).
  it('блокировка, подтверждение почты, отзыв сессий и удаление админом работают без транспорта и ничего не ставят', async () => {
    registerJobQueueTransport(undefined)
    const user = await registerUser()
    const other = await registerConfirmedUser()
    mockAgent()

    expect(await toggle(other.id)).toEqual({ success: true, isActive: false })
    expect(await toggle(other.id)).toEqual({ success: true, isActive: true })
    expect(
      await userManagementProcess.execute(new ConfirmUserEmailOperation({ adminEmail: ADMIN_EMAIL, userId: user.id })),
    ).toEqual({ success: true })
    expect(
      await userManagementProcess.execute(new RevokeUserSessionsOperation({ adminEmail: ADMIN_EMAIL, userId: other.id })),
    ).toMatchObject({ success: true })
    expect(
      await userManagementProcess.execute(new DeleteUserAccountOperation({ adminEmail: ADMIN_EMAIL, userId: other.id })),
    ).toMatchObject({ success: true })

    // Nothing was refused for want of a transport; and with the memory transport nothing would have been queued either.
    registerJobQueueTransport(memoryJobQueueTransport)
    expect(getEnqueuedJobs()).toEqual([])
  })
})
