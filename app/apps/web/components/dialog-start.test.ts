import { describe, expect, it } from 'vitest'
import { claimFreshStart, rememberDialogStart, takeDialogHandoff } from './dialog-start'

const START = { greeting: 'Я рядом', resumed: false, sinceLastDialogHours: null }

describe('takeDialogHandoff', () => {
  it('hands the draft and the microphone request over once', () => {
    rememberDialogStart('d1', START, { draft: 'Мне тревожно', listen: true })
    expect(takeDialogHandoff('d1')).toEqual({ draft: 'Мне тревожно', listen: true })
    // A later mount of the same dialog (browser "back") must not send the text again.
    expect(takeDialogHandoff('d1')).toBeNull()
  })

  it('keeps nothing for a start without words and without the microphone', () => {
    rememberDialogStart('d2', START, { draft: '', listen: false })
    expect(takeDialogHandoff('d2')).toBeNull()
    rememberDialogStart('d3', START)
    expect(takeDialogHandoff('d3')).toBeNull()
  })

  it('drops a stale handoff when the same dialog is started again without one', () => {
    rememberDialogStart('d4', { ...START, resumed: true }, { draft: 'старое' })
    rememberDialogStart('d4', { ...START, resumed: true })
    expect(takeDialogHandoff('d4')).toBeNull()
  })

  it('arms a new draft for a dialog whose earlier handoff was already taken', () => {
    // The server returns the same id for a conversation that is still open ("Новый разговор" from the
    // sidebar), so the second start is legitimate and must be delivered, once.
    rememberDialogStart('d6', { ...START, resumed: true }, { draft: 'первое' })
    expect(takeDialogHandoff('d6')).toEqual({ draft: 'первое' })
    rememberDialogStart('d6', { ...START, resumed: true }, { draft: 'второе' })
    expect(takeDialogHandoff('d6')).toEqual({ draft: 'второе' })
    expect(takeDialogHandoff('d6')).toBeNull()
  })

  it('is independent of the fresh-start claim', () => {
    rememberDialogStart('d5', START, { draft: 'текст' })
    expect(claimFreshStart('d5')).toEqual(START)
    expect(claimFreshStart('d5')).toBeNull()
    expect(takeDialogHandoff('d5')).toEqual({ draft: 'текст' })
  })
})
