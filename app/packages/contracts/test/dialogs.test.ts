/**
 * The codecs of the agent's speech travel as plain strings in `hello` and `tts_start`, and mobile builds
 * live for months: a name once shipped never changes meaning.
 */
import { describe, expect, it } from 'vitest'
import {
  AUDIO_TTS_SAMPLE_RATE,
  DialogClientFrame,
  DialogServerFrame,
  TTS_CODECS,
  TTS_OPUS_LENGTH_BYTES,
  TTS_OPUS_PACKET_MS,
  type DialogServerMessage,
  type HelloFrame,
} from '../src/api/dialogs'

describe('кодеки озвучки', () => {
  it('имена на проводе: opus, mulaw, pcm16; pcm16 — тот, что понимает любой клиент', () => {
    expect([...TTS_CODECS]).toEqual(['opus', 'mulaw', 'pcm16'])
  })

  it('hello без codecs остаётся верным кадром: так шлют сборки, вышедшие до кодеков', () => {
    const old: HelloFrame = { type: DialogClientFrame.Hello, token: 't', dialogId: 'd' }
    const fresh: HelloFrame = { ...old, codecs: ['opus', 'mulaw', 'pcm16'] }
    expect(old.codecs).toBeUndefined()
    expect(fresh.codecs).toEqual(['opus', 'mulaw', 'pcm16'])
  })

  it('tts_start называет кодек соединения', () => {
    const start: DialogServerMessage = {
      type: DialogServerFrame.TtsStart,
      messageId: 'm-1',
      codec: 'mulaw',
      sampleRate: AUDIO_TTS_SAMPLE_RATE,
    }
    expect(start).toMatchObject({ codec: 'mulaw', sampleRate: 24_000 })
  })

  it('пакет Opus — 20 мс, то есть 480 сэмплов при 24 кГц: в кадре 200 мс их не больше десяти', () => {
    expect((AUDIO_TTS_SAMPLE_RATE * TTS_OPUS_PACKET_MS) / 1000).toBe(480)
    expect(200 / TTS_OPUS_PACKET_MS).toBe(10)
    // uint16 holds any Opus packet: the format caps one at 1275 bytes.
    expect(2 ** (8 * TTS_OPUS_LENGTH_BYTES)).toBeGreaterThan(1275)
  })
})
