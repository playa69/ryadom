/**
 * An address that an account holds but has not confirmed. Whoever owns the mailbox proves it with a
 * code, and that must never hand them an account that belongs to somebody else: a guest account
 * (reachable by a device key or by Telegram) keeps its data, and the address goes to a new account.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { userDevices, users } from '@ryadom/db/schema'
import { getDb } from '../src/shared'
import {
  authenticationProcess,
  DeviceLoginOperation,
  LinkEmailOperation,
  LinkEmailOperationErrorCode,
  LoginOperationErrorCode,
  RegisterOperation,
} from '../src/processes/authentication'
import {
  ConfirmEmailOperation,
  ConfirmEmailOperationErrorCode,
  emailConfirmationProcess,
  ResendConfirmationOperation,
} from '../src/processes/email-confirmation'
import {
  ForgotPasswordOperation,
  forgotPasswordProcess,
  ResetPasswordOperation,
  ResetPasswordOperationErrorCode,
} from '../src/processes/forgot-password'
import {
  CreateUserCommand,
  MarkUserEmailConfirmedCommand,
  MarkUserEmailConfirmedCommandErrorCode,
  usersManager,
} from '../src/managers/users-manager'
import { CreateEmailCodeCommand, emailCodesManager } from '../src/managers/email-codes-manager'
import { CreateNumericCodeRequest, tokenService } from '../src/services/token-service'
import {
  codeFromEmail,
  codeRows,
  confirmWithCode,
  emailsTo,
  getUserRow,
  lastEmailTo,
  login,
  PASSWORD,
  registerUser,
  uniqueEmail,
} from './helpers'

const OWNER_PASSWORD = 'owner-password-1'

function newDevice() {
  return { deviceId: randomUUID(), deviceKey: randomBytes(32).toString('base64url') }
}

async function guestSignedIn(device: { deviceId: string; deviceKey: string }) {
  const result = await authenticationProcess.execute(new DeviceLoginOperation(device))
  if (!result.success) throw new Error(`device sign-in failed: ${result.error}`)
  return result
}

/** A guest account that has typed an address and not confirmed it yet. */
async function guestHolding(email: string) {
  const device = newDevice()
  const { user } = await guestSignedIn(device)
  const linked = await authenticationProcess.execute(
    new LinkEmailOperation({ userId: user.id, email, password: PASSWORD }),
  )
  expect(linked).toEqual({ success: true, email })
  return { device, user }
}

/** An account that comes from the Telegram Mini App and has typed an address and not confirmed it. */
async function telegramHolding(email: string) {
  const userId = randomUUID()
  const created = await usersManager.execute(
    new CreateUserCommand({
      userId,
      email: null,
      name: null,
      isEmailConfirmed: false,
      telegramId: 777_000_111,
    }),
  )
  expect(created.success).toBe(true)
  const linked = await authenticationProcess.execute(
    new LinkEmailOperation({ userId, email, password: PASSWORD }),
  )
  expect(linked).toEqual({ success: true, email })
  return { userId }
}

const register = (email: string, password = OWNER_PASSWORD, name = 'Боря') =>
  authenticationProcess.execute(new RegisterOperation({ email, password, name }))

const confirm = (email: string, code: string, callerUserId: string | null = null) =>
  emailConfirmationProcess.execute(new ConfirmEmailOperation({ email, code, callerUserId }))

const CODE_INVALID = { success: false, error: ConfirmEmailOperationErrorCode.CODE_INVALID }

