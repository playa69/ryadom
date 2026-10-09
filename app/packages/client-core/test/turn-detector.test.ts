import { describe, expect, it } from 'vitest'
import {
  MAX_TURN_MS,
  PRE_ROLL_MS,
  TURN_DEFAULTS,
  TurnDetector,
  type TurnEvent,
  type TurnSample,
} from '../src/voice/turn-detector'

/** One sample every 30 ms, as `watchTurns` takes them. */
const STEP = 30
const QUIET = 0.01
const VOICE = 0.35

interface Signal {
  level: (t: number) => number
  agentLevel?: (t: number) => number
  agentSpeaking?: (t: number) => boolean
  busy?: (t: number) => boolean
}

interface Heard {
  at: number
  event: TurnEvent
}

/** Runs the detector over `ms` of a made-up signal from `from`; returns every event with its time. */
function run(detector: TurnDetector, ms: number, signal: Signal, from = 0): Heard[] {
  const heard: Heard[] = []
  for (let t = from; t <= from + ms; t += STEP) {
    const sample: TurnSample = {
      now: t,
      level: signal.level(t),
      agentLevel: signal.agentLevel?.(t) ?? 0,
      agentSpeaking: signal.agentSpeaking?.(t) ?? false,
      busy: signal.busy?.(t) ?? false,
    }
    const event = detector.step(sample)
    if (event) heard.push({ at: t, event })
  }
  return heard
}

/**
 * A voice between `start` and `end` ms over a quiet room: syllables that dip to half, and every 1.2 s a
 * short gap between words that goes down to the room, as real speech does.
 */
const speech = (start: number, end: number) => (t: number) => {
  if (t < start || t >= end) return QUIET
  if ((t - start) % 1200 >= 1110) return QUIET * 2
  return VOICE * (Math.sin(t / 32) > -0.6 ? 1 : 0.55)
}

const types = (heard: Heard[]) => heard.map((h) => h.event.type)

describe('TurnDetector: начало и конец реплики', () => {
  it('голос дольше ~250 мс начинает реплику, тишина ~900 мс её заканчивает', () => {
    const detector = new TurnDetector()
    const heard = run(detector, 6000, { level: speech(1000, 3000) })
    expect(types(heard)).toEqual(['start', 'end'])
    const [start, end] = heard
    expect(start!.event).toEqual({ type: 'start', bargeIn: false })
    expect(start!.at - 1000).toBeGreaterThanOrEqual(TURN_DEFAULTS.startMs)
    expect(start!.at - 1000).toBeLessThan(TURN_DEFAULTS.startMs + 2 * STEP)
    expect(end!.event).toEqual({ type: 'end', reason: 'silence' })
    // About a second after the voice stopped, as the issue asks (the last syllable may dip a little early).
    expect(end!.at - 3000).toBeGreaterThanOrEqual(800)
    expect(end!.at - 3000).toBeLessThan(1100)
  })

  it('буфер начала речи покрывает время до срабатывания и ещё ~300 мс', () => {
    expect(PRE_ROLL_MS).toBeGreaterThanOrEqual(TURN_DEFAULTS.startMs + 300)
  })

  it('короткий звук (стук, кашель) реплику не начинает', () => {
    const detector = new TurnDetector()
    const click = (t: number) => (t >= 1000 && t < 1150 ? 0.9 : QUIET)
    expect(run(detector, 3000, { level: click })).toEqual([])
  })

  it('паузы между слогами и словами реплику не обрывают', () => {
    const detector = new TurnDetector()
    // Words of 400 ms with 300 ms gaps for four seconds: one turn.
    const words = (t: number) => (t >= 500 && t < 4500 && (t - 500) % 700 < 400 ? VOICE : QUIET)
    expect(types(run(detector, 7000, { level: words }))).toEqual(['start', 'end'])
  })

  it('тихая комната и шумная: порог подстраивается под фон', () => {
    const detector = new TurnDetector()
    // Ten seconds of a steady hum at 0.12 (a fan, a street): no turn from the hum itself.
    const hum = (t: number) => 0.12 + 0.01 * Math.sin(t / 50)
    expect(run(detector, 10_000, { level: hum })).toEqual([])
    expect(detector.threshold(10_000)).toBeGreaterThan(0.12)
    // A voice over the hum is still a turn, and it ends although the hum goes on.
    const voiceOverHum = (t: number) => (t >= 11_000 && t < 13_000 ? 0.6 : hum(t))
    expect(types(run(detector, 5000, { level: voiceOverHum }, 10_000 + STEP))).toEqual(['start', 'end'])
  })

  it('шум, который появился посреди реплики и не стихает, её не держит', () => {
    const detector = new TurnDetector()
    // A voice from 1 s, a vacuum cleaner from 2 s that never stops.
    const level = (t: number) => Math.max(speech(1000, 3000)(t), t >= 2000 ? 0.2 : QUIET)
    const heard = run(detector, 15_000, { level })
    expect(types(heard)).toEqual(['start', 'end'])
    expect(heard[1]!.event).toEqual({ type: 'end', reason: 'silence' })
  })

  it('мусор на входе не ломает детектор', () => {
    const detector = new TurnDetector()
    expect(
      run(detector, 1000, { level: () => Number.NaN, agentLevel: () => Number.POSITIVE_INFINITY }),
    ).toEqual([])
    expect(run(detector, 1000, { level: () => -5 }, 1000 + STEP)).toEqual([])
  })
})

