import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  DialogClientFrame,
  DialogCloseCode,
  DialogServerFrame,
  type TtsCodec,
} from '@ryadom/contracts/api/dialogs'
import {
  DialogSocket,
  type DialogMessageView,
  type DialogSocketDeps,
  type DialogSocketHandlers,
  type DialogSocketState,
} from '../src/dialog-socket'
import type { PcmChunk } from '../src/voice/tts-decoder'
import { makeToken } from './helpers'

class FakeWebSocket {
  static readonly OPEN = 1
  static instances: FakeWebSocket[] = []

  readyState = 0
  binaryType = ''
  sent: Record<string, unknown>[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  onerror: (() => void) | null = null

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }

  send(data: unknown): void {
    if (typeof data === 'string') this.sent.push(JSON.parse(data) as Record<string, unknown>)
  }

  close(): void {
    this.readyState = 3
    this.onclose?.({ code: 1005 })
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }

  receive(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify({ v: 1, ...frame }) })
  }

  drop(code = 1006): void {
    this.readyState = 3
    this.onclose?.({ code })
  }

  framesOf(type: string): Record<string, unknown>[] {
    return this.sent.filter((frame) => frame.type === type)
  }
}

const last = (): FakeWebSocket => FakeWebSocket.instances.at(-1)!

interface Harness {
  socket: DialogSocket
  deps: DialogSocketDeps & { token: string | null; refreshSession: Mock<() => Promise<boolean>> }
  states: DialogSocketState[]
  feed(): DialogMessageView[]
  heard: { text: string; final: boolean }[]
  audio: PcmChunk[]
  speech: { messageId: string; phase: 'start' | 'end' }[]
  safety: unknown[]
}

function harness(
  options: {
    greeting?: string | null
    loadHistory?: DialogSocketDeps['loadHistory']
    random?: () => number
    ttsCodecs?: () => Promise<TtsCodec[]>
  } = {},
): Harness {
  const states: DialogSocketState[] = []
  let messages: DialogMessageView[] = []
  const heard: Harness['heard'] = []
  const audio: PcmChunk[] = []
  const speech: Harness['speech'] = []
  const safety: unknown[] = []
  const deps = {
    token: makeToken('a') as string | null,
    getAccessToken() {
      return deps.token
    },
    refreshSession: vi.fn(async () => {
      deps.token = makeToken('a', 900)
      return true
    }),
    wsBase: () => 'ws://api.test',
    loadHistory: options.loadHistory,
    // The middle of the spread: the delays of the schedule come out exactly.
    random: options.random ?? (() => 0.5),
    ttsCodecs: options.ttsCodecs,
  }
  const handlers: DialogSocketHandlers = {
    onState: (state) => states.push(state),
    onMessages: (next) => (messages = next),
    onSafety: (...args) => safety.push(args),
    onEnded: () => undefined,
    onError: () => undefined,
    onTranscript: (text, final) => heard.push({ text, final }),
    onAudio: (frame) => audio.push(frame),
    onSpeech: (messageId, phase) => speech.push({ messageId, phase }),
  }
  const socket = new DialogSocket(deps, 'dialog-1', handlers, options.greeting)
  return { socket, deps, states, feed: () => messages, heard, audio, speech, safety }
}