describe('регистрация адреса, который гость привязал и не подтвердил', () => {
  it('новый человек получает новый аккаунт, гость остаётся гостем со своим устройством и без адреса', async () => {
    const email = uniqueEmail()
    const { device, user: guest } = await guestHolding(email)

    // The answer is the usual success, exactly as for an address nobody holds.
    const result = await register(email)
    expect(result.success).toBe(true)

    // Nothing of the guest's account was touched: same row, same device, only the address is gone.
    expect(await getUserRow(guest.id)).toMatchObject({ email: null, isEmailConfirmed: false, isActive: true })
    const again = await guestSignedIn(device)
    expect(again.isNewAccount).toBe(false)
    expect(again.user.id).toBe(guest.id)

    await confirmWithCode(email)
    const owner = await login(email, OWNER_PASSWORD)
    expect(owner.success).toBe(true)
    if (owner.success) {
      expect(owner.user.id).not.toBe(guest.id)
      expect(owner.user.name).toBe('Боря')
    }
    // The password the guest chose does not open the new account, and the guest's data stayed with the guest.
    expect((await login(email, PASSWORD)).success).toBe(false)
    expect(await getUserRow(guest.id)).toMatchObject({ email: null, isEmailConfirmed: false })
    expect(await getDb().select().from(userDevices).where(eq(userDevices.userId, guest.id))).toHaveLength(1)
  })

  it('то же для аккаунта из Telegram', async () => {
    const email = uniqueEmail()
    const { userId } = await telegramHolding(email)

    expect((await register(email)).success).toBe(true)

    expect(await getUserRow(userId)).toMatchObject({
      email: null,
      telegramId: 777_000_111,
      isEmailConfirmed: false,
    })
    await confirmWithCode(email)
    const owner = await login(email, OWNER_PASSWORD)
    expect(owner.success && owner.user.id).not.toBe(userId)
    expect(owner.success).toBe(true)
  })

  it('у адреса один живой код, и это код нового человека; прежний код гостя недействителен', async () => {
    const email = uniqueEmail()
    const { user: guest } = await guestHolding(email)
    const guestCode = codeFromEmail(lastEmailTo(email))

    await register(email)
    const ownerLetter = lastEmailTo(email)
    expect(emailsTo(email)).toHaveLength(2)
    expect(await codeRows(email, 'confirm_email')).toHaveLength(1)

    const ownerCode = codeFromEmail(ownerLetter)
    if (ownerCode !== guestCode) {
      expect(await confirm(email, guestCode, guest.id)).toMatchObject({ success: false })
    }
    expect((await confirm(email, ownerCode)).success).toBe(true)
  })

  it('гость после этого может привязать другой адрес', async () => {
    const email = uniqueEmail()
    const { user: guest } = await guestHolding(email)
    await register(email)

    const other = uniqueEmail()
    const linked = await authenticationProcess.execute(
      new LinkEmailOperation({ userId: guest.id, email: other, password: PASSWORD }),
    )
    expect(linked).toEqual({ success: true, email: other })
    // Its old address is held by the registration now, and a guest cannot take it from there.
    const retry = await authenticationProcess.execute(
      new LinkEmailOperation({ userId: guest.id, email, password: PASSWORD }),
    )
    expect(retry).toEqual({ success: false, error: LinkEmailOperationErrorCode.EMAIL_TAKEN })
  })

  it('две регистрации одного адреса подряд дают один аккаунт, гость в стороне', async () => {
    const email = uniqueEmail()
    const { user: guest } = await guestHolding(email)

    const [first, second] = await Promise.all([
      register(email, 'first-password-1'),
      register(email, 'second-password-1'),
    ])
    expect(first.success).toBe(true)
    expect(second.success).toBe(true)

    expect(await getDb().select().from(users).where(eq(users.email, email))).toHaveLength(1)
    expect(await getUserRow(guest.id)).toMatchObject({ email: null })
    expect(await codeRows(email, 'confirm_email')).toHaveLength(1)
  })

  it('регистрация, которой никто не пользовался, по-прежнему переходит к владельцу адреса', async () => {
    // A registration nobody has signed in with has no data to protect: the real owner still reclaims it.
    const email = uniqueEmail()
    const parked = await registerUser({ email, password: 'attacker-password-1', name: 'Чужой' })
    const owner = await register(email)
    expect(owner.success && owner.user.id).toBe(parked.id)
  })
})

