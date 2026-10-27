/**
 * The voice the agent speaks with: a profile setting, male until the person picks another.
 */
import { describe, expect, it } from 'vitest'
import { ValidationError } from '../src/shared'
import {
  GetUserByIdQuery,
  UpdateUserVoiceCommand,
  UpdateUserVoiceCommandErrorCode,
  usersManager,
} from '../src/managers/users-manager'
import { accountDeletionProcess, DeleteAccountOperation } from '../src/processes/account-deletion'
import { getUserRow, mockAgent, registerConfirmedUser } from './helpers'

const setVoice = (userId: string, voice: 'male' | 'female', voiceName?: string | null) =>
  usersManager.execute(new UpdateUserVoiceCommand({ userId, voice, voiceName }))

describe('голос агента', () => {
  it('у нового аккаунта мужской; меняется на женский и обратно, профиль читает выбор', async () => {
    const user = await registerConfirmedUser()
    expect((await getUserRow(user.id))?.agentVoice).toBe('male')

    expect(await setVoice(user.id, 'female')).toEqual({ success: true })
    expect(await usersManager.execute(new GetUserByIdQuery({ userId: user.id }))).toMatchObject({
      success: true,
      user: { id: user.id, agentVoice: 'female' },
    })

    expect(await setVoice(user.id, 'male')).toEqual({ success: true })
    expect((await getUserRow(user.id))?.agentVoice).toBe('male')
  })

  it('конкретный голос хранится рядом с родом; выбор по роду сбрасывает его, мусор отвергается', async () => {
    const user = await registerConfirmedUser()
    expect((await getUserRow(user.id))?.agentVoiceName).toBeNull()

    expect(await setVoice(user.id, 'female', 'Aoede')).toEqual({ success: true })
    expect(await getUserRow(user.id)).toMatchObject({ agentVoice: 'female', agentVoiceName: 'Aoede' })
    expect(await usersManager.execute(new GetUserByIdQuery({ userId: user.id }))).toMatchObject({
      success: true,
      user: { agentVoice: 'female', agentVoiceName: 'Aoede' },
    })

    // Setting only the gender goes back to the agent's default voice for it.
    expect(await setVoice(user.id, 'male')).toEqual({ success: true })
    expect(await getUserRow(user.id)).toMatchObject({ agentVoice: 'male', agentVoiceName: null })

    for (const junk of ['', 'Kore; DROP', 'x'.repeat(40), 'Ко ре']) {
      await expect(setVoice(user.id, 'female', junk)).rejects.toBeInstanceOf(ValidationError)
    }
    expect(await getUserRow(user.id)).toMatchObject({ agentVoice: 'male', agentVoiceName: null })
  })

  it('отказывает неизвестному и удалённому аккаунту, чужое значение — баг вызывающего', async () => {
    expect(await setVoice('00000000-0000-4000-8000-000000000000', 'female')).toEqual({
      success: false,
      error: UpdateUserVoiceCommandErrorCode.USER_NOT_FOUND,
    })
    expect(await setVoice('not-a-uuid', 'female')).toEqual({
      success: false,
      error: UpdateUserVoiceCommandErrorCode.USER_NOT_FOUND,
    })

    const user = await registerConfirmedUser()
    await expect(setVoice(user.id, 'robot' as 'male')).rejects.toBeInstanceOf(ValidationError)
    expect((await getUserRow(user.id))?.agentVoice).toBe('male')

    // Deleting an account erases the data held by the agent, so it is stubbed.
    mockAgent()
    await accountDeletionProcess.execute(new DeleteAccountOperation({ userId: user.id }))
    expect(await setVoice(user.id, 'female')).toEqual({
      success: false,
      error: UpdateUserVoiceCommandErrorCode.USER_NOT_FOUND,
    })
  })
})
