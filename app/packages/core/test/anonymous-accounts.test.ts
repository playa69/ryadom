/**
 * Anonymous accounts: sign-in by device, and linking an address that turns the account into an
 * ordinary one.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getDb, ValidationError } from '../src/shared'
import { userDevices } from '@ryadom/db/schema'
import {
  DeviceLoginOperation,
  DeviceLoginOperationErrorCode,
  LinkEmailOperation,
  LinkEmailOperationErrorCode,
  LoginOperationErrorCode,
  authenticationProcess,
} from '../src/processes/authentication'
import { DeleteAccountOperation, accountDeletionProcess } from '../src/processes/account-deletion'
import {
  ConfirmUserEmailOperation,
  ConfirmUserEmailOperationErrorCode,
  ToggleUserActivationOperation,
  userManagementProcess,
} from '../src/processes/user-management'
import { HashTokenRequest, tokenService, VerifyTokenRequest } from '../src/services/token-service'
import {
  ADMIN_EMAIL,
  PASSWORD,
  codeRows,
  confirmWithCode,
  countRows,
  emailsTo,
  getUserRow,
  login,
  mockAgent,
  registerConfirmedUser,
  registerUser,
  uniqueEmail,
} from './helpers'

/** What the app makes on first launch: a random id and 256 random bits, URL-safe. */
function newDevice() {
  return { deviceId: randomUUID(), deviceKey: randomBytes(32).toString('base64url') }
}

const deviceLogin = (device: { deviceId: string; deviceKey: string }) =>
  authenticationProcess.execute(new DeviceLoginOperation(device))

const link = (userId: string, email: string, password = PASSWORD) =>
  authenticationProcess.execute(new LinkEmailOperation({ userId, email, password }))

/** The user of a successful device sign-in. */
async function signedIn(device: { deviceId: string; deviceKey: string }) {
  const result = await deviceLogin(device)
  if (!result.success) throw new Error(`device sign-in failed: ${result.error}`)
  return result
}

describe('вход по устройству', () => {
  it('новое устройство получает аккаунт без почты, имени и пароля', async () => {
    const device = newDevice()
    const { user, isNewAccount } = await signedIn(device)

    expect(isNewAccount).toBe(true)
    expect(user).toMatchObject({
      email: null,
      name: null,
      isActive: true,
      isEmailConfirmed: false,
      isDeleted: false,
    })
    expect((await countRows(user.id, '')).credentials).toBe(0)
    expect(await getDb().select().from(userDevices)).toHaveLength(1)
  })

  it('то же устройство с тем же ключом получает тот же аккаунт', async () => {
    const device = newDevice()
    const first = await signedIn(device)
    const second = await signedIn(device)

    expect(second.isNewAccount).toBe(false)
    expect(second.user.id).toBe(first.user.id)
    expect(await getDb().select().from(userDevices)).toHaveLength(1)
  })

  it('неверный ключ известного устройства отклоняется и аккаунтов не плодит', async () => {
    const device = newDevice()
    const { user } = await signedIn(device)

    const result = await deviceLogin({ ...device, deviceKey: randomBytes(32).toString('base64url') })

    expect(result).toEqual({ success: false, error: DeviceLoginOperationErrorCode.DEVICE_KEY_INVALID })
    expect((await getUserRow(user.id))?.isActive).toBe(true)
    expect(await getDb().select().from(userDevices)).toHaveLength(1)
  })

  it('разные устройства — разные аккаунты', async () => {
    const a = await signedIn(newDevice())
    const b = await signedIn(newDevice())
    expect(a.user.id).not.toBe(b.user.id)
  })

  it('заблокированный аккаунт не входит, и причина видна только вызывающему коду', async () => {
    const device = newDevice()
    const { user } = await signedIn(device)
    await userManagementProcess.execute(
      new ToggleUserActivationOperation({ adminEmail: ADMIN_EMAIL, userId: user.id }),
    )

    expect(await deviceLogin(device)).toEqual({
      success: false,
      error: DeviceLoginOperationErrorCode.USER_INACTIVE,
    })
  })

  it('удаление аккаунта забывает устройство: тот же ключ создаёт новый аккаунт', async () => {
    mockAgent()
    const device = newDevice()
    const { user } = await signedIn(device)
    await accountDeletionProcess.execute(new DeleteAccountOperation({ userId: user.id }))

    expect(await getDb().select().from(userDevices)).toHaveLength(0)
    const again = await signedIn(device)
    expect(again.isNewAccount).toBe(true)
    expect(again.user.id).not.toBe(user.id)
  })

  it('одновременные первые входы одного устройства дают один аккаунт', async () => {
    const device = newDevice()

    const results = await Promise.all(Array.from({ length: 6 }, () => deviceLogin(device)))

    const successes = results.map((result) => {
      if (!result.success) throw new Error(`failed: ${result.error}`)
      return result
    })
    expect(new Set(successes.map((result) => result.user.id)).size).toBe(1)
    expect(successes.filter((result) => result.isNewAccount)).toHaveLength(1)
    expect(await getDb().select().from(userDevices)).toHaveLength(1)
  })

  it('идентификатор и ключ не из нашего приложения отвергаются до обращения к базе', async () => {
    const good = newDevice()
    for (const bad of [
      { ...good, deviceId: 'short' },
      { ...good, deviceId: 'has spaces and !! symbols in it' },
      { ...good, deviceKey: 'tooshort' },
      { ...good, deviceKey: `${'a'.repeat(31)}!` },
    ]) {
      await expect(deviceLogin(bad)).rejects.toBeInstanceOf(ValidationError)
    }
    expect(await getDb().select().from(userDevices)).toHaveLength(0)
  })

  it('ключ проверяется по хэшу: в базе лежит не он сам', async () => {
    const device = newDevice()
    await signedIn(device)

    const [row] = await getDb().select().from(userDevices)
    expect(row!.keyHash).not.toContain(device.deviceKey)
    expect(row!.keyHash).toBe(
      (await tokenService.execute(new HashTokenRequest({ token: device.deviceKey }))).tokenHash,
    )
  })
})

