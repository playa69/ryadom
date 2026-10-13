import { describe, expect, it } from 'vitest'
import { recapOutcome, takesRecap } from '../src/dialog-recap'

const RECAP = 'Говорили о работе. Решили взять выходной.'

describe('итог разговора на листе завершения', () => {
  it('итог встаёт в пустое поле и сменяет прежний итог, но не слова человека', () => {
    expect(takesRecap('', null)).toBe(true)
    expect(takesRecap('  ', null)).toBe(true)
    expect(takesRecap('Старый итог', 'Старый итог')).toBe(true)
    expect(takesRecap('Позвоню маме', null)).toBe(false)
    expect(takesRecap('Старый итог, и ещё моё', 'Старый итог')).toBe(false)
  })

  it('для аналитики — только судьба итога, без текста', () => {
    expect(recapOutcome(null, null)).toBe('none')
    expect(recapOutcome(null, 'Своё')).toBe('none')
    expect(recapOutcome(RECAP, RECAP)).toBe('kept')
    expect(recapOutcome(`${RECAP} `, RECAP)).toBe('kept') // отправляется обрезанным
    expect(recapOutcome(RECAP, 'Говорили о работе.')).toBe('edited')
    expect(recapOutcome(RECAP, null)).toBe('cleared')
  })
})
