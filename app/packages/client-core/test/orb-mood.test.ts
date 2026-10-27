import { afterEach, describe, expect, it, vi } from 'vitest'
import { MOOD_HOLD_MS, MOOD_MIN_INTENSITY, createMoodHold, orbMoodFor } from '../src/voice/orb-mood'

describe('orbMoodFor', () => {
  it('сонный, злой и испуганный показываются, остальное нет', () => {
    expect(orbMoodFor('sleepy', 0.8)).toBe('sleepy')
    expect(orbMoodFor('angry', 0.8)).toBe('angry')
    expect(orbMoodFor('afraid', 0.8)).toBe('afraid')
    for (const tone of ['neutral', 'calm', 'sad'] as const) expect(orbMoodFor(tone, 1)).toBeNull()
  })

  it('слабое настроение не показывается', () => {
    expect(orbMoodFor('angry', MOOD_MIN_INTENSITY - 0.01)).toBeNull()
    expect(orbMoodFor('angry', MOOD_MIN_INTENSITY)).toBe('angry')
  })
})

describe('createMoodHold', () => {
  afterEach(() => vi.useRealTimers())

  it('держит настроение и потом отпускает; новое продлевает', () => {
    vi.useFakeTimers()
    const seen: unknown[] = []
    const hold = createMoodHold((mood) => seen.push(mood))
    hold.report('angry', 0.9)
    vi.advanceTimersByTime(MOOD_HOLD_MS - 1)
    hold.report('sleepy', 0.9)
    vi.advanceTimersByTime(MOOD_HOLD_MS - 1)
    expect(seen).toEqual(['angry', 'sleepy'])
    vi.advanceTimersByTime(1)
    expect(seen).toEqual(['angry', 'sleepy', null])
  })

  it('clear снимает настроение сразу и гасит таймер', () => {
    vi.useFakeTimers()
    const seen: unknown[] = []
    const hold = createMoodHold((mood) => seen.push(mood))
    hold.report('afraid', 0.9)
    hold.clear()
    vi.advanceTimersByTime(MOOD_HOLD_MS * 2)
    expect(seen).toEqual(['afraid', null])
  })
})
