import {
  DIALOG_PROTOCOL_VERSION,
  DialogClientFrame,
  DialogCloseCode,
  DialogServerFrame,
  type DialogServerMessage,
  type DialogSummaryApiResponse,
  type DialogWsErrorCode,
  type HotlineApiResponse,
  type SafetyLevel,
  type TtsCodec,
} from '@ryadom/contracts/api/dialogs'
import { ApiPath } from '@ryadom/contracts/api/paths'
import { isTokenValid } from './jwt'
import { TtsReceiver, type DecoderFactory, type PcmChunk } from './voice/tts-decoder'

/**
 * The client side of the dialog connection. States and reconnects live here; the
 * screen only renders messages and sends the person's replies.
 *
 * The token goes in the first `hello` frame rather than in the URL, where it would land in the
 * Ingress logs.
 */

export type DialogSocketState = 'connecting' | 'ready' | 'streaming' | 'reconnecting' | 'ended' | 'failed'

export interface DialogMessageView {
  id: string
  role: 'user' | 'assistant'
  text: string
  /** The reply is still being written: show the caret and block sending the next one. */
  streaming?: boolean
  /** The message was sent but the server has not acknowledged it yet. */
  pending?: boolean
}

/** What the socket needs from the client: the token, a way to refresh it, and where to connect. */
export interface DialogSocketDeps {
  getAccessToken(): string | null
  refreshSession(): Promise<boolean>
  /** `ws(s)://host` with no trailing slash. */
  wsBase(): string
  /**
   * The dialog as REST has it, null when it cannot be read. Used after a drop: an agent that cannot
   * replay the frames the person missed leaves the feed incomplete otherwise.
   */
  loadHistory?(): Promise<DialogMessageView[] | null>
  /** 0..1, for the spread of reconnects; tests fix it. */
  random?(): number
  /**
   * The codecs of the agent's speech this device can decode, most wanted first, for `hello`
   * (`supportedTtsCodecs`). Without it the gateway sends PCM16.
   */
  ttsCodecs?(): Promise<TtsCodec[]>
  /** Tests swap the decoders of the agent's speech for their own. */
  ttsDecoders?: DecoderFactory
}

export interface DialogSocketHandlers {
  onState(state: DialogSocketState): void
  onMessages(messages: DialogMessageView[]): void
  onSafety(level: SafetyLevel, text: string | null, hotlines: HotlineApiResponse[]): void
  onEnded(summary: DialogSummaryApiResponse | null): void
  onError(code: DialogWsErrorCode, message: string): void
  /** What the recognition heard: partial text while talking, the final one at the end (it also joins the feed). */
  onTranscript?(text: string, final: boolean): void
  /** The agent's voice, decoded from the connection's codec, for the player; in the order it was spoken. */
  onAudio?(chunk: PcmChunk): void
  /**
   * The agent's own speech for a message begins (`tts_start`) or ends (`tts_end`). While it speaks, the
   * screen's own voice stays out of it, and the microphone waits for the end.
   */
  onSpeech?(messageId: string, phase: 'start' | 'end'): void
}

const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 8000]

/** A token this close to its end counts as expired: it must still be valid when the gateway checks it. */
const TOKEN_MARGIN_MS = 30_000

/** The greeting is not a server message; it only needs an id so it cannot be duplicated. */
const GREETING_ID = 'greeting'

export class DialogSocket {
  private socket: WebSocket | null = null
  private state: DialogSocketState = 'connecting'
  private messages: DialogMessageView[] = []
  private attempt = 0
  private lastMessageId: string | undefined
  private closedByUs = false
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  /** Whether a `ready` ever came: from then on every connect is a reconnect. */
  private everReady = false
  /** One forced token refresh per run of failures, when the gateway refuses a token that looked alive. */
  private authRetried = false
  /** Client ids already put on the current connection, so a resend does not repeat them. */
  private sentOnConnection = new Set<string>()
  /** The agent's reply being spoken: it can be cancelled while the frames still flow. */
  private speakingId: string | null = null
  /** The agent's speech frames to samples, one decoder per speech. */
  private readonly tts: TtsReceiver
  /** What `hello` will name as decodable; found out while the socket opens. */
  private codecs: Promise<TtsCodec[] | null> | null = null

  constructor(
    private readonly deps: DialogSocketDeps,
    private readonly dialogId: string,
    private readonly handlers: DialogSocketHandlers,
    /**
     * The greeting received when the dialog started. It lives in this same list because the screen
     * renders only what comes from `onMessages`, and a separate element of its own would be lost on
     * the very first reply.
     */
    greeting?: string | null,
  ) {
    if (greeting) this.messages = [{ id: GREETING_ID, role: 'assistant', text: greeting }]
    this.tts = new TtsReceiver((chunk) => this.handlers.onAudio?.(chunk), deps.ttsDecoders)
  }