/** Opens the connection and lets `hello` go out (it waits on a microtask when the token needs refreshing). */
async function connect(h: Harness, ready = true): Promise<FakeWebSocket> {
  h.socket.connect()
  const ws = last()
  ws.open()
  await vi.advanceTimersByTimeAsync(0)
  if (ready)
    ws.receive({
      type: DialogServerFrame.Ready,
      dialogId: 'dialog-1',
      greeting: null,
      sinceLastDialogHours: null,
    })
  await vi.advanceTimersByTimeAsync(0)
  return ws
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeWebSocket.instances = []
  vi.stubGlobal('WebSocket', FakeWebSocket)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('hello и токен', () => {
  it('просроченный токен обновляется до hello, а не уходит на шлюз', async () => {
    const h = harness()
    h.deps.token = makeToken('a', -60)
    const ws = await connect(h, false)

    expect(h.deps.refreshSession).toHaveBeenCalledOnce()
    const [hello] = ws.framesOf(DialogClientFrame.Hello)
    expect(hello?.token).toBe(h.deps.token)
  })

  it('токен, которому осталось несколько секунд, тоже обновляется', async () => {
    const h = harness()
    h.deps.token = makeToken('a', 5)
    await connect(h, false)
    expect(h.deps.refreshSession).toHaveBeenCalledOnce()
  })

  it('hello называет кодеки озвучки, которые устройство умеет декодировать', async () => {
    const h = harness({ ttsCodecs: async () => ['opus', 'mulaw', 'pcm16'] })
    const ws = await connect(h, false)
    expect(ws.framesOf(DialogClientFrame.Hello)[0]?.codecs).toEqual(['opus', 'mulaw', 'pcm16'])
  })

  it('без сведений о кодеках hello уходит без них: шлюз отдаст PCM16, как старым сборкам', async () => {
    const h = harness()
    const ws = await connect(h, false)
    expect(ws.framesOf(DialogClientFrame.Hello)[0]).not.toHaveProperty('codecs')

    // A probe that failed is the same as none.
    const failed = harness({ ttsCodecs: () => Promise.reject(new Error('no WebAssembly')) })
    const second = await connect(failed, false)
    expect(second.framesOf(DialogClientFrame.Hello)[0]).not.toHaveProperty('codecs')
  })

  it('живой токен уходит как есть, без лишнего refresh', async () => {
    const h = harness()
    const ws = await connect(h, false)
    expect(h.deps.refreshSession).not.toHaveBeenCalled()
    expect(ws.framesOf(DialogClientFrame.Hello)).toHaveLength(1)
  })

  it('переподключение после долгого разговора: токен успел истечь — шлёт свежий', async () => {
    const h = harness()
    const first = await connect(h)
    h.deps.token = makeToken('a', -1)

    first.drop(1006)
    await vi.advanceTimersByTimeAsync(1000)
    const second = last()
    expect(second).not.toBe(first)
    second.open()
    await vi.advanceTimersByTimeAsync(0)

    expect(h.deps.refreshSession).toHaveBeenCalledOnce()
    expect(second.framesOf(DialogClientFrame.Hello)[0]?.token).toBe(h.deps.token)
  })

  it('refresh не дал токен: соединение закрывается и идёт обычный повтор, а не конец', async () => {
    const h = harness()
    h.deps.token = null
    h.deps.refreshSession.mockResolvedValue(false)
    await connect(h, false)

    expect(h.states.at(-1)).toBe('reconnecting')
    expect(h.states).not.toContain('failed')
  })

  it('4001: один раз обновляет токен и подключается снова; второй 4001 — конец', async () => {
    const h = harness()
    const first = await connect(h)

    first.drop(DialogCloseCode.Unauthorized)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.deps.refreshSession).toHaveBeenCalledOnce()
    expect(h.states.at(-1)).toBe('reconnecting')

    const second = last()
    expect(second).not.toBe(first)
    second.open()
    await vi.advanceTimersByTimeAsync(0)
    second.drop(DialogCloseCode.Unauthorized)
    await vi.advanceTimersByTimeAsync(0)

    expect(h.states.at(-1)).toBe('failed')
    expect(FakeWebSocket.instances).toHaveLength(2)
  })

  it('4009 (вытеснено другим подключением) — конец без повторов', async () => {
    const h = harness()
    const ws = await connect(h)
    ws.drop(DialogCloseCode.Superseded)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.states.at(-1)).toBe('failed')
    expect(FakeWebSocket.instances).toHaveLength(1)
  })
})

