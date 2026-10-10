import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GREETING_ID,
  ReplyVoice,
  sentencesOf,
  unlockSpeech,
  type SpeechEngine,
  type SpeechUtterance,
} from '../src/voice/speech'

/** A synthesis engine the test drives by hand: nothing ends until the test says so. */
function fakeEngine(voices: Array<{ lang: string }> = [{ lang: 'ru-RU' }]) {
  const spoken: SpeechUtterance[] = []
  const engine: SpeechEngine & { cancels: number } = {
    cancels: 0,
    utterance: (text) => ({
      text,
      lang: '',
      rate: 1,
      voice: null,
      onend: null,
      onerror: null,
      onboundary: null,
    }),
    speak: (utterance) => void spoken.push(utterance),
    cancel() {
      engine.cancels += 1
    },
    voices: () => voices,
  }
  return { engine, spoken }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('sentencesOf', () => {
  it('режет по концам предложений и оставляет знаки', () => {
    expect(sentencesOf('Я рядом. С чего начнём? Расскажи!')).toEqual([
      'Я рядом.',
      'С чего начнём?',
      'Расскажи!',
    ])
  })

  it('текст без точки не рвёт, а очень длинное предложение режет по пробелу', () => {
    expect(sentencesOf('просто слова')).toEqual(['просто слова'])
    const long = 'слово '.repeat(80).trim()
    const chunks = sentencesOf(long)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((chunk) => chunk.length <= 220)).toBe(true)
    expect(chunks.join(' ')).toBe(long)
  })

  it('пустой текст — ничего', () => {
    expect(sentencesOf('  ')).toEqual([])
  })
})

describe('ReplyVoice.say', () => {
  it('читает предложения по-русски в спокойном темпе и завершается после последнего', async () => {
    const { engine, spoken } = fakeEngine()
    const voice = new ReplyVoice(engine)
    let done = false
    void voice.say('Я рядом. С чего начнём?').then(() => (done = true))

    expect(spoken.map((u) => u.text)).toEqual(['Я рядом.', 'С чего начнём?'])
    expect(spoken[0]).toMatchObject({ lang: 'ru-RU', rate: 0.95, voice: { lang: 'ru-RU' } })
    expect(voice.speaking).toBe(true)

    spoken[0]!.onend?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toBe(false)
    spoken[1]!.onend?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toBe(true)
    expect(voice.speaking).toBe(false)
  })

  it('движок, который не сообщает о конце, не держит разговор', async () => {
    const { engine } = fakeEngine()
    const voice = new ReplyVoice(engine)
    let done = false
    void voice.say('Привет.').then(() => (done = true))

    await vi.advanceTimersByTimeAsync(2000)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(done).toBe(true)
    expect(voice.speaking).toBe(false)
  })

  it('ошибка тоже конец: сбойный голос не стопорит ход', async () => {
    const { engine, spoken } = fakeEngine()
    const voice = new ReplyVoice(engine)
    let done = false
    void voice.say('Привет.').then(() => (done = true))
    spoken[0]!.onerror?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toBe(true)
  })

  it('без движка молчит и завершается сразу', async () => {
    const voice = new ReplyVoice(null)
    expect(voice.supported).toBe(false)
    await expect(voice.say('Привет.')).resolves.toBeUndefined()
    expect(voice.speaking).toBe(false)
  })
})

describe('ReplyVoice.cancel', () => {
  it('обрывает речь и отпускает ждущих начала речи агента', async () => {
    const { engine, spoken } = fakeEngine()
    const voice = new ReplyVoice(engine)
    let done = false
    void voice.say('Привет.').then(() => (done = true))
    const agentStarted = voice.agentStarts('m1')

    voice.cancel()
    await vi.advanceTimersByTimeAsync(5000)

    expect(done).toBe(true)
    await expect(agentStarted).resolves.toBe(false)
    expect(voice.speaking).toBe(false)
    expect(engine.cancels).toBeGreaterThan(0)
    expect(spoken.map((u) => u.text)).toEqual(['Привет.'])
  })

  it('поздний конец оборванной речи ничего не меняет', () => {
    const { engine, spoken } = fakeEngine()
    const voice = new ReplyVoice(engine)
    void voice.say('Раз. Два.')
    voice.cancel()
    void voice.say('Новое.')
    spoken[0]!.onend?.()
    expect(voice.speaking).toBe(true)
  })
})

