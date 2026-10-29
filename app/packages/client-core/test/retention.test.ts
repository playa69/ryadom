import { describe, expect, it } from 'vitest'
import { DIALOG_KEEP_NOTE, GUEST_LIFE_CLAUSE } from '../src/retention'

describe('сроки хранения в текстах экранов', () => {
  it('разговоры хранятся 90 дней после последнего сообщения, гостевой аккаунт удаляется через 90 дней без визитов', () => {
    expect(DIALOG_KEEP_NOTE).toBe('Разговоры хранятся 90 дней после последнего сообщения.')
    expect(GUEST_LIFE_CLAUSE).toBe('удаляется через 90 дней без визитов')
  })
})
