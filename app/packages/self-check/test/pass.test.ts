import { describe, expect, it } from 'vitest'
import { answerPass, backPass, closePass, progressThird, resumePass, showResult, startPass } from '../src/pass'
import { byId } from '../src/catalog'

const gad7 = byId('gad7')!
const phq9 = byId('phq9')!

describe('проход теста', () => {
  it('ответ ведёт к следующему вопросу, «Назад» хранит ответ, после последнего — результат', () => {
    let s = startPass(gad7)
    s = answerPass(gad7, s, 2)
    s = answerPass(gad7, s, 1)
    expect(s.step).toBe(2)
    s = backPass(s)
    expect(s).toMatchObject({ step: 1, answers: expect.arrayContaining([2, 1]) })
    for (let i = 0; i < 6; i++) s = answerPass(gad7, s, 0)
    expect(s.phase).toBe('result')
  })
  it('«×» спрашивает после трёх ответов, раньше и после конца — закрывает', () => {
    let s = startPass(gad7)
    expect(closePass(gad7, s).closed).toBe(true)
    for (let i = 0; i < 3; i++) s = answerPass(gad7, s, 0)
    const c = closePass(gad7, s)
    expect(c).toMatchObject({ closed: false, state: { phase: 'interrupt' } })
    expect(resumePass(c.state).phase).toBe('question')
    for (let i = 0; i < 4; i++) s = answerPass(gad7, s, 0)
    expect(closePass(gad7, s).closed).toBe(true)
  })
  it('кризисный пункт: экран помощи после последнего вопроса, закрыть нельзя, «Посмотреть результат» открывает результат', () => {
    let s = startPass(phq9)
    for (let i = 0; i < 8; i++) s = answerPass(phq9, s, 0)
    expect(s.phase).toBe('question')
    s = answerPass(phq9, s, 1)
    expect(s.phase).toBe('crisis')
    expect(closePass(phq9, s).closed).toBe(false)
    expect(showResult(s).phase).toBe('result')
  })
  it('нулевой ответ на пункте 9 — сразу результат; доля пути по третям', () => {
    let s = startPass(phq9)
    for (let i = 0; i < 9; i++) s = answerPass(phq9, s, 0)
    expect(s.phase).toBe('result')
    expect(progressThird(phq9, startPass(phq9))).toBe('first_third')
  })
})
