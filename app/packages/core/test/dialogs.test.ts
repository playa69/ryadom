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
import { agentApiIntegration, StartAgentDialogRequest } from '../src/integrations/agent-api'
import { UpdateUserVoiceCommand, usersManager } from '../src/managers/users-manager'
import { AgentUnavailableError } from '../src/shared'
import { blockDirectly, json, mockAgent, mockFetch, registerConfirmedUser } from './helpers'

const start = (userId: string) => dialogsProcess.execute(new StartDialogOperation({ userId }))
const startNew = (userId: string) =>
  dialogsProcess.execute(new StartDialogOperation({ userId, startNew: true }))

describe('начать разговор', () => {
  it('агенту уходит пользователь в пути и его голос (по умолчанию мужской), больше ничего; возвращает диалог', async () => {
    const user = await registerConfirmedUser()
    const { calls } = mockAgent({
      'POST http://agent.test/v1/users/*/dialogs': () =>
        json({
          dialogId: 'd-42',
          resumed: true,
          greeting: 'Продолжим?',
          sinceLastDialogHours: 72,
          messageCount: 6,
          lastActivityAt: '2026-10-01T20:12:00.000Z',
        }),
    })

    const result = await start(user.id)
    expect(result).toEqual({
      success: true,
      dialog: {
        dialogId: 'd-42',
        resumed: true,
        greeting: 'Продолжим?',
        sinceLastDialogHours: 72,
        messageCount: 6,
        lastActivityAt: '2026-10-01T20:12:00.000Z',
        memoryMode: 'on',
        memoryEnabled: false,
      },
    })

    const call = calls.at(-1)!
    expect(call.method).toBe('POST')
    expect(call.url.pathname).toBe(`/v1/users/${user.id}/dialogs`)
    expect(call.headers.get('Authorization')).toBe('Bearer test-agent-token')
    // A plain start only carries the voice the person picked: no request for a new dialog, nothing about the mode or the client.
    expect(JSON.parse(call.body)).toEqual({ voice: 'male' })
  })

  it('агент не прислал messageCount, lastActivityAt и поля памяти (старый агент) — 0, null, on и false: спрашивать не о чем', async () => {
    const user = await registerConfirmedUser()
    mockAgent({
      'POST http://agent.test/v1/users/*/dialogs': () =>
        json({ dialogId: 'd-3', resumed: true, greeting: 'Продолжим?', sinceLastDialogHours: null }),
    })

    expect(await start(user.id)).toEqual({
      success: true,
      dialog: {
        dialogId: 'd-3',
        resumed: true,
        greeting: 'Продолжим?',
        sinceLastDialogHours: null,
        messageCount: 0,
        lastActivityAt: null,
        memoryMode: 'on',
        memoryEnabled: false,
      },
    })
  })

  it('«без памяти»: агенту уходит memory: off, в ответе режим диалога и включена ли память у человека', async () => {
    const user = await registerConfirmedUser()
    const { calls } = mockAgent({
      'POST http://agent.test/v1/users/*/dialogs': () =>
        json({ dialogId: 'd-9', resumed: false, memoryMode: 'off', memoryEnabled: true }),
    })

    const result = await dialogsProcess.execute(
      new StartDialogOperation({ userId: user.id, startNew: true, memory: 'off' }),
    )

    expect(result).toMatchObject({
      success: true,
      dialog: { dialogId: 'd-9', memoryMode: 'off', memoryEnabled: true },
    })
    expect(JSON.parse(calls.at(-1)!.body)).toEqual({ voice: 'male', new: true, memory: 'off' })
  })

  it('голос из профиля уходит агенту при каждом старте: сменили — следующий диалог говорит иначе', async () => {
    const user = await registerConfirmedUser()
    const { calls } = mockAgent()

    await start(user.id)
    expect(JSON.parse(calls.at(-1)!.body)).toEqual({ voice: 'male' })

    await usersManager.execute(new UpdateUserVoiceCommand({ userId: user.id, voice: 'female' }))
    await start(user.id)
    expect(JSON.parse(calls.at(-1)!.body)).toEqual({ voice: 'female' })
  })

  it('startNew: агенту уходит new: true вместе с голосом', async () => {
    const user = await registerConfirmedUser()
    const { calls } = mockAgent()

    await startNew(user.id)

    expect(JSON.parse(calls.at(-1)!.body)).toEqual({ voice: 'male', new: true })
  })

  it('простой старт при открытом диалоге с репликами возвращает его же: resumed, messageCount и lastActivityAt, ничего не завершено', async () => {
    const user = await registerConfirmedUser()
    const { dialogs } = mockAgent()

    const first = await start(user.id)
    expect(first).toMatchObject({
      success: true,
      dialog: { dialogId: 'd-1', resumed: false, messageCount: 0, lastActivityAt: null },
    })

    // The person talked and left without finishing.
    dialogs.say(user.id, 4)
    const again = await start(user.id)
    expect(again).toMatchObject({
      success: true,
      dialog: { dialogId: 'd-1', resumed: true, messageCount: 4 },
    })
    expect(again.success && typeof again.dialog.lastActivityAt).toBe('string')
    expect(dialogs.ended).toEqual([])
  })

  it('startNew при открытом диалоге с репликами: другой dialogId, resumed: false, прежний завершён', async () => {
    const user = await registerConfirmedUser()
    const { calls, dialogs } = mockAgent()

    await start(user.id)
    dialogs.say(user.id, 2)
    const fresh = await startNew(user.id)

    expect(fresh).toMatchObject({
      success: true,
      dialog: { dialogId: 'd-2', resumed: false, messageCount: 0, lastActivityAt: null },
    })
    expect(dialogs.ended).toEqual(['d-1'])
    expect(dialogs.openOf(user.id)).toBe('d-2')
    // Only the second call asked for it.
    expect(calls.map((call) => JSON.parse(call.body).new)).toEqual([undefined, true])
  })

  it('startNew при пустом открытом диалоге: тот же диалог переиспользуется, ничего не завершается', async () => {
    const user = await registerConfirmedUser()
    const { dialogs } = mockAgent()

    await start(user.id)
    const fresh = await startNew(user.id)

    expect(fresh).toMatchObject({
      success: true,
      dialog: { dialogId: 'd-1', resumed: false, messageCount: 0 },
    })
    expect(dialogs.ended).toEqual([])
  })

  it('открытый диалог одного человека не трогает другого', async () => {
    const first = await registerConfirmedUser()
    const second = await registerConfirmedUser()
    const { dialogs } = mockAgent()

    await start(first.id)
    dialogs.say(first.id)
    await startNew(second.id)

    expect(dialogs.ended).toEqual([])
    expect(dialogs.openOf(first.id)).toBe('d-1')
    expect(dialogs.openOf(second.id)).toBe('d-2')
  })

  it('запрос к агенту без флага и голоса уходит без тела; с одним флагом — { new: true }', async () => {
    const userId = '00000000-0000-4000-8000-000000000001'
    const { calls } = mockAgent()
    const startAt = (data: { voice?: 'male' | 'female'; startNew?: boolean; memory?: 'on' | 'off' }) =>
      agentApiIntegration.execute(new StartAgentDialogRequest({ userId, ...data }))

    await startAt({})
    expect(calls.at(-1)!.body).toBe('')
    expect(calls.at(-1)!.headers.get('Content-Type')).toBeNull()

    await startAt({ voice: 'female' })
    expect(JSON.parse(calls.at(-1)!.body)).toEqual({ voice: 'female' })

    await startAt({ startNew: true })
    expect(JSON.parse(calls.at(-1)!.body)).toEqual({ new: true })

    await startAt({ memory: 'on' })
    expect(JSON.parse(calls.at(-1)!.body)).toEqual({ memory: 'on' })
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

    const result = await dialogsProcess.execute(
      new ListDialogsOperation({ userId: user.id, limit: 20, before: null }),
    )
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.next).toBe('cursor-1')
    expect(result.items[0]).toMatchObject({
      dialogId: 'd-1',
      startedAt: new Date('2026-10-01T20:00:00.000Z'),
      endedAt: new Date('2026-10-01T20:12:00.000Z'),
      summary: { title: 'Про работу', tensionBefore: 7, tensionAfter: 4 },
      // The agent did not say: a dialog of an agent without memory is an ordinary one.
      memoryMode: 'on',
    })
  })

  it('диалог «без памяти» в журнале помечен memoryMode: off', async () => {
    const user = await registerConfirmedUser()
    mockAgent({
      'GET http://agent.test/v1/users/*/dialogs': () =>
        json({
          items: [
            {
              dialogId: 'd-1',
              startedAt: '2026-10-01T20:00:00.000Z',
              endedAt: null,
              summary: null,
              memoryMode: 'off',
            },
            {
              dialogId: 'd-2',
              startedAt: '2026-10-01T19:00:00.000Z',
              endedAt: null,
              summary: null,
              memoryMode: 'on',
            },
          ],
          next: null,
        }),
    })

    const result = await dialogsProcess.execute(
      new ListDialogsOperation({ userId: user.id, limit: 20, before: null }),
    )
    expect(result.success && result.items.map((item) => item.memoryMode)).toEqual(['off', 'on'])
  })

  it('чужой или несуществующий диалог — DIALOG_NOT_FOUND', async () => {
    const user = await registerConfirmedUser()
    mockAgent({ 'GET http://agent.test/v1/users/*/dialogs/*': () => json({ error: 'not_found' }, 404) })
    expect(
      await dialogsProcess.execute(new GetDialogOperation({ userId: user.id, dialogId: 'd-x' })),
    ).toEqual({
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
      // The agent did not count the whole dialog: the counts for analytics are unknown, not zero.
      summary: {
        title: 'Стало легче',
        themes: ['ссора'],
        tensionBefore: 8,
        tensionAfter: 5,
        userMessages: null,
        assistantMessages: null,
      },
    })
    expect(JSON.parse(calls.at(-1)!.body)).toEqual({ takeaway: 'Позвоню маме', tensionAfter: 5 })
  })

  it('сводка несёт счётчики реплик за весь диалог, если агент их посчитал', async () => {
    const user = await registerConfirmedUser()
    mockAgent({
      'POST http://agent.test/v1/users/*/dialogs/*/end': () =>
        json({ summary: { title: 'Разговор', themes: [], userMessages: 9, assistantMessages: 8 } }),
    })
    const result = await dialogsProcess.execute(
      new EndDialogOperation({ userId: user.id, dialogId: 'd-1', takeaway: null, tensionAfter: null }),
    )
    expect(result).toMatchObject({ success: true, summary: { userMessages: 9, assistantMessages: 8 } })
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
