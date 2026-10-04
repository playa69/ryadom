/**
 * Dialogs: our code checks the account and proxies to the agent. The agent itself is
 * stubbed through fetch, so these tests cover our part rather than it.
 */
import { describe, expect, it } from 'vitest'
import {
  dialogsProcess,
  EndDialogOperation,
  EndDialogOperationErrorCode,
  GetDialogOperation,
  GetDialogOperationErrorCode,
  ListDialogsOperation,
  StartDialogOperation,
  StartDialogOperationErrorCode,
} from '../src/processes/dialogs'
import { AgentUnavailableError } from '../src/shared'
import { blockDirectly, json, mockAgent, mockFetch, registerConfirmedUser } from './helpers'

const start = (userId: string) => dialogsProcess.execute(new StartDialogOperation({ userId }))

describe('начать разговор', () => {
  it('агенту уходит только пользователь в пути и ничего больше, возвращает диалог', async () => {
    const user = await registerConfirmedUser()
    const { calls } = mockAgent({
      'POST http://agent.test/v1/users/*/dialogs': () =>
        json({ dialogId: 'd-42', resumed: true, greeting: 'Продолжим?', sinceLastDialogHours: 72 }),
    })

    const result = await start(user.id)
    expect(result).toEqual({
      success: true,
      dialog: { dialogId: 'd-42', resumed: true, greeting: 'Продолжим?', sinceLastDialogHours: 72 },
    })

    const call = calls.at(-1)!
    expect(call.url.pathname).toBe(`/v1/users/${user.id}/dialogs`)
    expect(call.headers.get('Authorization')).toBe('Bearer test-agent-token')
    // No body at all: the agent needs nothing but the person.
    expect(call.body).toBe('')
  })

  it('заблокированному и удалённому разговор недоступен', async () => {
    mockAgent()
    const blocked = await registerConfirmedUser()
    await blockDirectly(blocked.id)
    expect(await start(blocked.id)).toEqual({
      success: false,
      error: StartDialogOperationErrorCode.USER_INACTIVE,
    })

    expect(await start('00000000-0000-4000-8000-000000000000')).toEqual({
      success: false,
      error: StartDialogOperationErrorCode.USER_NOT_FOUND,
    })
  })

  it('агент не ответил — AgentUnavailableError, а не пустой успех', async () => {
    const user = await registerConfirmedUser()
    mockFetch({
      'POST http://agent.test/v1/users/*/dialogs': () => {
        throw new TypeError('fetch failed')
      },
    })
    await expect(start(user.id)).rejects.toBeInstanceOf(AgentUnavailableError)
  })

  it('5xx агента — тоже AgentUnavailableError', async () => {
    const user = await registerConfirmedUser()
    mockFetch({ 'POST http://agent.test/v1/users/*/dialogs': () => json({ error: 'boom' }, 502) })
    await expect(start(user.id)).rejects.toBeInstanceOf(AgentUnavailableError)
  })
})

describe('журнал и один разговор', () => {
  it('список приходит с датами, разобранными из строк', async () => {
    const user = await registerConfirmedUser()
    mockAgent({
      'GET http://agent.test/v1/users/*/dialogs': () =>
        json({
          items: [
            {
              dialogId: 'd-1',
              mode: 'vent',
              startedAt: '2026-10-01T20:00:00.000Z',
              endedAt: '2026-10-01T20:12:00.000Z',
              summary: { title: 'Про работу', themes: ['работа'], tensionBefore: 7, tensionAfter: 4 },
            },
          ],
          next: 'cursor-1',
        }),
    })

    const result = await dialogsProcess.execute(new ListDialogsOperation({ userId: user.id, limit: 20, before: null }))
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.next).toBe('cursor-1')
    expect(result.items[0]).toMatchObject({
      dialogId: 'd-1',
      startedAt: new Date('2026-10-01T20:00:00.000Z'),
      endedAt: new Date('2026-10-01T20:12:00.000Z'),
      summary: { title: 'Про работу', tensionBefore: 7, tensionAfter: 4 },
    })
  })

  it('чужой или несуществующий диалог — DIALOG_NOT_FOUND', async () => {
    const user = await registerConfirmedUser()
    mockAgent({ 'GET http://agent.test/v1/users/*/dialogs/*': () => json({ error: 'not_found' }, 404) })
    expect(await dialogsProcess.execute(new GetDialogOperation({ userId: user.id, dialogId: 'd-x' }))).toEqual({
      success: false,
      error: GetDialogOperationErrorCode.DIALOG_NOT_FOUND,
    })
  })

  it('сообщения диалога превращаются в DTO', async () => {
    const user = await registerConfirmedUser()
    mockAgent({
      'GET http://agent.test/v1/users/*/dialogs/*': () =>
        json({
          dialogId: 'd-1',
          mode: 'vent',
          startedAt: '2026-10-01T20:00:00.000Z',
          endedAt: null,
          summary: null,
          messages: [
            { id: 'm-1', role: 'user', text: 'тяжело', createdAt: '2026-10-01T20:00:10.000Z' },
            {
              id: 'm-2',
              role: 'assistant',
              text: 'я рядом',
              createdAt: '2026-10-01T20:00:12.000Z',
            },
          ],
        }),
    })

    const result = await dialogsProcess.execute(new GetDialogOperation({ userId: user.id, dialogId: 'd-1' }))
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.dialog.messages).toHaveLength(2)
    expect(result.dialog.messages[0]).toMatchObject({ id: 'm-1', role: 'user', text: 'тяжело' })
    expect(result.dialog.messages[1]).toMatchObject({ id: 'm-2', role: 'assistant', text: 'я рядом' })
  })
})

describe('завершение разговора', () => {
  it('передаёт «что забираешь с собой» и напряжение, возвращает сводку', async () => {
    const user = await registerConfirmedUser()
    const { calls } = mockAgent({
      'POST http://agent.test/v1/users/*/dialogs/*/end': () =>
        json({ summary: { title: 'Стало легче', themes: ['ссора'], tensionBefore: 8, tensionAfter: 5 } }),
    })

    const result = await dialogsProcess.execute(
      new EndDialogOperation({ userId: user.id, dialogId: 'd-1', takeaway: 'Позвоню маме', tensionAfter: 5 }),
    )
    expect(result).toEqual({
      success: true,
      summary: { title: 'Стало легче', themes: ['ссора'], tensionBefore: 8, tensionAfter: 5 },
    })
    expect(JSON.parse(calls.at(-1)!.body)).toEqual({ takeaway: 'Позвоню маме', tensionAfter: 5 })
  })

  it('уже закрытый или чужой диалог — DIALOG_NOT_FOUND', async () => {
    const user = await registerConfirmedUser()
    mockAgent({ 'POST http://agent.test/v1/users/*/dialogs/*/end': () => json({ error: 'not_found' }, 404) })
    expect(
      await dialogsProcess.execute(
        new EndDialogOperation({ userId: user.id, dialogId: 'd-x', takeaway: null, tensionAfter: null }),
      ),
    ).toEqual({ success: false, error: EndDialogOperationErrorCode.DIALOG_NOT_FOUND })
  })
})