describe('разброс переподключений', () => {
  /** After a drop, how long until the socket is opened again. */
  async function delayAfterDrop(random: () => number): Promise<number> {
    FakeWebSocket.instances = []
    const h = harness({ random })
    const ws = await connect(h)
    ws.drop(1006)
    for (let waited = 0; waited < 3000; waited += 10) {
      if (FakeWebSocket.instances.length > 1) return waited
      await vi.advanceTimersByTimeAsync(10)
    }
    return Infinity
  }

  it('первая пауза — от половины до полутора секунд, а не ровно секунда у всех', async () => {
    // A pod that dies takes thousands of clients down at the same instant: with one delay for all of them,
    // all of them come back in the same second.
    expect(await delayAfterDrop(() => 0)).toBeGreaterThanOrEqual(490)
    expect(await delayAfterDrop(() => 0)).toBeLessThanOrEqual(510)
    expect(await delayAfterDrop(() => 0.5)).toBeGreaterThanOrEqual(990)
    expect(await delayAfterDrop(() => 0.5)).toBeLessThanOrEqual(1010)
    expect(await delayAfterDrop(() => 0.999)).toBeGreaterThanOrEqual(1490)
    expect(await delayAfterDrop(() => 0.999)).toBeLessThanOrEqual(1510)
  })

  it('без подмены random берётся Math.random', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0)
    const h = harness({ random: undefined })
    // The harness always sets `random`; here the socket is built without it.
    const deps = { ...h.deps, random: undefined }
    const socket = new DialogSocket(deps, 'dialog-2', {
      onState: () => undefined,
      onMessages: () => undefined,
      onSafety: () => undefined,
      onEnded: () => undefined,
      onError: () => undefined,
    })
    FakeWebSocket.instances = []
    socket.connect()
    const ws = last()
    ws.open()
    await vi.advanceTimersByTimeAsync(0)
    ws.receive({ type: DialogServerFrame.Ready, dialogId: 'dialog-2', greeting: null, sinceLastDialogHours: null })
    await vi.advanceTimersByTimeAsync(0)
    ws.drop(1006)
    await vi.advanceTimersByTimeAsync(499)
    expect(FakeWebSocket.instances).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(2)
    expect(FakeWebSocket.instances).toHaveLength(2)
    random.mockRestore()
  })
})