describe('привязка почты', () => {
  it('анонимный аккаунт получает адрес и пароль; вход по почте откроется после кода', async () => {
    const { user } = await signedIn(newDevice())
    const email = uniqueEmail()

    expect(await link(user.id, email)).toEqual({ success: true, email })

    expect(await getUserRow(user.id)).toMatchObject({ email, isEmailConfirmed: false })
    expect(emailsTo(email)).toHaveLength(1)
    expect((await countRows(user.id, email)).credentials).toBe(1)
    expect(await login(email)).toEqual({ success: false, error: LoginOperationErrorCode.EMAIL_NOT_CONFIRMED })

    await confirmWithCode(email, user.id)
    const signedInByEmail = await login(email)
    expect(signedInByEmail.success && signedInByEmail.user.id).toBe(user.id)
  })

  it('пока почта не подтверждена, устройство входит в тот же аккаунт; после подтверждения вход только по почте', async () => {
    const device = newDevice()
    const { user } = await signedIn(device)
    const email = uniqueEmail()
    await link(user.id, email)

    const pending = await signedIn(device)
    expect(pending.user).toMatchObject({ id: user.id, email, isEmailConfirmed: false })
    expect(pending.isNewAccount).toBe(false)

    await confirmWithCode(email, user.id)
    // With a password the account needs no device, and a key left on a shared phone must not open it.
    const after = await signedIn(device)
    expect(after.isNewAccount).toBe(true)
    expect(after.user.id).not.toBe(user.id)
    const byEmail = await login(email)
    expect(byEmail.success && byEmail.user.id).toBe(user.id)
  })

  it('чужой адрес — EMAIL_TAKEN, подтверждённый или нет', async () => {
    const { user } = await signedIn(newDevice())
    const confirmed = await registerConfirmedUser()
    const unconfirmed = await registerUser()

    expect(await link(user.id, confirmed.email)).toEqual({
      success: false,
      error: LinkEmailOperationErrorCode.EMAIL_TAKEN,
    })
    expect(await link(user.id, unconfirmed.email)).toEqual({
      success: false,
      error: LinkEmailOperationErrorCode.EMAIL_TAKEN,
    })
    expect((await getUserRow(user.id))?.email).toBeNull()
    // The refused attempt left nothing behind that could confirm the address later.
    expect((await countRows(user.id, '')).credentials).toBe(0)
  })

  it('подтверждённый адрес окончателен', async () => {
    const { user } = await signedIn(newDevice())
    const email = uniqueEmail()
    await link(user.id, email)
    await confirmWithCode(email, user.id)

    expect(await link(user.id, uniqueEmail())).toEqual({
      success: false,
      error: LinkEmailOperationErrorCode.ALREADY_HAS_EMAIL,
    })
  })

  it('неподтверждённый адрес можно заменить (опечатка), старый код после замены не годится', async () => {
    const { user } = await signedIn(newDevice())
    const typo = uniqueEmail('typo')
    const right = uniqueEmail('right')
    await link(user.id, typo)
    expect(await codeRows(typo)).toHaveLength(1)

    expect(await link(user.id, right, 'another-long-password')).toEqual({ success: true, email: right })

    expect((await getUserRow(user.id))?.email).toBe(right)
    expect(await codeRows(typo)).toHaveLength(0)
    await confirmWithCode(right, user.id)
    // The password of the second request is the one that counts.
    expect((await login(right, 'another-long-password')).success).toBe(true)
    expect((await login(right, PASSWORD)).success).toBe(false)
  })

  it('одноразовая почта и слабый пароль не принимаются', async () => {
    const { user } = await signedIn(newDevice())

    expect(await link(user.id, 'someone@mailinator.com')).toEqual({
      success: false,
      error: LinkEmailOperationErrorCode.DISPOSABLE_EMAIL,
    })
    await expect(link(user.id, uniqueEmail(), 'short')).rejects.toBeInstanceOf(ValidationError)
  })

  it('заблокированный и несуществующий аккаунты не привязывают почту', async () => {
    const { user } = await signedIn(newDevice())
    await userManagementProcess.execute(
      new ToggleUserActivationOperation({ adminEmail: ADMIN_EMAIL, userId: user.id }),
    )

    expect(await link(user.id, uniqueEmail())).toEqual({
      success: false,
      error: LinkEmailOperationErrorCode.USER_INACTIVE,
    })
    expect(await link(randomUUID(), uniqueEmail())).toEqual({
      success: false,
      error: LinkEmailOperationErrorCode.USER_NOT_FOUND,
    })
  })
})

