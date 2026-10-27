/**
 * Dialogs: our code checks the account and proxies to the agent. The agent itself is
 * stubbed through fetch, so these tests cover our part rather than it.
 */
import { describe, expect, it } from 'vitest'
import {
  ConfirmDialogDeletedOperation,
  DeleteDialogOperation,
  DeleteDialogOperationErrorCode,
  DraftRecapOperation,
  DraftRecapOperationErrorCode,
  GetDialogSettingsOperation,
  ListRecapsOperation,
  PutDialogSettingsOperation,
  PutRecapOperation,
  PutRecapOperationErrorCode,
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
import {
  CreateDialogShareCommand,
  dialogSharesManager,
  GetActiveDialogShareQuery,
} from '../src/managers/dialog-shares-manager'
import { UpdateUserVoiceCommand, usersManager } from '../src/managers/users-manager'
import { AFTER_DELETE_DELAY_SECONDS, getEnqueuedJobs } from '../src/services/job-queue-service'
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

    // A concrete voice the person picked goes to the agent next to the gender.
    await usersManager.execute(
      new UpdateUserVoiceCommand({ userId: user.id, voice: 'female', voiceName: 'Aoede' }),
    )
    await start(user.id)
    expect(JSON.parse(calls.at(-1)!.body)).toEqual({ voice: 'female', voiceName: 'Aoede' })
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
        recap: null,
        recapStatus: 'none',
        recapSource: null,
        recapAvailable: null,
        recapAt: null,
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

const RECAP = 'Ты рассказал про работу и решил поговорить с руководителем до пятницы.'

describe('итог разговора', () => {
  it('написанный человеком итог уходит агенту вместе с завершением и приходит в сводке', async () => {
    const user = await registerConfirmedUser()
    const { calls } = mockAgent({
      'POST http://agent.test/v1/users/*/dialogs/*/end': () =>
        json({
          summary: {
            title: 'Разговор',
            themes: [],
            recap: RECAP,
            recapStatus: 'ready',
            recapSource: 'draft',
            recapAt: '2026-10-24T09:00:00.000Z',
          },
        }),
    })
    const result = await dialogsProcess.execute(
      new EndDialogOperation({ userId: user.id, dialogId: 'd-1', takeaway: RECAP, tensionAfter: 4, recapSource: 'draft' }),
    )
    expect(result).toMatchObject({
      success: true,
      summary: { recap: RECAP, recapStatus: 'ready', recapSource: 'draft', recapAt: new Date('2026-10-24T09:00:00.000Z') },
    })
    expect(JSON.parse(calls.at(-1)!.body)).toEqual({ takeaway: RECAP, tensionAfter: 4, recapSource: 'draft' })
  })

  it('агент без итогов (прежний) не говорит ни pending, ни ready: статус none', async () => {
    const user = await registerConfirmedUser()
    mockAgent({ 'POST http://agent.test/v1/users/*/dialogs/*/end': () => json({ summary: { title: 'Разговор', themes: [] } }) })
    const result = await dialogsProcess.execute(
      new EndDialogOperation({ userId: user.id, dialogId: 'd-1', takeaway: null, tensionAfter: null }),
    )
    expect(result).toMatchObject({ success: true, summary: { recap: null, recapStatus: 'none', recapSource: null } })
  })

  it('список итогов: только разговоры с итогом, страница и курсор', async () => {
    const user = await registerConfirmedUser()
    const { calls } = mockAgent({
      'GET http://agent.test/v1/users/*/recaps': () =>
        json({
          items: [
            { dialogId: 'd-2', startedAt: '2026-10-24T09:00:00Z', title: 'Работа', recap: RECAP, recapSource: 'auto', recapAt: null },
            { dialogId: 'd-bad', startedAt: '2026-10-23T09:00:00Z', title: null, recap: null, recapSource: null, recapAt: null },
          ],
          next: 'cursor-2',
        }),
    })
    const result = await dialogsProcess.execute(new ListRecapsOperation({ userId: user.id, limit: 20, before: 'cursor-1' }))
    expect(result).toMatchObject({ success: true, next: 'cursor-2', items: [{ dialogId: 'd-2', recap: RECAP, recapSource: 'auto' }] })
    expect((result as { items: unknown[] }).items).toHaveLength(1)
    expect(calls.at(-1)!.url.search).toBe('?limit=20&before=cursor-1')
  })

  it('«Предзаполнить»: черновик возвращается, отказы агента переводятся в коды', async () => {
    const user = await registerConfirmedUser()
    mockAgent({ 'POST http://agent.test/v1/users/*/dialogs/*/recap/draft': () => json({ recap: RECAP }) })
    expect(await dialogsProcess.execute(new DraftRecapOperation({ userId: user.id, dialogId: 'd-1' }))).toEqual({ success: true, recap: RECAP })
    mockAgent({ 'POST http://agent.test/v1/users/*/dialogs/*/recap/draft': () => json({ error: { code: 'RECAP_NOT_AVAILABLE' } }, 409) })
    expect(await dialogsProcess.execute(new DraftRecapOperation({ userId: user.id, dialogId: 'd-1' }))).toEqual({
      success: false,
      error: DraftRecapOperationErrorCode.RECAP_NOT_AVAILABLE,
    })
    mockAgent({ 'POST http://agent.test/v1/users/*/dialogs/*/recap/draft': () => json({ error: { code: 'RECAP_UNAVAILABLE' } }, 502) })
    expect(await dialogsProcess.execute(new DraftRecapOperation({ userId: user.id, dialogId: 'd-1' }))).toEqual({
      success: false,
      error: DraftRecapOperationErrorCode.UNAVAILABLE,
    })
    mockAgent({ 'POST http://agent.test/v1/users/*/dialogs/*/recap/draft': () => json({ error: { code: 'AGENT_DIALOG_NOT_FOUND' } }, 404) })
    expect(await dialogsProcess.execute(new DraftRecapOperation({ userId: user.id, dialogId: 'd-x' }))).toEqual({
      success: false,
      error: DraftRecapOperationErrorCode.DIALOG_NOT_FOUND,
    })
  })

  it('итог из журнала: уходит агенту с источником, отказ — код', async () => {
    const user = await registerConfirmedUser()
    const { calls } = mockAgent({
      'PUT http://agent.test/v1/users/*/dialogs/*/recap': () =>
        json({ summary: { title: 'Разговор', themes: [], recap: RECAP, recapStatus: 'ready', recapSource: 'manual' } }),
    })
    expect(
      await dialogsProcess.execute(new PutRecapOperation({ userId: user.id, dialogId: 'd-1', recap: RECAP, source: 'manual' })),
    ).toMatchObject({ success: true, summary: { recap: RECAP, recapSource: 'manual' } })
    expect(JSON.parse(calls.at(-1)!.body)).toEqual({ recap: RECAP, source: 'manual' })
    mockAgent({ 'PUT http://agent.test/v1/users/*/dialogs/*/recap': () => json({ error: { code: 'RECAP_NOT_AVAILABLE' } }, 409) })
    expect(
      await dialogsProcess.execute(new PutRecapOperation({ userId: user.id, dialogId: 'd-1', recap: RECAP, source: 'manual' })),
    ).toEqual({ success: false, error: PutRecapOperationErrorCode.RECAP_NOT_AVAILABLE })
  })

  it('«Подводить итог автоматически»: читается и сохраняется у агента', async () => {
    const user = await registerConfirmedUser()
    const { calls } = mockAgent({
      'GET http://agent.test/v1/users/*/dialog-settings': () => json({ recapEnabled: true }),
      'PUT http://agent.test/v1/users/*/dialog-settings': () => json({ recapEnabled: false }),
    })
    expect(await dialogsProcess.execute(new GetDialogSettingsOperation({ userId: user.id }))).toEqual({ success: true, recapEnabled: true })
    expect(await dialogsProcess.execute(new PutDialogSettingsOperation({ userId: user.id, recapEnabled: false }))).toEqual({
      success: true,
      recapEnabled: false,
    })
    expect(JSON.parse(calls.at(-1)!.body)).toEqual({ recapEnabled: false })
  })
})

describe('удалить разговор', () => {
  const dialog = { dialogId: 'd-1', startedAt: '2026-10-20T10:00:00.000Z', endedAt: '2026-10-20T10:10:00.000Z', summary: null, messages: [] }

  it('агент стирает разговор, ссылка «Поделиться» гаснет, возвращается дата начала — по ней сбрасывается неделя', async () => {
    const user = await registerConfirmedUser()
    const now = new Date()
    await dialogSharesManager.execute(
      new CreateDialogShareCommand({
        id: crypto.randomUUID(),
        userId: user.id,
        dialogId: 'd-1',
        tokenHash: 'hash-1',
        upToMessageId: null,
        expiresAt: new Date(now.getTime() + 3_600_000),
        now,
        maxActive: 5,
      }),
    )
    const before = await dialogSharesManager.execute(new GetActiveDialogShareQuery({ userId: user.id, dialogId: 'd-1', now: new Date() }))
    expect(before).toMatchObject({ share: { dialogId: 'd-1' } })
    const { calls } = mockAgent({
      'GET http://agent.test/v1/users/*/dialogs/*': () => json(dialog),
      'DELETE http://agent.test/v1/users/*/dialogs/*': () => new Response(null, { status: 204 }),
    })
    const result = await dialogsProcess.execute(new DeleteDialogOperation({ userId: user.id, dialogId: 'd-1' }))
    expect(result).toEqual({
      success: true,
      startedAt: new Date('2026-10-20T10:00:00.000Z'),
      afterDeleteJobId: expect.any(String),
    })
    expect(calls.map((c) => c.method)).toEqual(['GET', 'DELETE'])
    const active = await dialogSharesManager.execute(new GetActiveDialogShareQuery({ userId: user.id, dialogId: 'd-1', now: new Date() }))
    expect(active).toMatchObject({ share: null })
  })

  it('чужого и несуществующего разговора нет: ничего не удалено', async () => {
    const user = await registerConfirmedUser()
    const { calls } = mockAgent({
      'GET http://agent.test/v1/users/*/dialogs/*': () => json({ error: { code: 'AGENT_DIALOG_NOT_FOUND' } }, 404),
    })
    expect(await dialogsProcess.execute(new DeleteDialogOperation({ userId: user.id, dialogId: 'd-x' }))).toEqual({
      success: false,
      error: DeleteDialogOperationErrorCode.DIALOG_NOT_FOUND,
    })
    expect(calls.map((c) => c.method)).toEqual(['GET'])
  })
})

describe('удаление разговора: сброс недели не теряется', () => {
  // `openspec/changes/add-job-queue`, «Когда пересчитываются итоги недели»: сценарии «Сброс после удаления не удался»
  // и «Удаление разговора не состоялось».
  const dialog = {
    dialogId: 'd-1',
    startedAt: '2026-10-20T10:00:00.000Z',
    endedAt: '2026-10-20T10:10:00.000Z',
    summary: null,
    messages: [],
  }
  const askedAbout = (userId: string) => ({
    queue: 'dialogs.after-delete',
    data: { userId, dialogId: 'd-1', dialogAt: '2026-10-20T10:00:00.000Z' },
    startAfterSeconds: AFTER_DELETE_DELAY_SECONDS,
    singletonKey: `${userId}:d-1`,
  })

  async function shareOf(userId: string, dialogId = 'd-1') {
    const now = new Date()
    await dialogSharesManager.execute(
      new CreateDialogShareCommand({
        id: crypto.randomUUID(),
        userId,
        dialogId,
        tokenHash: `hash-${userId}`,
        upToMessageId: null,
        expiresAt: new Date(now.getTime() + 3_600_000),
        now,
        maxActive: 5,
      }),
    )
  }
  const activeShare = async (userId: string) =>
    (await dialogSharesManager.execute(new GetActiveDialogShareQuery({ userId, dialogId: 'd-1', now: new Date() }))).share

  it('задача сброса ставится до вызова агента: идентификаторы и дата начала, выдержка 2 минуты, ключ человек:разговор', async () => {
    const user = await registerConfirmedUser()
    const order: string[] = []
    mockAgent({
      'GET http://agent.test/v1/users/*/dialogs/*': () => json(dialog),
      'DELETE http://agent.test/v1/users/*/dialogs/*': () => {
        // At the moment the agent is asked, the job is already in the queue.
        order.push(`agent asked, jobs queued: ${getEnqueuedJobs().length}`)
        return new Response(null, { status: 204 })
      },
    })

    const result = await dialogsProcess.execute(new DeleteDialogOperation({ userId: user.id, dialogId: 'd-1' }))

    expect(order).toEqual(['agent asked, jobs queued: 1'])
    expect(getEnqueuedJobs()).toEqual([expect.objectContaining(askedAbout(user.id))])
    expect(result).toMatchObject({ success: true, afterDeleteJobId: getEnqueuedJobs()[0]!.id })
    expect(AFTER_DELETE_DELAY_SECONDS).toBe(120)
  })

  it('Удаление разговора не состоялось: агент отказал — разговор на месте, задача лежит и ничего не меняет', async () => {
    const user = await registerConfirmedUser()
    await shareOf(user.id)
    mockAgent({
      'GET http://agent.test/v1/users/*/dialogs/*': () => json(dialog),
      'DELETE http://agent.test/v1/users/*/dialogs/*': () => json({ error: 'boom' }, 502),
    })

    await expect(
      dialogsProcess.execute(new DeleteDialogOperation({ userId: user.id, dialogId: 'd-1' })),
    ).rejects.toBeInstanceOf(AgentUnavailableError)
    expect(getEnqueuedJobs()).toHaveLength(1)

    // The job meets the conversation in place: nothing is revoked, nothing is reset.
    mockAgent({ 'GET http://agent.test/v1/users/*/dialogs/*': () => json(dialog) })
    expect(
      await dialogsProcess.execute(new ConfirmDialogDeletedOperation({ userId: user.id, dialogId: 'd-1' })),
    ).toEqual({ success: true, deleted: false })
    expect(await activeShare(user.id)).not.toBeNull()
  })

  it('Сброс после удаления не удался: у агента разговора уже нет — ссылка гаснет, повтор ничего не ломает', async () => {
    const user = await registerConfirmedUser()
    await shareOf(user.id)
    mockAgent({
      'GET http://agent.test/v1/users/*/dialogs/*': () => json({ error: { code: 'AGENT_DIALOG_NOT_FOUND' } }, 404),
    })
    const confirm = () =>
      dialogsProcess.execute(new ConfirmDialogDeletedOperation({ userId: user.id, dialogId: 'd-1' }))

    expect(await confirm()).toEqual({ success: true, deleted: true })
    expect(await activeShare(user.id)).toBeNull()
    expect(await confirm()).toEqual({ success: true, deleted: true })
  })

  it('агент не отвечает — исключение: очередь повторит задачу', async () => {
    const user = await registerConfirmedUser()
    mockAgent({ 'GET http://agent.test/v1/users/*/dialogs/*': () => json({ error: 'boom' }, 503) })

    await expect(
      dialogsProcess.execute(new ConfirmDialogDeletedOperation({ userId: user.id, dialogId: 'd-1' })),
    ).rejects.toBeInstanceOf(AgentUnavailableError)
  })
})