  getState(): DialogSocketState {
    return this.state
  }

  /** Whether frames can go out right now. */
  isConnected(): boolean {
    return this.state === 'ready' || this.state === 'streaming'
  }

  private setState(state: DialogSocketState): void {
    this.state = state
    this.handlers.onState(state)
  }

  private emitMessages(): void {
    this.handlers.onMessages([...this.messages])
  }

  connect(): void {
    this.closedByUs = false
    this.sentOnConnection = new Set()
    this.setState(this.everReady || this.attempt > 0 ? 'reconnecting' : 'connecting')
    // The greeting from the dialog start: the socket does not open instantly and the screen must
    // not be empty. Without this nothing would show it, since the list reaches the screen only
    // with server frames.
    if (this.messages.length > 0) this.emitMessages()
    // Whether the device decodes Opus may take a moment to find out: it runs while the socket opens.
    this.codecs = this.deps.ttsCodecs?.().catch(() => null) ?? null
    const socket = new WebSocket(`${this.deps.wsBase()}${ApiPath.DialogsWs}`)
    this.socket = socket

    socket.binaryType = 'arraybuffer'
    socket.onopen = () => void this.sendHello(socket)
    socket.onmessage = (event) => {
      if (this.socket === socket) this.onFrame(event, socket)
    }
    socket.onclose = (event) => {
      if (this.socket === socket) this.onClose(event)
    }
    socket.onerror = () => {
      // The browser gives no details; the close event follows and decides whether to reconnect.
    }
  }

  private usableToken(): string | null {
    const token = this.deps.getAccessToken()
    return token && isTokenValid(token, TOKEN_MARGIN_MS) ? token : null
  }

  private async sendHello(socket: WebSocket): Promise<void> {
    let token = this.usableToken()
    // The access token lives 15 minutes and nothing renews it during a dialog. The gateway answers
    // an expired one with a close that is final for us, so refresh first.
    if (!token) {
      await this.deps.refreshSession()
      // The person left, or another connection took over, while the refresh was in flight.
      if (this.socket !== socket) return
      token = this.usableToken()
    }
    if (!token) {
      // Still no token: the network, the server, or the session is over (then the app is leaving).
      // Retried like any drop; the attempts end in `failed`.
      socket.close()
      return
    }
    const codecs = this.codecs ? await this.codecs : null
    if (this.socket !== socket) return
    this.send({
      type: DialogClientFrame.Hello,
      token,
      dialogId: this.dialogId,
      ...(this.lastMessageId ? { lastMessageId: this.lastMessageId } : {}),
      ...(codecs ? { codecs } : {}),
    })
  }