describe('остальные сценарии, где почты может не быть', () => {
  it('админ не подтверждает несуществующий адрес', async () => {
    const { user } = await signedIn(newDevice())

    const result = await userManagementProcess.execute(
      new ConfirmUserEmailOperation({ adminEmail: ADMIN_EMAIL, userId: user.id }),
    )

    expect(result).toEqual({ success: false, error: ConfirmUserEmailOperationErrorCode.USER_HAS_NO_EMAIL })
    expect((await getUserRow(user.id))?.isEmailConfirmed).toBe(false)
  })

  it('анонимный аккаунт удаляется, как и любой другой', async () => {
    mockAgent()
    const { user } = await signedIn(newDevice())

    const deleted = await accountDeletionProcess.execute(new DeleteAccountOperation({ userId: user.id }))

    expect(deleted).toEqual({ success: true })
    expect(await getUserRow(user.id)).toMatchObject({ isDeleted: true, isActive: false })
  })

  it('сверка токена с хэшем: совпадение и расхождение, в том числе по длине', async () => {
    const { tokenHash } = await tokenService.execute(new HashTokenRequest({ token: 'the-token' }))

    expect(await tokenService.execute(new VerifyTokenRequest({ token: 'the-token', tokenHash }))).toEqual({
      isValid: true,
    })
    expect(await tokenService.execute(new VerifyTokenRequest({ token: 'other-token', tokenHash }))).toEqual({
      isValid: false,
    })
    expect(
      await tokenService.execute(new VerifyTokenRequest({ token: 'the-token', tokenHash: 'short' })),
    ).toEqual({
      isValid: false,
    })
  })
})
