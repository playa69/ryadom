/**
 * Registry of refresh tokens: the manager's commands, and the scenarios that end sessions (password
 * change and reset, blocking, deletion).
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  DeleteExpiredRefreshTokensCommand,
  GetRefreshTokenQuery,
  GetRefreshTokenQueryErrorCode,
  GetSessionStatusQuery,
  ListUserSessionsQuery,
  RevokeRefreshTokenCommand,
  RevokeRefreshTokenCommandErrorCode,
  RevokeSessionRefreshTokensCommand,
  RevokeUserRefreshTokensCommand,
  RevokeUserSessionCommand,
  RevokeUserSessionCommandErrorCode,
  StoreRefreshTokenCommand,
  StoreRefreshTokenCommandErrorCode,
  refreshTokensManager,
  type RefreshTokenDTO,
} from '../src/managers/refresh-tokens-manager'
import { DeleteAccountOperation, accountDeletionProcess } from '../src/processes/account-deletion'
import { ChangePasswordOperation, changePasswordProcess } from '../src/processes/change-password'
import {
  ForgotPasswordOperation,
  ResetPasswordOperation,
  forgotPasswordProcess,
} from '../src/processes/forgot-password'
import {
  DeleteUserAccountOperation,
  RevokeUserSessionsOperation,
  RevokeUserSessionsOperationErrorCode,
  ToggleUserActivationOperation,
  userManagementProcess,
} from '../src/processes/user-management'
import {
  ADMIN_EMAIL,
  HOUR,
  MINUTE,
  PASSWORD,
  auditRows,
  codeFromEmail,
  lastEmailTo,
  login,
  mockAgent,
  registerConfirmedUser,
  travelBy,
} from './helpers'

const DAY = 24 * HOUR

interface Device {
  clientId: string | null
  userAgent: string | null
}

async function store(
  userId: string,
  sessionId = randomUUID(),
  expiresInMs = 30 * DAY,
  device: Device = { clientId: null, userAgent: null },
) {
  const tokenId = randomUUID()
  const stored = await refreshTokensManager.execute(
    new StoreRefreshTokenCommand({
      tokenId,
      sessionId,
      userId,
      expiresAt: new Date(Date.now() + expiresInMs),
      ...device,
    }),
  )
  expect(stored).toEqual({ success: true })
  return { tokenId, sessionId }
}

async function read(tokenId: string): Promise<RefreshTokenDTO> {
  const result = await refreshTokensManager.execute(new GetRefreshTokenQuery({ tokenId }))
  if (!result.success) throw new Error(`token ${tokenId} is not registered`)
  return result.token
}

const isActive = async (tokenId: string) => (await read(tokenId)).revokedAt === null

describe('реестр: команды менеджера', () => {
  it('токен регистрируется и читается; повторный id и не-UUID не ломают', async () => {
    const user = await registerConfirmedUser()
    const { tokenId, sessionId } = await store(user.id)

    expect(await read(tokenId)).toMatchObject({
      id: tokenId,
      sessionId,
      userId: user.id,
      revokedAt: null,
      revokedReason: null,
    })

    const again = await refreshTokensManager.execute(
      new StoreRefreshTokenCommand({
        tokenId,
        sessionId,
        userId: user.id,
        expiresAt: new Date(),
        clientId: null,
        userAgent: null,
      }),
    )
    expect(again).toEqual({ success: false, error: StoreRefreshTokenCommandErrorCode.TOKEN_ALREADY_EXISTS })
    expect(await refreshTokensManager.execute(new GetRefreshTokenQuery({ tokenId: 'not-a-uuid' }))).toEqual({
      success: false,
      error: GetRefreshTokenQueryErrorCode.TOKEN_NOT_FOUND,
    })
  })

  it('из нескольких одновременных погашений токена удаётся ровно одно', async () => {
    const user = await registerConfirmedUser()
    const { tokenId } = await store(user.id)

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        refreshTokensManager.execute(
          new RevokeRefreshTokenCommand({ tokenId, reason: 'rotated', revokedAt: new Date() }),
        ),
      ),
    )

    expect(results.filter((result) => result.success)).toHaveLength(1)
    expect(results.filter((result) => !result.success)).toEqual(
      Array(5).fill({ success: false, error: RevokeRefreshTokenCommandErrorCode.TOKEN_NOT_ACTIVE }),
    )
    expect((await read(tokenId)).revokedReason).toBe('rotated')
  })

  it('выход завершает всю цепочку сессии, включая уже ротированные токены', async () => {
    const user = await registerConfirmedUser()
    const sessionId = randomUUID()
    const rotated = await store(user.id, sessionId)
    const current = await store(user.id, sessionId)
    const other = await store(user.id)
    await refreshTokensManager.execute(
      new RevokeRefreshTokenCommand({ tokenId: rotated.tokenId, reason: 'rotated', revokedAt: new Date() }),
    )

    await refreshTokensManager.execute(
      new RevokeSessionRefreshTokensCommand({ sessionId, revokedAt: new Date() }),
    )

    // The rotated one is no longer "rotated": inside the grace window it could bring the session back.
    expect((await read(rotated.tokenId)).revokedReason).toBe('signed_out')
    expect((await read(current.tokenId)).revokedReason).toBe('signed_out')
    expect(await isActive(other.tokenId)).toBe(true)
  })

  it('отзыв всех сессий пользователя может оставить одну; чужие токены не трогает', async () => {
    const user = await registerConfirmedUser()
    const stranger = await registerConfirmedUser()
    const keep = await store(user.id)
    const dropA = await store(user.id)
    const dropB = await store(user.id)
    const strangers = await store(stranger.id)

    await refreshTokensManager.execute(
      new RevokeUserRefreshTokensCommand({
        userId: user.id,
        exceptSessionId: keep.sessionId,
        revokedAt: new Date(),
      }),
    )

    expect(await isActive(keep.tokenId)).toBe(true)
    expect((await read(dropA.tokenId)).revokedReason).toBe('revoked')
    expect((await read(dropB.tokenId)).revokedReason).toBe('revoked')
    expect(await isActive(strangers.tokenId)).toBe(true)

    await refreshTokensManager.execute(
      new RevokeUserRefreshTokensCommand({ userId: user.id, exceptSessionId: null, revokedAt: new Date() }),
    )
    expect(await isActive(keep.tokenId)).toBe(false)
  })

  it('очистка убирает только давно истёкшие токены', async () => {
    const user = await registerConfirmedUser()
    const expired = await store(user.id, randomUUID(), 1 * HOUR)
    const alive = await store(user.id)

    travelBy(2 * DAY)
    await refreshTokensManager.execute(
      new DeleteExpiredRefreshTokensCommand({ before: new Date(Date.now() - DAY) }),
    )

    expect(
      await refreshTokensManager.execute(new GetRefreshTokenQuery({ tokenId: expired.tokenId })),
    ).toEqual({
      success: false,
      error: GetRefreshTokenQueryErrorCode.TOKEN_NOT_FOUND,
    })
    expect(await isActive(alive.tokenId)).toBe(true)
  })
})

const listSessions = async (userId: string) => {
  const result = await refreshTokensManager.execute(new ListUserSessionsQuery({ userId, now: new Date() }))
  return result.sessions
}

const isSessionActive = async (sessionId: string) =>
  (await refreshTokensManager.execute(new GetSessionStatusQuery({ sessionId }))).active

describe('список сессий', () => {
  it('цепочка ротаций — одна строка: начало по первому токену, последнее использование и клиент по последнему', async () => {
    const user = await registerConfirmedUser()
    const sessionId = randomUUID()
    // A frozen clock, so that the times in the answer can be compared exactly.
    travelBy(0)
    const signedInAt = new Date()
    const first = await store(user.id, sessionId, undefined, { clientId: 'ryadom-web', userAgent: 'Old UA' })
    await refreshTokensManager.execute(
      new RevokeRefreshTokenCommand({ tokenId: first.tokenId, reason: 'rotated', revokedAt: new Date() }),
    )
    travelBy(10 * MINUTE)
    await store(user.id, sessionId, undefined, { clientId: 'ryadom-pwa', userAgent: 'New UA' })

    const sessions = await listSessions(user.id)

    expect(sessions).toEqual([
      {
        sessionId,
        clientId: 'ryadom-pwa',
        userAgent: 'New UA',
        startedAt: signedInAt,
        lastUsedAt: new Date(signedInAt.getTime() + 10 * MINUTE),
      },
    ])
  })

  it('самая недавняя сессия первой; чужих нет', async () => {
    const user = await registerConfirmedUser()
    const stranger = await registerConfirmedUser()
    const older = await store(user.id)
    travelBy(MINUTE)
    const newer = await store(user.id)
    await store(stranger.id)

    expect((await listSessions(user.id)).map((s) => s.sessionId)).toEqual([newer.sessionId, older.sessionId])
  })

  it('завершённые и истёкшие сессии не показываются', async () => {
    const user = await registerConfirmedUser()
    const live = await store(user.id)
    const signedOut = await store(user.id)
    const revoked = await store(user.id)
    await store(user.id, randomUUID(), 1 * HOUR)
    await refreshTokensManager.execute(
      new RevokeSessionRefreshTokensCommand({ sessionId: signedOut.sessionId, revokedAt: new Date() }),
    )
    await refreshTokensManager.execute(
      new RevokeUserSessionCommand({ userId: user.id, sessionId: revoked.sessionId, revokedAt: new Date() }),
    )
    travelBy(2 * HOUR)

    expect((await listSessions(user.id)).map((s) => s.sessionId)).toEqual([live.sessionId])
  })

  it('сессия с токеном, погашенным ротацией, жива, пока в цепочке нет завершённого', async () => {
    const user = await registerConfirmedUser()
    const sessionId = randomUUID()
    const rotated = await store(user.id, sessionId)
    await store(user.id, sessionId)
    await refreshTokensManager.execute(
      new RevokeRefreshTokenCommand({ tokenId: rotated.tokenId, reason: 'rotated', revokedAt: new Date() }),
    )

    expect((await listSessions(user.id)).map((s) => s.sessionId)).toEqual([sessionId])
  })

  it('у пользователя без сессий и при не-UUID список пуст', async () => {
    const user = await registerConfirmedUser()
    expect(await listSessions(user.id)).toEqual([])
    expect(await listSessions('not-a-uuid')).toEqual([])
  })
})

describe('завершение одной сессии человеком', () => {
  it('завершает всю цепочку своей сессии, остальные остаются', async () => {
    const user = await registerConfirmedUser()
    const sessionId = randomUUID()
    const rotated = await store(user.id, sessionId)
    const current = await store(user.id, sessionId)
    const other = await store(user.id)
    await refreshTokensManager.execute(
      new RevokeRefreshTokenCommand({ tokenId: rotated.tokenId, reason: 'rotated', revokedAt: new Date() }),
    )

    const result = await refreshTokensManager.execute(
      new RevokeUserSessionCommand({ userId: user.id, sessionId, revokedAt: new Date() }),
    )

    expect(result).toEqual({ success: true })
    // The rotated token is retired for good too, otherwise it could be exchanged during the grace window.
    expect((await read(rotated.tokenId)).revokedReason).toBe('revoked')
    expect((await read(current.tokenId)).revokedReason).toBe('revoked')
    expect(await isActive(other.tokenId)).toBe(true)
  })

  it('чужая, несуществующая, уже завершённая сессия и не-UUID — SESSION_NOT_FOUND, ничего не меняется', async () => {
    const user = await registerConfirmedUser()
    const stranger = await registerConfirmedUser()
    const theirs = await store(stranger.id)
    const ended = await store(user.id)
    await refreshTokensManager.execute(
      new RevokeUserSessionCommand({ userId: user.id, sessionId: ended.sessionId, revokedAt: new Date() }),
    )
    const notFound = { success: false, error: RevokeUserSessionCommandErrorCode.SESSION_NOT_FOUND }
    const end = (userId: string, sessionId: string) =>
      refreshTokensManager.execute(new RevokeUserSessionCommand({ userId, sessionId, revokedAt: new Date() }))

    expect(await end(user.id, theirs.sessionId)).toEqual(notFound)
    expect(await end(user.id, randomUUID())).toEqual(notFound)
    expect(await end(user.id, ended.sessionId)).toEqual(notFound)
    expect(await end(user.id, 'not-a-uuid')).toEqual(notFound)
    expect(await end('not-a-uuid', theirs.sessionId)).toEqual(notFound)
    expect(await isActive(theirs.tokenId)).toBe(true)
  })
})

describe('состояние сессии', () => {
  it('живая сессия активна, в том числе в миг ротации, когда прежний токен уже погашен, а следующего ещё нет', async () => {
    const user = await registerConfirmedUser()
    const sessionId = randomUUID()
    const first = await store(user.id, sessionId)
    expect(await isSessionActive(sessionId)).toBe(true)

    await refreshTokensManager.execute(
      new RevokeRefreshTokenCommand({ tokenId: first.tokenId, reason: 'rotated', revokedAt: new Date() }),
    )
    expect(await isSessionActive(sessionId)).toBe(true)
  })

  it('выход, отзыв одной сессии и отзыв всех завершают сессию', async () => {
    const user = await registerConfirmedUser()
    const signedOut = await store(user.id)
    const revokedOne = await store(user.id)
    const revokedAll = await store(user.id)
    await refreshTokensManager.execute(
      new RevokeSessionRefreshTokensCommand({ sessionId: signedOut.sessionId, revokedAt: new Date() }),
    )
    await refreshTokensManager.execute(
      new RevokeUserSessionCommand({
        userId: user.id,
        sessionId: revokedOne.sessionId,
        revokedAt: new Date(),
      }),
    )
    expect(await isSessionActive(revokedAll.sessionId)).toBe(true)
    await refreshTokensManager.execute(
      new RevokeUserRefreshTokensCommand({ userId: user.id, exceptSessionId: null, revokedAt: new Date() }),
    )

    expect(await isSessionActive(signedOut.sessionId)).toBe(false)
    expect(await isSessionActive(revokedOne.sessionId)).toBe(false)
    expect(await isSessionActive(revokedAll.sessionId)).toBe(false)
  })

  it('неизвестная сессия и не-UUID не активны', async () => {
    expect(await isSessionActive(randomUUID())).toBe(false)
    expect(await isSessionActive('not-a-uuid')).toBe(false)
  })
})

describe('сценарии, которые завершают сессии', () => {
  it('смена пароля завершает остальные сессии, а текущая продолжает работать', async () => {
    const user = await registerConfirmedUser()
    const current = await store(user.id)
    const phone = await store(user.id)

    const changed = await changePasswordProcess.execute(
      new ChangePasswordOperation({
        userId: user.id,
        currentPassword: PASSWORD,
        newPassword: 'another-long-password',
        keepSessionId: current.sessionId,
      }),
    )

    expect(changed).toEqual({ success: true })
    expect(await isActive(current.tokenId)).toBe(true)
    expect((await read(phone.tokenId)).revokedReason).toBe('revoked')
  })

  it('смена пароля без указанной сессии завершает все', async () => {
    const user = await registerConfirmedUser()
    const first = await store(user.id)
    const second = await store(user.id)

    await changePasswordProcess.execute(
      new ChangePasswordOperation({
        userId: user.id,
        currentPassword: PASSWORD,
        newPassword: 'another-long-password',
      }),
    )

    expect(await isActive(first.tokenId)).toBe(false)
    expect(await isActive(second.tokenId)).toBe(false)
  })

  it('неверный текущий пароль ничего не завершает', async () => {
    const user = await registerConfirmedUser()
    const session = await store(user.id)

    const result = await changePasswordProcess.execute(
      new ChangePasswordOperation({
        userId: user.id,
        currentPassword: 'wrong-password-here',
        newPassword: 'another-long-password',
      }),
    )

    expect(result.success).toBe(false)
    expect(await isActive(session.tokenId)).toBe(true)
  })

  it('сброс пароля завершает все сессии', async () => {
    const user = await registerConfirmedUser()
    const first = await store(user.id)
    const second = await store(user.id)

    await forgotPasswordProcess.execute(new ForgotPasswordOperation({ email: user.email }))
    const code = codeFromEmail(lastEmailTo(user.email))
    const reset = await forgotPasswordProcess.execute(
      new ResetPasswordOperation({ email: user.email, code, newPassword: 'brand-new-password' }),
    )

    expect(reset).toEqual({ success: true, userId: user.id })
    expect(await isActive(first.tokenId)).toBe(false)
    expect(await isActive(second.tokenId)).toBe(false)
  })

  it('блокировка завершает сессии, и разблокировка их не возвращает', async () => {
    const user = await registerConfirmedUser()
    const session = await store(user.id)
    const toggle = () =>
      userManagementProcess.execute(
        new ToggleUserActivationOperation({ adminEmail: ADMIN_EMAIL, userId: user.id }),
      )

    await toggle()
    expect((await read(session.tokenId)).revokedReason).toBe('revoked')

    await toggle()
    expect(await isActive(session.tokenId)).toBe(false)
  })

  it('админ завершает все сессии: аккаунт остаётся активным, вход возможен, действие в журнале', async () => {
    const user = await registerConfirmedUser()
    const stranger = await registerConfirmedUser()
    const first = await store(user.id)
    const second = await store(user.id)
    const strangers = await store(stranger.id)

    const result = await userManagementProcess.execute(
      new RevokeUserSessionsOperation({ adminEmail: ADMIN_EMAIL, userId: user.id }),
    )

    expect(result).toEqual({ success: true })
    expect((await read(first.tokenId)).revokedReason).toBe('revoked')
    expect((await read(second.tokenId)).revokedReason).toBe('revoked')
    expect(await isActive(strangers.tokenId)).toBe(true)
    expect((await login(user.email)).success).toBe(true)
    const [entry, ...rest] = await auditRows()
    expect(rest).toEqual([])
    expect(entry).toMatchObject({
      action: 'USER_SESSIONS_REVOKED',
      adminEmail: ADMIN_EMAIL,
      targetUserId: user.id,
      targetEmail: user.email,
    })
  })

  it('завершить сессии несуществующего или удалённого аккаунта нельзя, в журнал ничего не пишется', async () => {
    mockAgent()
    const deleted = await registerConfirmedUser()
    await userManagementProcess.execute(
      new DeleteUserAccountOperation({ adminEmail: ADMIN_EMAIL, userId: deleted.id }),
    )
    const before = (await auditRows()).length

    const revoke = (userId: string) =>
      userManagementProcess.execute(new RevokeUserSessionsOperation({ adminEmail: ADMIN_EMAIL, userId }))

    expect(await revoke(deleted.id)).toEqual({
      success: false,
      error: RevokeUserSessionsOperationErrorCode.USER_DELETED,
    })
    expect(await revoke(randomUUID())).toEqual({
      success: false,
      error: RevokeUserSessionsOperationErrorCode.USER_NOT_FOUND,
    })
    expect(await auditRows()).toHaveLength(before)
  })

  it('удаление аккаунта (самим человеком и админом) завершает сессии', async () => {
    mockAgent()
    const self = await registerConfirmedUser()
    const selfSession = await store(self.id)
    await accountDeletionProcess.execute(new DeleteAccountOperation({ userId: self.id }))
    expect((await read(selfSession.tokenId)).revokedReason).toBe('revoked')

    const byAdmin = await registerConfirmedUser()
    const adminSession = await store(byAdmin.id)
    await userManagementProcess.execute(
      new DeleteUserAccountOperation({ adminEmail: ADMIN_EMAIL, userId: byAdmin.id }),
    )
    expect((await read(adminSession.tokenId)).revokedReason).toBe('revoked')
  })
})