describe('ReplyVoice.level', () => {
  it('движется со словами, пока говорит, и равна нулю в остальное время', async () => {
    const { engine, spoken } = fakeEngine()
    const voice = new ReplyVoice(engine)
    expect(voice.level()).toBe(0)

    void voice.say('Привет.')
    expect(voice.level()).toBeGreaterThan(0.3)
    // Слово зажигает шар, до следующего он затихает до ровного свечения.
    spoken[0]!.onboundary?.()
    const atWord = voice.level()
    await vi.advanceTimersByTimeAsync(400)
    const settled = voice.level()
    expect(atWord).toBeGreaterThan(settled)
    expect(settled).toBeCloseTo(0.3, 5)

    spoken[0]!.onend?.()
    expect(voice.level()).toBe(0)
  })
})

describe('unlockSpeech', () => {
  it('один раз произносит пустое слово, чтобы дальше речь пропускали', () => {
    const { engine, spoken } = fakeEngine()
    unlockSpeech(engine)
    unlockSpeech(engine)
    expect(spoken.map((u) => u.text)).toEqual([''])
  })
})

describe('ReplyVoice.greet', () => {
  /** A player that is "playing" until the test says it has drained. */
  function player() {
    let release = () => {}
    const waiting = new Promise<void>((resolve) => (release = resolve))
    return { drained: () => waiting, release }
  }

  it('если агент озвучил приветствие сам, свой голос молчит, а слово возвращается после конца речи и тишины в плеере', async () => {
    const { engine, spoken } = fakeEngine()
    const voice = new ReplyVoice(engine, 900)
    const audio = player()
    let done = false
    void voice.greet('Я рядом.', audio.drained).then(() => (done = true))

    await vi.advanceTimersByTimeAsync(300)
    voice.agentSpoke(GREETING_ID)
    await vi.advanceTimersByTimeAsync(2000)
    expect(done).toBe(false)

    voice.agentSpeechEnded(GREETING_ID)
    await vi.advanceTimersByTimeAsync(0)
    // The frames are all in, but the player is still playing them.
    expect(done).toBe(false)

    audio.release()
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toBe(true)
    expect(spoken).toHaveLength(0)
  })

  it('агент приветствие не озвучил: читает свой голос, и после него слово возвращается', async () => {
    const { engine, spoken } = fakeEngine()
    const voice = new ReplyVoice(engine, 900)
    let done = false
    void voice.greet('Я рядом. С чего начнём?').then(() => (done = true))

    await vi.advanceTimersByTimeAsync(900)
    expect(spoken.map((u) => u.text)).toEqual(['Я рядом.', 'С чего начнём?'])
    expect(done).toBe(false)

    spoken[0]!.onend?.()
    spoken[1]!.onend?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toBe(true)
  })

  it('агент начал с опозданием: свой голос смолкает, слово ждёт конца речи агента', async () => {
    const { engine, spoken } = fakeEngine()
    const voice = new ReplyVoice(engine, 900)
    const audio = player()
    let done = false
    void voice.greet('Я рядом.', audio.drained).then(() => (done = true))

    await vi.advanceTimersByTimeAsync(1000)
    expect(spoken).toHaveLength(1)
    expect(voice.speaking).toBe(true)

    voice.agentSpoke(GREETING_ID)
    expect(voice.speaking).toBe(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toBe(false)

    voice.agentSpeechEnded(GREETING_ID)
    audio.release()
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toBe(true)
  })

  it('без движка и без речи агента не задерживает: слово возвращается после ожидания агента', async () => {
    const voice = new ReplyVoice(null, 900)
    let done = false
    void voice.greet('Я рядом.').then(() => (done = true))
    await vi.advanceTimersByTimeAsync(900)
    expect(done).toBe(true)
  })

  it('человек ушёл (cancel): приветствие обрывается и не ждёт ни агента, ни плеера', async () => {
    const { engine } = fakeEngine()
    const voice = new ReplyVoice(engine, 900)
    const audio = player()
    let done = false
    void voice.greet('Я рядом.', audio.drained).then(() => (done = true))
    voice.agentSpoke(GREETING_ID)
    await vi.advanceTimersByTimeAsync(100)
    expect(done).toBe(false)

    voice.cancel()
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toBe(true)
  })

  it('речь агента, которая никогда не кончается, не держит микрофон вечно', async () => {
    const { engine } = fakeEngine()
    const voice = new ReplyVoice(engine, 900)
    let done = false
    void voice.greet('Я рядом.').then(() => (done = true))
    voice.agentSpoke(GREETING_ID)

    await vi.advanceTimersByTimeAsync(19_000)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(2000)
    expect(done).toBe(true)
  })
})
