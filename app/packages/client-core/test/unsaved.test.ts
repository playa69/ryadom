/**
 * "Не сохранять этот разговор" on the client (`openspec/changes/archive/2026-10-27-add-unsaved-dialog`): only an answer that says `saved: false` counts,
 * and the id of such a dialog is remembered for the tab, so a reload can still say "Разговор не сохранён".
 */
import { describe, expect, it } from 'vitest'
import { isUnsaved, rememberUnsaved, wasUnsaved } from '../src/unsaved'

function fakeStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const data = new Map<string, string>()
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value) }
}

describe('не сохраняется ли разговор', () => {
  it('только ответ с saved: false; шлюз старее клиента ничего не говорит, и это «сохраняется»', () => {
    expect(isUnsaved({ saved: false })).toBe(true)
    expect(isUnsaved({ saved: true })).toBe(false)
    expect(isUnsaved({})).toBe(false)
    expect(isUnsaved(null)).toBe(false)
  })
})

describe('помним id не сохраняемого разговора на время вкладки', () => {
  it('записанный id находится, чужой нет', () => {
    const storage = fakeStorage()
    rememberUnsaved('d-1', storage)
    rememberUnsaved('d-1', storage)
    expect(wasUnsaved('d-1', storage)).toBe(true)
    expect(wasUnsaved('d-2', storage)).toBe(false)
  })

  it('хранит не больше двадцати последних', () => {
    const storage = fakeStorage()
    for (let i = 0; i < 25; i += 1) rememberUnsaved(`d-${i}`, storage)
    expect(wasUnsaved('d-0', storage)).toBe(false)
    expect(wasUnsaved('d-24', storage)).toBe(true)
  })

  it('испорченное хранилище и его отсутствие — просто «не помним»', () => {
    const broken = { getItem: () => '{не json', setItem: () => undefined }
    expect(wasUnsaved('d-1', broken)).toBe(false)
    const throwing = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    expect(() => rememberUnsaved('d-1', throwing)).not.toThrow()
    expect(wasUnsaved('d-1', throwing)).toBe(false)
  })
})