describe('TurnDetector: лимит реплики', () => {
  it('на пятой минуте реплика закрывается сама, вместе с буфером начала ровно 300 с', () => {
    const detector = new TurnDetector()
    const heard = run(detector, MAX_TURN_MS + 5000, { level: speech(0, MAX_TURN_MS + 5000) })
    const start = heard.find((h) => h.event.type === 'start')!
    const end = heard.find((h) => h.event.type === 'end')!
    expect(end.event).toEqual({ type: 'end', reason: 'limit' })
    const sent = end.at - start.at + PRE_ROLL_MS
    expect(sent).toBeLessThanOrEqual(MAX_TURN_MS)
    expect(sent).toBeGreaterThan(MAX_TURN_MS - 2 * STEP)
  })

  it('после принудительного конца следующая реплика начинается заново', () => {
    const detector = new TurnDetector({ maxTurnMs: 2000 })
    const heard = run(detector, 5000, { level: speech(0, 5000) })
    expect(types(heard).slice(0, 3)).toEqual(['start', 'end', 'start'])
    expect(heard[1]!.event).toEqual({ type: 'end', reason: 'limit' })
  })
})

describe('TurnDetector: перебивание голосом', () => {
  const agentTalks = { agentSpeaking: () => true, agentLevel: () => 0.5, busy: () => true }

  it('речь поверх агента перебивает его не позже 300 мс', () => {
    const detector = new TurnDetector()
    const heard = run(detector, 3000, { ...agentTalks, level: (t) => (t >= 1000 ? 0.7 : 0.05) })
    expect(heard[0]!.event).toEqual({ type: 'start', bargeIn: true })
    expect(heard[0]!.at - 1000).toBeLessThanOrEqual(300)
  })

  it('эхо агента в динамике не перебивает его сам себя', () => {
    const detector = new TurnDetector()
    // The microphone hears the agent at a third of what is played: louder than the room, quieter than a person.
    const playback = (t: number) => 0.45 + 0.25 * Math.sin(t / 40)
    const heard = run(detector, 20_000, {
      ...agentTalks,
      agentLevel: playback,
      level: (t) => playback(t - 60) * 0.35,
    })
    expect(heard).toEqual([])
  })

  it('пока агент говорит, порог выше, и ещё немного после', () => {
    const detector = new TurnDetector()
    run(detector, 2000, { level: () => QUIET })
    const quietThreshold = detector.threshold(2000)
    run(detector, 300, { ...agentTalks, level: () => QUIET }, 2000 + STEP)
    expect(detector.threshold(2300)).toBeGreaterThan(quietThreshold * 1.5)
    run(detector, 600, { level: () => QUIET }, 2300 + STEP)
    expect(detector.threshold(2900)).toBeCloseTo(quietThreshold, 2)
  })
})

describe('TurnDetector: пауза на размышление', () => {
  it('человек, которого оборвали, получает паузу длиннее, но не больше предела', () => {
    const detector = new TurnDetector()
    const before = detector.endSilenceMs
    // Speaks, stops for 1.2 s (the turn closes at 0.9 s), goes on: cut mid-thought.
    const thinking = (t: number) => Math.max(speech(0, 2000)(t), speech(3200, 5000)(t))
    expect(types(run(detector, 7000, { level: thinking }))).toEqual(['start', 'end', 'start', 'end'])
    expect(detector.endSilenceMs).toBeGreaterThan(before)

    for (let i = 0; i < 20; i++) {
      const from = 7000 + STEP + i * 6000
      const resume = from + 1500 + detector.endSilenceMs + 200
      const again = (t: number) => Math.max(speech(from, from + 1500)(t), speech(resume, resume + 2000)(t))
      run(detector, 5900, { level: again }, from)
    }
    expect(detector.endSilenceMs).toBeLessThanOrEqual(TURN_DEFAULTS.maxEndSilenceMs)
  })

  it('с выросшей паузой 1,5 с посреди фразы реплику не обрывают', () => {
    const detector = new TurnDetector({ endSilenceMs: 1800 })
    const pause = (t: number) => Math.max(speech(0, 2000)(t), speech(3500, 5000)(t))
    expect(types(run(detector, 8000, { level: pause }))).toEqual(['start', 'end'])
  })
})

describe('TurnDetector: тишина без реплики', () => {
  it('через две минуты тишины просит паузу, один раз', () => {
    const detector = new TurnDetector()
    const heard = run(detector, 130_000, { level: () => QUIET })
    expect(types(heard)).toEqual(['idle'])
    expect(heard[0]!.at).toBeGreaterThanOrEqual(TURN_DEFAULTS.idleMs)
  })

  it('пока агент думает или говорит, тишина не считается', () => {
    const detector = new TurnDetector()
    expect(run(detector, 130_000, { level: () => QUIET, busy: () => true })).toEqual([])
    // From the moment it stops, the two minutes start over.
    const heard = run(detector, 125_000, { level: () => QUIET }, 130_000 + STEP)
    expect(heard[0]!.at - 130_000).toBeGreaterThanOrEqual(TURN_DEFAULTS.idleMs)
  })

  it('reset после паузы начинает отсчёт заново и забывает начатую реплику', () => {
    const detector = new TurnDetector()
    run(detector, 1000, { level: speech(0, 1000) })
    expect(detector.speaking).toBe(true)
    detector.reset(1000)
    expect(detector.speaking).toBe(false)
    expect(run(detector, 100_000, { level: () => QUIET }, 1000 + STEP)).toEqual([])
  })
})
