/**
 * The person's choice about product analytics: stored on the account (`users.properties.analytics`),
 * so it holds on every device and the server can honour it before reporting anything.
 */
import { describe, expect, it } from 'vitest'
import {
  DELETION_ARCHIVE_KEY,
  GetUserByIdQuery,
  SetUserAnalyticsOptOutCommand,
  SetUserAnalyticsOptOutCommandErrorCode,
  usersManager,
} from '../src/managers/users-manager'
import { accountDeletionProcess, DeleteAccountOperation } from '../src/processes/account-deletion'
import { getUserRow, mockAgent, registerConfirmedUser } from './helpers'

const setOptOut = (userId: string, optOut: boolean) =>
  usersManager.execute(new SetUserAnalyticsOptOutCommand({ userId, optOut }))

async function optedOut(userId: string): Promise<boolean> {
  const found = await usersManager.execute(new GetUserByIdQuery({ userId }))
  if (!found.success) throw new Error('user not found')
  return found.user.analyticsOptOut
}

describe('отказ от аналитики на аккаунте', () => {
  it('по умолчанию аналитика не отключена; отказ записывается и снимается', async () => {
    const user = await registerConfirmedUser()
    expect(await optedOut(user.id)).toBe(false)

    expect(await setOptOut(user.id, true)).toEqual({ success: true })
    expect(await optedOut(user.id)).toBe(true)

    expect(await setOptOut(user.id, false)).toEqual({ success: true })
    expect(await optedOut(user.id)).toBe(false)
  })

  it('не трогает остальное в properties аккаунта', async () => {
    const user = await registerConfirmedUser()
    await setOptOut(user.id, true)
    mockAgent()
    await accountDeletionProcess.execute(new DeleteAccountOperation({ userId: user.id }))

    const row = await getUserRow(user.id)
    // The deletion archive and the choice live side by side in the same column.
    expect(row?.properties).toHaveProperty(DELETION_ARCHIVE_KEY)
    expect(row?.properties).toMatchObject({ analytics: { optOut: true } })
  })

  it('отказывает неизвестному и удалённому аккаунту', async () => {
    expect(await setOptOut('00000000-0000-4000-8000-000000000000', true)).toEqual({
      success: false,
      error: SetUserAnalyticsOptOutCommandErrorCode.USER_NOT_FOUND,
    })
    expect(await setOptOut('not-a-uuid', true)).toEqual({
      success: false,
      error: SetUserAnalyticsOptOutCommandErrorCode.USER_NOT_FOUND,
    })

    const user = await registerConfirmedUser()
    mockAgent()
    await accountDeletionProcess.execute(new DeleteAccountOperation({ userId: user.id }))
    expect(await setOptOut(user.id, true)).toEqual({
      success: false,
      error: SetUserAnalyticsOptOutCommandErrorCode.USER_NOT_FOUND,
    })
  })
})
