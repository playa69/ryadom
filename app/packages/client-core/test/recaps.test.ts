import { describe, expect, it } from 'vitest'
import { checkRecapText, RECAP_MAX, saidEnoughForRecap } from '../src/recaps'

describe('итог разговора на экране', () => {
  it('итог — один свободный текст: пробелы по краям режутся, пустой отклоняется, длиннее предела отклоняется', () => {
    expect(checkRecapText('  Стало легче  ')).toEqual({ ok: true, recap: 'Стало легче' })
    expect(checkRecapText(' \n ')).toEqual({ ok: false, reason: 'empty' })
    expect(checkRecapText('я'.repeat(RECAP_MAX))).toMatchObject({ ok: true })
    expect(checkRecapText('я'.repeat(RECAP_MAX + 1))).toEqual({ ok: false, reason: 'too-long' })
  })

  it('«сказал достаточно» — не меньше 40 знаков самого человека', () => {
    expect(saidEnoughForRecap([{ role: 'user', text: 'Привет' }, { role: 'assistant', text: 'я'.repeat(100) }])).toBe(false)
    expect(saidEnoughForRecap([{ role: 'user', text: 'я'.repeat(25) }, { role: 'user', text: 'я'.repeat(15) }])).toBe(true)
  })
})
