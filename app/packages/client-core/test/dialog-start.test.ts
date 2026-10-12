/**
 * Whether pressing "start" has to ask the person about the conversation they left open.
 */
import { describe, expect, it } from 'vitest'
import type { StartDialogApiResponse } from '@ryadom/contracts/api/dialogs'
import { shouldAskToResume } from '../src/dialog-start'

const start = (patch: Partial<StartDialogApiResponse>): StartDialogApiResponse => ({
  dialogId: 'd-1',
  resumed: false,
  greeting: null,
  sinceLastDialogHours: null,
  messageCount: 0,
  lastActivityAt: null,
  ...patch,
})

describe('спрашивать ли про незавершённый разговор', () => {
  it('открытый диалог с репликами — спрашиваем', () => {
    expect(shouldAskToResume(start({ resumed: true, messageCount: 1 }))).toBe(true)
    expect(shouldAskToResume(start({ resumed: true, messageCount: 42 }))).toBe(true)
  })

  it('открытый, но пустой диалог — не спрашиваем, терять нечего: сразу продолжаем', () => {
    expect(shouldAskToResume(start({ resumed: true, messageCount: 0 }))).toBe(false)
  })

  it('новый диалог — не спрашиваем, как бы ни выглядел счётчик', () => {
    expect(shouldAskToResume(start({ resumed: false, messageCount: 0 }))).toBe(false)
    expect(shouldAskToResume(start({ resumed: false, messageCount: 5 }))).toBe(false)
  })

  it('шлюз старее клиента не прислал messageCount — не спрашиваем, как до появления вопроса', () => {
    const legacy = { resumed: true } as Pick<StartDialogApiResponse, 'resumed' | 'messageCount'>
    expect(shouldAskToResume(legacy)).toBe(false)
  })
})