describe('сообщения человека', () => {
  it('отправленное, но не подтверждённое сообщение повторяется после переподключения', async () => {
    const h = harness()
    const first = await connect(h)
    h.socket.sendMessage('привет')
    const [sent] = first.framesOf(DialogClientFrame.Message)
    expect(sent?.text).toBe('привет')
    expect(h.feed()[0]).toMatchObject({ text: 'привет', pending: true })

    // The connection died without anyone noticing: no ack, then the close.
    first.drop(1006)
    await vi.advanceTimersByTimeAsync(1000)
    const second = await (async () => {
      const ws = last()
      ws.open()
      await vi.advanceTimersByTimeAsync(0)
      ws.receive({
        type: DialogServerFrame.Ready,
        dialogId: 'dialog-1',
        greeting: null,
        sinceLastDialogHours: null,
      })
      await vi.advanceTimersByTimeAsync(0)
      return ws
    })()

    const [again] = second.framesOf(DialogClientFrame.Message)
    expect(again).toMatchObject({ clientId: sent?.clientId, text: 'привет' })
  })

  it('сообщение, написанное при разрыве, уходит после ready один раз', async () => {
    const h = harness()
    h.socket.sendMessage('пока нет связи')
    const ws = await connect(h)
    expect(ws.framesOf(DialogClientFrame.Message)).toHaveLength(1)

    h.socket.sendMessage('ещё одно')
    expect(ws.framesOf(DialogClientFrame.Message)).toHaveLength(2)
  })

  it('ack снимает pending и подменяет id; повтор не отправляется после следующего ready', async () => {
    const h = harness()
    const first = await connect(h)
    h.socket.sendMessage('привет')
    const clientId = first.framesOf(DialogClientFrame.Message)[0]!.clientId as string
    first.receive({ type: DialogServerFrame.Ack, clientId, messageId: 'srv-1' })
    expect(h.feed()[0]).toMatchObject({ id: 'srv-1', pending: false })

    first.drop(1006)
    await vi.advanceTimersByTimeAsync(1000)
    const second = last()
    second.open()
    await vi.advanceTimersByTimeAsync(0)
    second.receive({
      type: DialogServerFrame.Ready,
      dialogId: 'dialog-1',
      greeting: null,
      sinceLastDialogHours: null,
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(second.framesOf(DialogClientFrame.Message)).toHaveLength(0)
    expect(second.framesOf(DialogClientFrame.Hello)[0]?.lastMessageId).toBe('srv-1')
  })

  it('ack на уже имеющийся id убирает локальную копию, а не дублирует', async () => {
    const h = harness()
    const ws = await connect(h)
    h.socket.setHistory([{ id: 'srv-1', role: 'user', text: 'привет' }])
    h.socket.sendMessage('привет')
    const clientId = ws.framesOf(DialogClientFrame.Message)[0]!.clientId as string
    ws.receive({ type: DialogServerFrame.Ack, clientId, messageId: 'srv-1' })

    expect(h.feed().map((message) => message.id)).toEqual(['srv-1'])
  })
})

describe('ответ, оборванный переподключением', () => {
  it('повтор assistant_start с тем же id начинает ответ заново на месте', async () => {
    const h = harness()
    const first = await connect(h)
    first.receive({ type: DialogServerFrame.AssistantStart, messageId: 'm1' })
    first.receive({ type: DialogServerFrame.AssistantDelta, messageId: 'm1', text: 'Я слы' })
    first.drop(1006)
    // The cut-off reply no longer shows a caret.
    expect(h.feed()).toEqual([{ id: 'm1', role: 'assistant', text: 'Я слы', streaming: false }])

    await vi.advanceTimersByTimeAsync(1000)
    const second = await (async () => {
      const ws = last()
      ws.open()
      await vi.advanceTimersByTimeAsync(0)
      ws.receive({
        type: DialogServerFrame.Ready,
        dialogId: 'dialog-1',
        greeting: null,
        sinceLastDialogHours: null,
      })
      return ws
    })()
    second.receive({ type: DialogServerFrame.AssistantStart, messageId: 'm1' })
    second.receive({ type: DialogServerFrame.AssistantDelta, messageId: 'm1', text: 'Я слышу тебя' })
    expect(h.feed()).toEqual([{ id: 'm1', role: 'assistant', text: 'Я слышу тебя', streaming: true }])

    second.receive({ type: DialogServerFrame.AssistantEnd, messageId: 'm1', text: 'Я слышу тебя.' })
    expect(h.feed()).toEqual([{ id: 'm1', role: 'assistant', text: 'Я слышу тебя.' }])
  })

  it('агент не умеет повторять: после reconnect лента сверяется с REST', async () => {
    const history: DialogMessageView[] = [
      { id: 'u1', role: 'user', text: 'привет' },
      { id: 'm1', role: 'assistant', text: 'Я слышу тебя.' },
      { id: 'm2', role: 'assistant', text: 'Расскажи, что случилось.' },
    ]
    const loadHistory = vi.fn(async () => history)
    const h = harness({ loadHistory })
    const first = await connect(h)
    first.receive({ type: DialogServerFrame.Ack, clientId: 'x', messageId: 'u1' })
    first.receive({ type: DialogServerFrame.AssistantStart, messageId: 'm1' })
    first.receive({ type: DialogServerFrame.AssistantDelta, messageId: 'm1', text: 'Я слы' })
    first.drop(1006)

    await vi.advanceTimersByTimeAsync(1000)
    const second = last()
    second.open()
    await vi.advanceTimersByTimeAsync(0)
    second.receive({
      type: DialogServerFrame.Ready,
      dialogId: 'dialog-1',
      greeting: null,
      sinceLastDialogHours: null,
    })
    await vi.advanceTimersByTimeAsync(0)

    expect(loadHistory).toHaveBeenCalledOnce()
    expect(h.feed()).toEqual(history)
  })

  it('приветствие остаётся первым, если REST его не хранит, и не задваивается, если хранит', async () => {
    const stored: DialogMessageView[] = [{ id: 'u1', role: 'user', text: 'привет' }]
    let history = stored
    const h = harness({ greeting: 'Я рядом', loadHistory: vi.fn(async () => history) })
    const first = await connect(h)
    first.drop(1006)
    await vi.advanceTimersByTimeAsync(1000)
    let next = last()
    next.open()
    await vi.advanceTimersByTimeAsync(0)
    next.receive({
      type: DialogServerFrame.Ready,
      dialogId: 'dialog-1',
      greeting: null,
      sinceLastDialogHours: null,
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.feed().map((message) => message.text)).toEqual(['Я рядом', 'привет'])

    history = [{ id: 'g1', role: 'assistant', text: 'Я рядом' }, ...stored]
    next.drop(1006)
    await vi.advanceTimersByTimeAsync(1000)
    next = last()
    next.open()
    await vi.advanceTimersByTimeAsync(0)
    next.receive({
      type: DialogServerFrame.Ready,
      dialogId: 'dialog-1',
      greeting: null,
      sinceLastDialogHours: null,
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.feed().map((message) => message.text)).toEqual(['Я рядом', 'привет'])
  })

  it('первое подключение REST не читает', async () => {
    const loadHistory = vi.fn(async () => [])
    const h = harness({ loadHistory })
    await connect(h)
    expect(loadHistory).not.toHaveBeenCalled()
  })

  it('недошедшее сообщение осталось на ленте, а дошедшее без ack не задваивается', async () => {
    const loadHistory = vi.fn(async (): Promise<DialogMessageView[]> => [
      { id: 'srv-1', role: 'user', text: 'дошло' },
    ])
    const h = harness({ loadHistory })
    const first = await connect(h)
    h.socket.sendMessage('дошло')
    h.socket.sendMessage('потерялось')
    first.drop(1006)

    await vi.advanceTimersByTimeAsync(1000)
    const second = last()
    second.open()
    await vi.advanceTimersByTimeAsync(0)
    second.receive({
      type: DialogServerFrame.Ready,
      dialogId: 'dialog-1',
      greeting: null,
      sinceLastDialogHours: null,
    })
    await vi.advanceTimersByTimeAsync(0)

    expect(h.feed().map((message) => [message.id === 'srv-1' ? 'srv-1' : 'local', message.text])).toEqual([
      ['srv-1', 'дошло'],
      ['local', 'потерялось'],
    ])
    // Only the message the server lacks goes out again.
    expect(second.framesOf(DialogClientFrame.Message).map((frame) => frame.text)).toEqual(['потерялось'])
  })

  it('REST недоступен: лента остаётся, недоставленное повторяется', async () => {
    const h = harness({ loadHistory: vi.fn(async () => null) })
    const first = await connect(h)
    h.socket.sendMessage('привет')
    first.drop(1006)
    await vi.advanceTimersByTimeAsync(1000)
    const second = last()
    second.open()
    await vi.advanceTimersByTimeAsync(0)
    second.receive({
      type: DialogServerFrame.Ready,
      dialogId: 'dialog-1',
      greeting: null,
      sinceLastDialogHours: null,
    })
    await vi.advanceTimersByTimeAsync(0)

    expect(h.feed()).toHaveLength(1)
    expect(second.framesOf(DialogClientFrame.Message)).toHaveLength(1)
  })
})

describe('голос', () => {
  it('финальная расшифровка становится сообщением человека, промежуточная — только подписью', async () => {
    const h = harness()
    const ws = await connect(h)

    ws.receive({ type: DialogServerFrame.Transcript, text: 'мне тяж', final: false })
    expect(h.heard).toEqual([{ text: 'мне тяж', final: false }])
    expect(h.feed()).toEqual([])

    ws.receive({ type: DialogServerFrame.Transcript, text: 'мне тяжело', final: true, messageId: 'v1' })
    ws.receive({ type: DialogServerFrame.Ack, clientId: 'v1', messageId: 'v1' })
    expect(h.heard.at(-1)).toEqual({ text: 'мне тяжело', final: true })
    expect(h.feed()).toEqual([{ id: 'v1', role: 'user', text: 'мне тяжело', pending: false }])

    // A replay of the same turn does not add a second bubble.
    ws.receive({ type: DialogServerFrame.Transcript, text: 'мне тяжело', final: true, messageId: 'v1' })
    expect(h.feed()).toHaveLength(1)
  })

  it('пустая расшифровка в ленту не попадает', async () => {
    const h = harness()
    const ws = await connect(h)
    ws.receive({ type: DialogServerFrame.Transcript, text: '  ', final: true, messageId: 'v1' })
    expect(h.feed()).toEqual([])
  })

  it('бинарные кадры озвучки уходят плееру сэмплами, текстовые — нет', async () => {
    const h = harness()
    const ws = await connect(h)
    // One PCM16 sample, 0x0201, right after the five bytes of the header.
    ws.onmessage?.({ data: new Uint8Array([2, 0, 0, 0, 0, 1, 2]).buffer })
    expect(h.audio).toEqual([{ samples: Float32Array.of(0x0201 / 0x8000), sampleRate: 24_000 }])
  })

  it('кадры декодируются кодеком из tts_start: μ-law по байту на сэмпл', async () => {
    const h = harness()
    const ws = await connect(h)
    ws.receive({ type: DialogServerFrame.TtsStart, messageId: 'm1', codec: 'mulaw', sampleRate: 24000 })
    // μ-law 0xFF is silence, 0x80 the loudest positive sample.
    ws.onmessage?.({ data: new Uint8Array([2, 0, 0, 0, 0, 0xff, 0x80]).buffer })
    expect(h.audio).toHaveLength(1)
    expect([...h.audio[0]!.samples]).toEqual([0, 32124 / 0x8000])
  })

  it('после перебивания кадры, что ещё летят, не декодируются — до следующего tts_start', async () => {
    const h = harness()
    const ws = await connect(h)
    const frame = () => new Uint8Array([2, 0, 0, 0, 0, 1, 2]).buffer
    ws.receive({ type: DialogServerFrame.TtsStart, messageId: 'm1', codec: 'pcm16', sampleRate: 24000 })
    ws.onmessage?.({ data: frame() })
    h.socket.interruptSpeech()
    ws.onmessage?.({ data: frame() })
    expect(h.audio).toHaveLength(1)

    ws.receive({ type: DialogServerFrame.TtsEnd, messageId: 'm1' })
    ws.receive({ type: DialogServerFrame.TtsStart, messageId: 'm2', codec: 'pcm16', sampleRate: 24000 })
    ws.onmessage?.({ data: frame() })
    expect(h.audio).toHaveLength(2)
  })

  it('начало и конец речи агента сообщаются экрану: пока агент говорит, свой голос и микрофон ждут', async () => {
    const h = harness()
    const ws = await connect(h)

    ws.receive({ type: DialogServerFrame.TtsStart, messageId: 'greeting', codec: 'pcm16', sampleRate: 24000 })
    ws.receive({ type: DialogServerFrame.TtsEnd, messageId: 'greeting' })

    expect(h.speech).toEqual([
      { messageId: 'greeting', phase: 'start' },
      { messageId: 'greeting', phase: 'end' },
    ])
  })

  it('перебивание отменяет озвучку, которая ещё идёт, и только её', async () => {
    const h = harness()
    const ws = await connect(h)

    h.socket.interruptSpeech()
    expect(ws.framesOf(DialogClientFrame.TtsCancel)).toHaveLength(0)

    ws.receive({ type: DialogServerFrame.TtsStart, messageId: 'm1', codec: 'pcm16', sampleRate: 24000 })
    h.socket.interruptSpeech()
    expect(ws.framesOf(DialogClientFrame.TtsCancel)).toEqual([expect.objectContaining({ messageId: 'm1' })])

    ws.receive({ type: DialogServerFrame.TtsStart, messageId: 'm2', codec: 'pcm16', sampleRate: 24000 })
    ws.receive({ type: DialogServerFrame.TtsEnd, messageId: 'm2' })
    h.socket.interruptSpeech()
    expect(ws.framesOf(DialogClientFrame.TtsCancel)).toHaveLength(1)
  })

  it('isConnected: только в ready и streaming', async () => {
    const h = harness()
    expect(h.socket.isConnected()).toBe(false)
    const ws = await connect(h)
    expect(h.socket.isConnected()).toBe(true)
    ws.drop(1006)
    expect(h.socket.isConnected()).toBe(false)
  })
})
