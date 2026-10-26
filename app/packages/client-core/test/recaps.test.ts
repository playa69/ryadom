import { describe, expect, it } from 'vitest'
import {
  EMPTY_RECAP_FIELDS,
  fieldsFromRecap,
  recapFieldsTouched,
  recapFromFields,
  saidEnoughForRecap,
} from '../src/recaps'

describe('итог разговора на экране', () => {
  it('пустая форма не тронута; любая буква — тронута', () => {
    expect(recapFieldsTouched(EMPTY_RECAP_FIELDS)).toBe(false)
    expect(recapFieldsTouched({ ...EMPTY_RECAP_FIELDS, agreements: ' \n ' })).toBe(false)
    expect(recapFieldsTouched({ ...EMPTY_RECAP_FIELDS, main: 'а' })).toBe(true)
  })

  it('договорённости — по строке на пункт, пустые строки отбрасываются, лишние пробелы режутся', () => {
    expect(recapFromFields({ about: ' Работа ', main: 'Стало легче', agreements: ' позвонить \n\n  отдохнуть ' })).toEqual({
      ok: true,
      recap: { about: 'Работа', main: 'Стало легче', agreements: ['позвонить', 'отдохнуть'] },
    })
  })

  it('«о чём говорили» и «главное» обязательны вместе; пунктов не больше трёх; пункт не длиннее предела', () => {
    expect(recapFromFields({ about: 'x', main: '', agreements: '' })).toEqual({ ok: false, reason: 'incomplete' })
    expect(recapFromFields({ about: 'x', main: 'y', agreements: '1\n2\n3\n4' })).toEqual({ ok: false, reason: 'too-many' })
    expect(recapFromFields({ about: 'x', main: 'y', agreements: 'я'.repeat(241) })).toEqual({ ok: false, reason: 'too-long' })
  })

  it('итог с сервера превращается в поля и обратно без потерь', () => {
    const recap = { about: 'А', main: 'Б', agreements: ['В', 'Г'] }
    expect(recapFromFields(fieldsFromRecap(recap))).toEqual({ ok: true, recap })
  })

  it('«сказал достаточно» — не меньше 40 знаков самого человека', () => {
    expect(saidEnoughForRecap([{ role: 'user', text: 'Привет' }, { role: 'assistant', text: 'я'.repeat(100) }])).toBe(false)
    expect(saidEnoughForRecap([{ role: 'user', text: 'я'.repeat(25) }, { role: 'user', text: 'я'.repeat(15) }])).toBe(true)
  })
})
