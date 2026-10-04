import { describe, expect, it } from 'vitest'
import { OrbMotion, carriesVoice, type OrbFrame, type OrbMotionState } from '../src/voice/orb-motion'

/** Runs the motion for `seconds` at `fps`, feeding `raw(t)` as the loudness; returns every frame. */
function run(
  motion: OrbMotion,
  state: OrbMotionState | ((t: number) => OrbMotionState),
  seconds: number,
  fps: number,
  raw: (t: number) => number = () => 0,
  from = 0,
): OrbFrame[] {
  const frames: OrbFrame[] = []
  const steps = Math.round(seconds * fps)
  for (let i = 1; i <= steps; i++) {
    const t = from + i / fps
    frames.push(motion.step(typeof state === 'function' ? state(t) : state, raw(t), 1 / fps))
  }
  return frames
}

const biggestStep = (values: number[]) =>
  values.slice(1).reduce((worst, value, i) => Math.max(worst, Math.abs(value - values[i]!)), 0)

// A level step of 0.03 in one frame is about 0.6 px on a 380 px sphere with the 10% swell of the
// stylesheet: below what the eye reads as a twitch. The first version of this motion made 12 px.
const LEVEL_STEP = 0.03
const LEVEL_ACCELERATION = 0.012

describe('OrbMotion: громкость', () => {
  it('рваный вход (слоги и мерцание) даёт плавный выход', () => {
    // Speech-like input: 5 Hz syllables over a flickering floor, jumping between 0.05 and 0.9.
    const noisy = (t: number) => (Math.sin(t * 2 * Math.PI * 5) > 0 ? 0.9 : 0.05) * (0.7 + 0.3 * ((t * 997) % 1))
    const frames = run(new OrbMotion('listening'), 'listening', 6, 60, noisy)
    const level = frames.map((f) => f.level)
    expect(biggestStep(level)).toBeLessThan(LEVEL_STEP)
    // But it still moves: a swell, not a flat line.
    expect(Math.max(...level)).toBeGreaterThan(0.3)
  })

  it('одинаково на 30, 60 и 144 кадрах в секунду', () => {
    const voice = (t: number) => (t < 1 ? 0 : 0.8)
    const at = (fps: number) => run(new OrbMotion('listening'), 'listening', 2, fps, voice).at(-1)!.level
    expect(at(30)).toBeCloseTo(at(60), 1)
    expect(at(144)).toBeCloseTo(at(60), 1)
  })

  it('ступенька на входе растёт без излома: скорость нарастает плавно', () => {
    const frames = run(new OrbMotion('speaking'), 'speaking', 2, 60, (t) => (t < 0.5 ? 0 : 0.8))
    const level = frames.map((f) => f.level)
    const speed = level.slice(1).map((value, i) => value - level[i]!)
    // Acceleration stays small: no frame where the speed suddenly changes.
    expect(biggestStep(speed)).toBeLessThan(LEVEL_ACCELERATION)
  })

  it('после конца реплики затихает мягко, а не обрывается', () => {
    const motion = new OrbMotion('speaking')
    run(motion, 'speaking', 2, 60, () => 0.8)
    const after = run(motion, 'idle', 3, 60)
    const level = after.map((f) => f.level)
    expect(level[0]).toBeGreaterThan(0.2)
    expect(biggestStep(level)).toBeLessThan(LEVEL_STEP)
    expect(level.at(-1)).toBeLessThan(0.02)
  })

  it('там, где никто не говорит, вход игнорируется', () => {
    const frames = run(new OrbMotion('idle'), 'idle', 1, 60, () => 1)
    expect(frames.at(-1)!.level).toBe(0)
    expect(carriesVoice('thinking')).toBe(false)
  })

  it('мусор на входе не ломает шар', () => {
    const motion = new OrbMotion('listening')
    const frame = motion.step('listening', Number.NaN, 1 / 60)
    expect(frame.level).toBe(0)
    expect(motion.step('listening', 7, 1 / 60).level).toBeLessThanOrEqual(1)
    expect(motion.step('listening', -3, 1 / 60).level).toBeGreaterThanOrEqual(0)
  })

  it('долгий простой кадра (скрытая вкладка) не бросает шар', () => {
    const motion = new OrbMotion('listening')
    const before = motion.step('listening', 0.8, 1 / 60)
    const after = motion.step('listening', 0.8, 30)
    expect(after.level - before.level).toBeLessThan(0.1)
    expect(Math.abs(after.breath - before.breath)).toBeLessThan(0.05)
  })
})

describe('OrbMotion: дыхание', () => {
  it('меняет темп состояния без скачка фазы', () => {
    const states: OrbMotionState[] = ['idle', 'listening', 'thinking', 'speaking', 'connecting']
    const motion = new OrbMotion('idle')
    const breath: number[] = []
    // Every state for 4 s: a naive switch of the animation duration would jump at each boundary.
    for (const [i, state] of states.entries()) breath.push(...run(motion, state, 4, 60, () => 0, i * 4).map((f) => f.breath))
    expect(biggestStep(breath)).toBeLessThan(0.02)
    expect(Math.min(...breath)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...breath)).toBeLessThanOrEqual(1)
  })

  it('ядро отстаёт от гало, но идёт тем же ходом', () => {
    const frames = run(new OrbMotion('idle'), 'idle', 8, 60)
    const gap = frames.map((f) => Math.abs(f.breath - f.breathLag))
    expect(Math.max(...gap)).toBeGreaterThan(0.02)
    expect(Math.max(...gap)).toBeLessThan(0.35)
  })
})

describe('OrbMotion: вращение при «думаю»', () => {
  it('разгоняется без рывка и крутится с постоянной скоростью', () => {
    const turns: number[] = []
    const motion = new OrbMotion('idle')
    for (const f of run(motion, 'thinking', 6, 60)) turns.push(f.turn)
    // Unwrap the 0..360 angle to compare steps.
    const unwrapped = turns.map((turn, i) => turn + 360 * turns.slice(0, i).filter((prev, j) => turns[j + 1]! < prev).length)
    const steps = unwrapped.slice(1).map((value, i) => value - unwrapped[i]!)
    expect(Math.min(...steps)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...steps)).toBeLessThan(0.6) // 30°/s at 60 fps is 0.5° a frame
    expect(biggestStep(steps)).toBeLessThan(0.02)
  })

  it('после «думаю» никогда не идёт назад и в итоге встаёт на место', () => {
    const motion = new OrbMotion('idle')
    run(motion, 'thinking', 5.3, 60)
    const frames = run(motion, 'speaking', 20, 60, () => 0, 5.3)
    let unwrapped = 0
    let last = frames[0]!.turn
    let worstBack = 0
    for (const f of frames.slice(1)) {
      let delta = f.turn - last
      if (delta < -180) delta += 360
      worstBack = Math.min(worstBack, delta)
      unwrapped += delta
      last = f.turn
    }
    expect(worstBack).toBeGreaterThanOrEqual(-1e-9)
    expect(unwrapped).toBeGreaterThan(0)
    const rest = frames.at(-1)!.turn
    expect(Math.min(rest, 360 - rest)).toBeLessThan(2.5)
    // And it has really stopped, not just wrapped by.
    const tail = frames.slice(-60).map((f) => f.turn)
    expect(Math.max(...tail) - Math.min(...tail)).toBeLessThan(0.5)
  })

  it('без «думаю» шар стоит на месте', () => {
    const frames = run(new OrbMotion('idle'), 'idle', 5, 60)
    expect(frames.every((f) => f.turn === 0)).toBe(true)
  })
})
