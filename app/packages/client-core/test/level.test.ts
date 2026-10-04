import { describe, expect, it } from 'vitest'
import { levelOf } from '../src/voice/level'

describe('levelOf', () => {
  it('тишина (середина шкалы) и пустой кадр — ноль', () => {
    expect(levelOf(new Uint8Array(512).fill(128))).toBe(0)
    expect(levelOf(new Uint8Array(0))).toBe(0)
  })

  it('тихая речь заметна, громкая упирается в единицу', () => {
    const quiet = new Uint8Array(512).fill(128 + 6)
    const loud = new Uint8Array(512).fill(128 + 100)
    expect(levelOf(quiet)).toBeGreaterThan(0.1)
    expect(levelOf(quiet)).toBeLessThan(0.5)
    expect(levelOf(loud)).toBe(1)
  })

  it('не зависит от знака полуволны', () => {
    expect(levelOf(new Uint8Array(64).fill(128 + 20))).toBeCloseTo(levelOf(new Uint8Array(64).fill(128 - 20)), 10)
  })
})
