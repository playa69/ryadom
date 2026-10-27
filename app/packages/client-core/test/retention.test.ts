import { describe, expect, it } from 'vitest'
import { DIALOG_KEEP_NOTE, GUEST_LIFE_CLAUSE } from '../src/retention'

describe('сроки хранения в текстах экранов', () => {
  it('разговоры — 21 день, гостевой аккаунт — 90 дней, и это разные сроки', () => {
    expect(DIALOG_KEEP_NOTE).toBe('Разговоры хранятся 21 день после последнего сообщения.')
    expect(GUEST_LIFE_CLAUSE).toBe('удаляется через 90 дней без визитов')
  })
})