describe('подтверждение адреса, который держит гостевой аккаунт', () => {
  it('код, введённый не из сессии этого аккаунта, адрес не подтверждает и не сгорает', async () => {
    const email = uniqueEmail()
    const { device, user: guest } = await guestHolding(email)
    const code = codeFromEmail(lastEmailTo(email))

    // The owner of the mailbox got the letter, but the account is not theirs.
    expect(await confirm(email, code)).toEqual(CODE_INVALID)
    expect(await confirm(email, code, null)).toEqual(CODE_INVALID)

    expect(await getUserRow(guest.id)).toMatchObject({ email, isEmailConfirmed: false })
    expect((await guestSignedIn(device)).user.id).toBe(guest.id)
    expect(await codeRows(email, 'confirm_email')).toHaveLength(1)

    // The code was not used up: the guest's own session still confirms with it.
    expect((await confirm(email, code, guest.id)).success).toBe(true)
    expect(await getUserRow(guest.id)).toMatchObject({ email, isEmailConfirmed: true })
  })

  it('сессия другого аккаунта тоже не подтверждает', async () => {
    const email = uniqueEmail()
    const { user: guest } = await guestHolding(email)
    const stranger = await guestSignedIn(newDevice())
    const code = codeFromEmail(lastEmailTo(email))

    expect(await confirm(email, code, stranger.user.id)).toEqual(CODE_INVALID)
    expect(await getUserRow(guest.id)).toMatchObject({ isEmailConfirmed: false })
  })

  it('аккаунт из Telegram подтверждается только из своей сессии', async () => {
    const email = uniqueEmail()
    const { userId } = await telegramHolding(email)
    const code = codeFromEmail(lastEmailTo(email))

    expect(await confirm(email, code)).toEqual(CODE_INVALID)
    expect((await confirm(email, code, userId)).success).toBe(true)
  })

  it('повторная отправка, подтверждение и сброс пароля с чужого ящика гостевой аккаунт не отдают', async () => {
    const email = uniqueEmail()
    const { device, user: guest } = await guestHolding(email)
    const letters = emailsTo(email).length

    // The mailbox owner asks for a code of their own...
    expect(await emailConfirmationProcess.execute(new ResendConfirmationOperation({ email }))).toEqual({
      success: true,
    })
    expect(emailsTo(email)).toHaveLength(letters + 1)
    const code = codeFromEmail(lastEmailTo(email))
    // ...and cannot confirm the guest's address with it...
    expect(await confirm(email, code)).toEqual(CODE_INVALID)

    // ...so there is nothing to reset a password on: no letter, and a made-up code is refused.
    expect(await forgotPasswordProcess.execute(new ForgotPasswordOperation({ email }))).toEqual({
      success: true,
    })
    expect(emailsTo(email)).toHaveLength(letters + 1)
    const reset = await forgotPasswordProcess.execute(
      new ResetPasswordOperation({ email, code: '123456', newPassword: OWNER_PASSWORD }),
    )
    expect(reset).toEqual({ success: false, error: ResetPasswordOperationErrorCode.CODE_INVALID })

    expect(await login(email, OWNER_PASSWORD)).toEqual({
      success: false,
      error: LoginOperationErrorCode.INVALID_CREDENTIALS,
    })
    expect(await login(email, PASSWORD)).toEqual({
      success: false,
      error: LoginOperationErrorCode.EMAIL_NOT_CONFIRMED,
    })
    expect((await guestSignedIn(device)).user.id).toBe(guest.id)
  })

  it('своя сессия подтверждает: ключи устройства стираются, вход по почте открывается', async () => {
    const email = uniqueEmail()
    const { user: guest } = await guestHolding(email)

    await confirmWithCode(email, guest.id)

    expect(await getDb().select().from(userDevices).where(eq(userDevices.userId, guest.id))).toHaveLength(0)
    const byEmail = await login(email, PASSWORD)
    expect(byEmail.success && byEmail.user.id).toBe(guest.id)
  })

  it('регистрация без входа подтверждается кодом без всякой сессии', async () => {
    const user = await registerUser()
    expect((await confirm(user.email, codeFromEmail(lastEmailTo(user.email)))).success).toBe(true)
  })
})

describe('сброс пароля и отметка подтверждения не работают по чужому адресу', () => {
  it('код сброса не меняет пароль аккаунта, у которого адрес не подтверждён', async () => {
    const user = await registerUser({ password: 'first-password-1' })
    const { code, codeHash } = await tokenService.execute(new CreateNumericCodeRequest())
    // A reset code that outlived the account which once held the address.
    await emailCodesManager.execute(
      new CreateEmailCodeCommand({
        codeId: randomUUID(),
        email: user.email,
        purpose: 'reset_password',
        codeHash,
        expiresAt: new Date(Date.now() + 5 * 60_000),
      }),
    )

    const result = await forgotPasswordProcess.execute(
      new ResetPasswordOperation({ email: user.email, code, newPassword: OWNER_PASSWORD }),
    )
    expect(result).toEqual({ success: false, error: ResetPasswordOperationErrorCode.CODE_INVALID })

    await confirmWithCode(user.email)
    expect((await login(user.email, 'first-password-1')).success).toBe(true)
    expect((await login(user.email, OWNER_PASSWORD)).success).toBe(false)
  })

  it('отметка «подтверждена» привязана к адресу: если адрес с аккаунта ушёл, она не ставится', async () => {
    const email = uniqueEmail()
    const { user: guest } = await guestHolding(email)
    await register(email)

    // A confirmation that read the guest's account before the address left it must not mark it.
    const marked = await usersManager.execute(new MarkUserEmailConfirmedCommand({ userId: guest.id, email }))
    expect(marked).toEqual({ success: false, error: MarkUserEmailConfirmedCommandErrorCode.EMAIL_MISMATCH })
    expect(await getUserRow(guest.id)).toMatchObject({ email: null, isEmailConfirmed: false })
  })
})
