/**
 * Renaming is the only manager command the applications call directly.
 */
import { describe, expect, it } from 'vitest'
import { ValidationError } from '../src/shared'
import {
  GetUserByIdQuery,
  UpdateUserNameCommand,
  UpdateUserNameCommandErrorCode,
  usersManager,
} from '../src/managers/users-manager'
import { accountDeletionProcess, DeleteAccountOperation } from '../src/processes/account-deletion'
import { getUserRow, mockAgent, registerConfirmedUser } from './helpers'

const rename = (userId: string, name: string) => usersManager.execute(new UpdateUserNameCommand({ userId, name }))

describe('имя пользователя', () => {
  it('меняет имя с обрезкой пробелов; профиль читается отдельным query', async () => {
    const user = await registerConfirmedUser({ name: 'Аня' })
    expect(await rename(user.id, '  Анна  ')).toEqual({ success: true })
    expect(await usersManager.execute(new GetUserByIdQuery({ userId: user.id }))).toMatchObject({
      success: true,
      user: { id: user.id, name: 'Анна' },
    })
  })

  it('отказывает неизвестному и удалённому аккаунту, пустое имя — баг вызывающего', async () => {
    expect(await rename('00000000-0000-4000-8000-000000000000', 'Анна')).toEqual({
      success: false,
      error: UpdateUserNameCommandErrorCode.USER_NOT_FOUND,
    })
    expect(await rename('not-a-uuid', 'Анна')).toEqual({
      success: false,
      error: UpdateUserNameCommandErrorCode.USER_NOT_FOUND,
    })
    const user = await registerConfirmedUser()
    await expect(rename(user.id, '   ')).rejects.toBeInstanceOf(ValidationError)
    // Deleting an account erases the data held by the agent, so it is stubbed.
    mockAgent()
    await accountDeletionProcess.execute(new DeleteAccountOperation({ userId: user.id }))
    expect(await rename(user.id, 'Анна')).toEqual({
      success: false,
      error: UpdateUserNameCommandErrorCode.USER_NOT_FOUND,
    })
    expect((await getUserRow(user.id))?.name).toBeNull()
  })
})