  /** Whether the frame actually went out: a socket that is not open takes nothing. */
  private send(frame: Record<string, unknown>): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false
    this.socket.send(JSON.stringify({ v: DIALOG_PROTOCOL_VERSION, ...frame }))
    return true
  }

  /** A binary audio frame, sent as is. */
  sendAudio(frame: ArrayBuffer): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return
    this.socket.send(frame)
  }

  startAudio(sampleRate: number): void {
    this.send({ type: DialogClientFrame.AudioStart, codec: 'pcm16', sampleRate, channels: 1 })
  }

  endAudio(): void {
    this.send({ type: DialogClientFrame.AudioEnd })
  }

  cancelTts(messageId: string): void {
    this.send({ type: DialogClientFrame.TtsCancel, messageId })
  }

  /** The person started talking over the agent: stop its speech on the server side too. */
  interruptSpeech(): void {
    // What is still being decoded, and the frames still on their way, are speech nobody wants.
    this.tts.cancel()
    if (!this.speakingId) return
    this.cancelTts(this.speakingId)
    this.speakingId = null
  }

  /**
   * The person's message. It stays `pending` until the server acknowledges it: while the socket is
   * closed, or open but dead without anyone noticing yet, it is sent again after the next `ready`.
   */
  sendMessage(text: string): void {
    const clientId = crypto.randomUUID()
    this.messages = [...this.messages, { id: clientId, role: 'user', text, pending: true }]
    this.emitMessages()
    if (this.isConnected()) this.sendPending()
  }

  end(
    takeaway: string | null,
    tensionAfter: number | null,
    /** `draft`: the takeaway (which is the recap) was pre-filled with «Предзаполнить». */
    recapSource?: 'manual' | 'draft',
  ): void {
    this.send({
      type: DialogClientFrame.End,
      ...(takeaway ? { takeaway } : {}),
      ...(tensionAfter !== null ? { tensionAfter } : {}),
      ...(takeaway && recapSource === 'draft' ? { recapSource } : {}),
    })
  }

  close(): void {
    this.closedByUs = true
    this.tts.cancel()
    clearTimeout(this.reconnectTimer)
    this.socket?.close(1000, 'left the screen')
    this.socket = null
  }

  /** Every unacknowledged message not yet put on this connection. The server deduplicates by `clientId`. */
  private sendPending(): void {
    for (const message of this.messages) {
      if (message.role !== 'user' || !message.pending || this.sentOnConnection.has(message.id)) continue
      const sent = this.send({ type: DialogClientFrame.Message, clientId: message.id, text: message.text })
      if (sent) this.sentOnConnection.add(message.id)
    }
  }

  /** After a reconnect: sync with REST first, then resend; else a message that did arrive shows up twice. */
  private async resume(socket: WebSocket, reconnected: boolean): Promise<void> {
    if (reconnected && this.deps.loadHistory) {
      const history = await this.deps.loadHistory().catch(() => null)
      if (this.socket !== socket) return
      if (history) this.reconcile(history)
    }
    if (this.socket === socket && this.isConnected()) this.sendPending()
  }

  /** REST is the record for everything that has a server id; local-only entries stay after it. */
  private reconcile(history: DialogMessageView[]): void {
    const knownLocally = new Set(this.messages.map((message) => message.id))
    const serverIds = new Set(history.map((entry) => entry.id))

    // An unacknowledged message that the server does have: found by its text among the entries
    // this feed has not seen yet, so that it is replaced by the record instead of shown twice.
    const delivered = new Set<string>()
    const claimed = new Set<string>()
    for (const message of this.messages) {
      if (message.role !== 'user' || !message.pending) continue
      const match = history.find(
        (entry) =>
          entry.role === 'user' &&
          entry.text === message.text &&
          !knownLocally.has(entry.id) &&
          !claimed.has(entry.id),
      )
      if (!match) continue
      claimed.add(match.id)
      delivered.add(message.id)
    }

    const live = new Map(
      this.messages.filter((message) => message.streaming).map((message) => [message.id, message]),
    )
    const merged = history.map((entry) => live.get(entry.id) ?? entry)
    // The greeting stays first unless the record has it too (the agent may not store it as a message).
    const greeting = this.messages.find(
      (message) =>
        message.id === GREETING_ID &&
        !history.some((entry) => entry.role === 'assistant' && entry.text === message.text),
    )
    const localOnly = this.messages.filter(
      (message) => message.id !== GREETING_ID && !serverIds.has(message.id) && !delivered.has(message.id),
    )
    this.messages = [...(greeting ? [greeting] : []), ...merged, ...localOnly]
    this.lastMessageId = history.at(-1)?.id ?? this.lastMessageId
    this.emitMessages()
  }

  private addHeard(messageId: string | undefined, text: string): void {
    const id = messageId ?? `heard-${crypto.randomUUID()}`
    if (!text.trim() || this.messages.some((message) => message.id === id)) return
    this.messages = [...this.messages, { id, role: 'user', text }]
    this.emitMessages()
  }

  /** A reply cut off by a drop is no longer being written; a replay or the REST record completes it. */
  private stopStreaming(): void {
    if (!this.messages.some((message) => message.streaming)) return
    this.messages = this.messages.map((message) =>
      message.streaming ? { ...message, streaming: false } : message,
    )
    this.emitMessages()
  }

  private onFrame(event: MessageEvent, socket: WebSocket): void {
    if (typeof event.data !== 'string') {
      if (event.data instanceof ArrayBuffer) this.tts.push(event.data)
      return
    }
    let frame: DialogServerMessage
    try {
      frame = JSON.parse(event.data) as DialogServerMessage
    } catch {
      return
    }

    switch (frame.type) {
      case DialogServerFrame.Ready: {
        const reconnected = this.everReady
        this.everReady = true
        this.attempt = 0
        this.authRetried = false
        this.setState('ready')
        if (frame.greeting && !this.messages.some((message) => message.id === GREETING_ID)) {
          this.messages = [{ id: GREETING_ID, role: 'assistant', text: frame.greeting }, ...this.messages]
          this.emitMessages()
        }
        void this.resume(socket, reconnected)
        return
      }
      case DialogServerFrame.Ack: {
        // The message arrived: swap the local id for the server one. If the record already holds
        // that id (a resend of a message that had got through), the local copy is the duplicate.
        const alreadyHeld = this.messages.some(
          (message) => message.id === frame.messageId && message.id !== frame.clientId,
        )
        this.messages = alreadyHeld
          ? this.messages.filter((message) => message.id !== frame.clientId)
          : this.messages.map((message) =>
              message.id === frame.clientId ? { ...message, id: frame.messageId, pending: false } : message,
            )
        this.lastMessageId = frame.messageId
        this.emitMessages()
        return
      }
      case DialogServerFrame.Transcript:
        this.handlers.onTranscript?.(frame.text, frame.final)
        // The final text is what the person said: it joins the feed as their message.
        if (frame.final) this.addHeard(frame.messageId, frame.text)
        return
      case DialogServerFrame.AssistantStart: {
        this.setState('streaming')
        const fresh: DialogMessageView = { id: frame.messageId, role: 'assistant', text: '', streaming: true }
        // After a reconnect the agent may repeat the reply that was cut off: start it over in place.
        const known = this.messages.some((message) => message.id === frame.messageId)
        this.messages = known
          ? this.messages.map((message) => (message.id === frame.messageId ? fresh : message))
          : [...this.messages, fresh]
        this.emitMessages()
        return
      }
      case DialogServerFrame.AssistantDelta:
        this.messages = this.messages.map((message) =>
          message.id === frame.messageId ? { ...message, text: message.text + frame.text } : message,
        )
        this.emitMessages()
        return
      case DialogServerFrame.AssistantEnd: {
        const complete: DialogMessageView = { id: frame.messageId, role: 'assistant', text: frame.text }
        const known = this.messages.some((message) => message.id === frame.messageId)
        this.messages = known
          ? this.messages.map((message) => (message.id === frame.messageId ? complete : message))
          : [...this.messages, complete]
        this.lastMessageId = frame.messageId
        this.setState('ready')
        this.emitMessages()
        return
      }
      case DialogServerFrame.TtsStart:
        this.speakingId = frame.messageId
        // A gateway from before the codecs sends no `codec`: its speech is PCM16.
        this.tts.begin(frame.codec ?? 'pcm16')
        this.handlers.onSpeech?.(frame.messageId, 'start')
        return
      case DialogServerFrame.TtsEnd:
        if (this.speakingId === frame.messageId) this.speakingId = null
        this.tts.end()
        this.handlers.onSpeech?.(frame.messageId, 'end')
        return
      case DialogServerFrame.Safety:
        this.handlers.onSafety(frame.level, frame.text, frame.hotlines)
        return
      case DialogServerFrame.Ended:
        this.closedByUs = true
        this.setState('ended')
        this.handlers.onEnded(frame.summary)
        return
      case DialogServerFrame.Error:
        this.handlers.onError(frame.code, frame.message)
        return
      default:
        return
    }
  }

  private onClose(event: CloseEvent): void {
    this.socket = null
    this.speakingId = null
    this.tts.cancel()
    if (this.closedByUs || this.state === 'ended') return
    this.stopStreaming()

    // The gateway refused a token that looked alive (a clock set minutes off, a token revoked
    // between our check and its own): one fresh token and one more try, then it is final.
    if (event.code === DialogCloseCode.Unauthorized && !this.authRetried) {
      this.authRetried = true
      this.setState('reconnecting')
      void this.deps.refreshSession().then(() => {
        if (!this.closedByUs && this.socket === null && this.state === 'reconnecting') this.connect()
      })
      return
    }

    // Retrying these is pointless: they need a new dialog or a new version of the app.
    const fatal: number[] = [DialogCloseCode.Unauthorized, DialogCloseCode.Superseded]
    if (fatal.includes(event.code)) {
      this.setState('failed')
      return
    }

    const delay = RECONNECT_DELAYS_MS[this.attempt]
    if (delay === undefined) {
      this.setState('failed')
      return
    }
    this.attempt += 1
    this.setState('reconnecting')
    // From half to one and a half of the base: a pod that dies takes thousands of clients down at the same
    // instant, and the same delay for all of them would bring them back in the same second.
    const spread = 0.5 + (this.deps.random ?? Math.random)()
    this.reconnectTimer = setTimeout(() => this.connect(), delay * spread)
  }

  /** History from REST: the screen restores the feed after a drop, or opens a past dialog. */
  setHistory(messages: DialogMessageView[]): void {
    this.messages = messages
    this.lastMessageId = messages.at(-1)?.id
    this.emitMessages()
  }
}
