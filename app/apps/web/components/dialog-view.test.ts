import { afterEach, describe, expect, it, vi } from 'vitest'
import { rememberDialogStart, takeDialogHandoff } from './dialog-start'
import { initialDialogView, rememberDialogView } from './dialog-view'

const START = { greeting: 'Я рядом', resumed: false, sinceLastDialogHours: null }

/** A tab's sessionStorage, as far as the module uses it. */
function stubStorage() {
  const data = new Map<string, string>()
  vi.stubGlobal('sessionStorage', {
    getItem: (name: string) => data.get(name) ?? null,
    setItem: (name: string, value: string) => void data.set(name, value),
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('initialDialogView', () => {
  it('a conversation never opened here starts on the voice', () => {
    stubStorage()
    expect(initialDialogView('v1')).toBe('voice')
  })

  it('typed words on home mean the text, the microphone or an empty start mean the voice', () => {
    stubStorage()
    rememberDialogStart('v2', START, { draft: 'Мне тревожно' })
    expect(initialDialogView('v2')).toBe('text')
    rememberDialogStart('v3', START, { listen: true })
    expect(initialDialogView('v3')).toBe('voice')
  })

  it('words typed and then the microphone pressed: the voice, the words stay the first message', () => {
    stubStorage()
    rememberDialogStart('v8', START, { draft: 'Мне тревожно', listen: true })
    expect(initialDialogView('v8')).toBe('voice')
    expect(takeDialogHandoff('v8')).toEqual({ draft: 'Мне тревожно', listen: true })
  })

  it('what home asked for wins over the view this tab remembered', () => {
    stubStorage()
    rememberDialogView('v4', 'text')
    rememberDialogStart('v4', { ...START, resumed: true }, { listen: true })
    expect(initialDialogView('v4')).toBe('voice')
  })

  it('does not use the handoff up: the screen takes it later, once', () => {
    stubStorage()
    rememberDialogStart('v5', START, { draft: 'текст' })
    initialDialogView('v5')
    expect(takeDialogHandoff('v5')).toEqual({ draft: 'текст' })
  })

  it('returns to the text of a conversation that was being typed', () => {
    stubStorage()
    rememberDialogView('v6', 'text')
    expect(initialDialogView('v6')).toBe('text')
  })

  it('without storage it still works and opens on the voice', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    })
    expect(() => rememberDialogView('v7', 'text')).not.toThrow()
    expect(initialDialogView('v7')).toBe('voice')
  })
})
