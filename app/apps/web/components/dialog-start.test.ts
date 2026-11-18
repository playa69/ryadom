import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claimFreshStart, feedDialogGreeting, rememberDialogStart, takeDialogHandoff } from './dialog-start'

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

  it('keeps the saved flag of an existing legacy dialog', () => {
    // `openspec/changes/remove-unsaved-dialog-option`, «Продолжение открытого разговора».
    const legacy = { ...START, resumed: true, saved: false }
    rememberDialogStart('legacy-unsaved', legacy)
    expect(claimFreshStart('legacy-unsaved')).toBeNull()
    expect(takeDialogHandoff('legacy-unsaved')).toBeNull()
  })
})

describe('feedDialogGreeting', () => {
  // The greeting is remembered per tab (sessionStorage), so a screen mounted again after a reload
  // restores it; the tests run in node, where no storage exists.
  let store: Map<string, string>
  const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')

  beforeEach(() => {
    store = new Map()
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, String(value)),
      },
    })
  })

  afterEach(() => {
    if (original) Object.defineProperty(globalThis, 'sessionStorage', original)
    else delete (globalThis as { sessionStorage?: unknown }).sessionStorage
  })

  it('answers the greeting of the fresh start', () => {
    rememberDialogStart('g1', START)
    expect(feedDialogGreeting('g1')).toBe('Я рядом')
  })

  it('answers null for a dialog this tab never started', () => {
    expect(feedDialogGreeting('g2')).toBeNull()
  })

  it('does not keep the greeting of a resumed start: it is said aloud, not added to the feed', () => {
    rememberDialogStart('g3', { ...START, resumed: true, greeting: 'Продолжим, где остановились.' })
    expect(feedDialogGreeting('g3')).toBeNull()
  })

  it('a resumed start over a fresh one leaves the feed the greeting it began with', () => {
    // "Продолжить" in the unfinished-conversation question re-arms the start as resumed; the feed
    // must still open with its own greeting, not the resumed one.
    rememberDialogStart('g4', START)
    rememberDialogStart('g4', { ...START, resumed: true, greeting: 'Продолжим, где остановились.' })
    expect(feedDialogGreeting('g4')).toBe('Я рядом')
  })

  it('keeps no trace of a conversation held unsaved', () => {
    rememberDialogStart('g5', { ...START, saved: false })
    // This page load still has it in memory…
    expect(feedDialogGreeting('g5')).toBe('Я рядом')
    // …but a re-armed resumed start (as after a reload) finds nothing stored.
    rememberDialogStart('g5', { ...START, resumed: true })
    expect(feedDialogGreeting('g5')).toBeNull()
  })
})
