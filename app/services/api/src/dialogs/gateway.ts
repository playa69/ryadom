import type { IncomingMessage } from 'node:http'
import assertNever from 'assert-never'
import type { WebSocket } from 'ws'
import { AnalyticsEvent, COMPONENT_NAMES, type ComponentName, type DialogInterruptReason } from '@ryadom/analytics/events'
import type { ServerAnalytics } from '@ryadom/analytics/server'
import {
  bindRequestContext,
  createLogger,
  readTracingContext,
  runWithRequestContext,
  updateRequestContext,
} from '@ryadom/core/shared'
import {
  AUDIO_FRAME_HEADER_BYTES,
  AUDIO_TTS_SAMPLE_RATE,
  AudioFrameKind,
  DIALOG_PROTOCOL_VERSION,
  DialogClientFrame,
  DialogCloseCode,
  DialogServerFrame,
  DialogWsErrorCode,
  SafetyLevel,
  type DialogServerMessage,
  type DialogSummaryApiResponse,
  type TtsCodec,
} from '@ryadom/contracts/api/dialogs'
import { InputLimit } from '@ryadom/contracts/api/limits'
import { dialogIdProperty, messageCounts, tensionOutcome } from '../lib/analytics'
import type { AppServerEnv } from '../lib/env'
import { HOTLINES } from '../lib/hotlines'
import type { Jwt } from '../lib/jwt'
import { openAgentSocket, type AgentSocket } from './agent-socket'
import { isDraining } from '../lib/lifecycle'
import type { Sessions } from '../lib/sessions'
import { InOrder } from './in-order'
import { DIALOG_LIMITS } from './limits'
import { createSpeechEncoder, pickTtsCodec, type SpeechEncoder } from './tts-codec'

/**
 * Gateway for a single dialog: the client socket against the socket to the agent.
 *
 * What it does: verifies the token from the `hello` frame, keeps one active connection per person,
 * enforces the limits, translates frames in both directions, re-encodes the agent's speech into the
 * codec the client asked for (tts-codec.ts) and closes everything once either side is gone. What it
 * does not do: interpret or store message content, or write text to the logs.
 *
 * The signature of an access token proves nothing about the session once it has been issued, and a
 * dialog lasts far longer than a token is meant to be trusted. So the session is asked about when
 * the socket opens, which also stops a client that was signed out from reconnecting on the token it
 * still holds, and then at an interval for as long as the socket lives. A session that was signed
 * out, revoked or blocked closes the socket the way an expired token would: with `Unauthorized`, so
 * the client refreshes, finds the session gone and signs the person out.
 */

/** Open connections per user: a second one closes the first. */
const sessionsByUser = new Map<string, Set<DialogSession>>()

export interface GatewayDeps {
  env: AppServerEnv
  jwt: Jwt
  sessions: Pick<Sessions, 'isActive'>
  /** Product analytics: counts and outcomes of a dialog, never what was said. */
  analytics: ServerAnalytics
}

/**
 * Why a connection that did not end its dialog went away, in the catalog's terms. Null for the two
 * planned closes (a rollout and a second connection of the same person): the client comes back to the
 * same dialog, so they are not an interruption of the conversation and are not reported.
 */
function interruptReason(code: DialogCloseCode, reason: string): DialogInterruptReason | null {
  switch (code) {
    case DialogCloseCode.Restarting:
    case DialogCloseCode.Superseded:
      return null
    case DialogCloseCode.Unauthorized:
      return 'unauthorized'
    case DialogCloseCode.RateLimited:
      return 'rate_limited'
    case DialogCloseCode.AgentUnavailable:
      return 'agent_unavailable'
    case DialogCloseCode.Done:
      if (reason === 'idle') return 'idle'
      if (reason === 'max duration reached') return 'max_duration'
      return 'other'
    default:
      return assertNever(code)
  }
}

/** What the agent adds to a summary for analytics: replies in the whole dialog. */
interface AgentSummaryCounts {
  userMessages?: unknown
  assistantMessages?: unknown
}

interface AgentTextFrame {
  type?: unknown
  [key: string]: unknown
}

const MOOD_TONES = ['neutral', 'sleepy', 'angry', 'afraid', 'sad', 'calm'] as const

class DialogSession {
  private readonly logger = createLogger('dialog-gateway')
  private agent: AgentSocket | null = null
  private userId: string | null = null
  private dialogId: string | null = null
  /** The session of the access token from `hello`; null for a token that carries none. */
  private sessionId: string | null = null
  // For analytics: how long the dialog ran and how much was said (counts only; the gateway never reads the text).
  private openedAt = 0
  private userMessages = 0
  private assistantMessages = 0
  private hasTakeaway = false
  private outcomeReported = false
  private plannedClose = false
  private closeReason: DialogInterruptReason | null = null
  private checkingSession = false
  private helloTimer: NodeJS.Timeout
  private heartbeatTimer: NodeJS.Timeout | undefined
  private sessionTimer: NodeJS.Timeout | undefined
  private maxDurationTimer: NodeJS.Timeout | undefined
  private idleTimer: NodeJS.Timeout | undefined
  private alive = true
  private messageTokens: number = DIALOG_LIMITS.messageBurst
  private audioTokens: number = DIALOG_LIMITS.audioFrameBurst
  private lastRefill = Date.now()
  private lastAudioRefill = Date.now()
  private closed = false
  /** The codec of the agent's speech on this connection, from `hello.codecs`. */
  private codec: TtsCodec = 'pcm16'
  /** The encoder of the speech being voiced now; a new one for each `tts_start`. */
  private speech: SpeechEncoder | null = null
  /** The agent's frames, in its order, while Opus speech is being encoded off the main thread. */
  private readonly toClientInOrder = new InOrder((error) => this.onSpeechError(error))
  private speechErrorLogged = false
  // How much speech the codec saved: bytes from the agent and bytes to the client, for the log at the end.
  private speechBytesIn = 0
  private speechBytesOut = 0
  /**
   * Frames are handled one at a time, in arrival order. `hello` is asynchronous (it verifies the
   * token signature) while the client may send a message right after it, for example one queued
   * up during a disconnect. Without this queue such a message would reach the handler before the
   * session is established and would be answered with UNAUTHORIZED.
   */
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly socket: WebSocket,
    private readonly deps: GatewayDeps,
  ) {
    // A connection without `hello` is useless and must not keep holding memory.
    this.helloTimer = setTimeout(() => {
      this.fail(DialogWsErrorCode.UNAUTHORIZED, 'hello frame expected', DialogCloseCode.Unauthorized)
    }, DIALOG_LIMITS.helloTimeoutMs)

    // The constructor runs inside the connection's tracing context; ws would call these listeners
    // from the socket's own context, so they are bound to keep it.
    socket.on(
      'message',
      bindRequestContext((data: Buffer, isBinary: boolean) => {
        this.queue = this.queue.then(() => this.onClientMessage(data, isBinary)).catch(() => {})
      }),
    )
    socket.on(
      'close',
      bindRequestContext(() => this.dispose()),
    )
    socket.on(
      'error',
      bindRequestContext(() => this.dispose()),
    )
    socket.on(
      'pong',
      bindRequestContext(() => {
        this.alive = true
      }),
    )
  }

  private toClient(frame: DialogServerMessage): void {
    if (this.socket.readyState !== this.socket.OPEN) return
    this.socket.send(JSON.stringify({ v: DIALOG_PROTOCOL_VERSION, ...frame }))
  }

  private fail(code: DialogWsErrorCode, message: string, closeCode: DialogCloseCode): void {
    this.toClient({ type: DialogServerFrame.Error, code, message })
    this.close(closeCode, message)
  }

  private close(code: DialogCloseCode, reason: string): void {
    if (this.closed) return
    this.closed = true
    const why = interruptReason(code, reason)
    this.plannedClose = why === null
    this.closeReason = why
    try {
      this.socket.close(code, reason)
    } catch {
      // The socket may already have closed on its own, which is not an error.
    }
    this.dispose()
  }

  /** Server restart: the client reconnects on its own. */
  shutdown(): void {
    this.close(DialogCloseCode.Restarting, 'server is restarting')
  }

  /**
   * The connection is gone and the dialog was not ended through it: report it, unless it was a planned
   * close, or nothing was said and the agent was fine (a reconnect that went nowhere is not news).
   */
  private reportInterruption(): void {
    if (this.outcomeReported || this.plannedClose || !this.userId) return
    this.outcomeReported = true
    const reason = this.closeReason ?? 'client_closed'
    if (this.userMessages === 0 && reason !== 'agent_unavailable') return
    this.deps.analytics.capture(this.userId, AnalyticsEvent.DialogInterrupted, {
      ...dialogIdProperty(this.dialogId),
      reason,
      duration_s: Math.round((Date.now() - this.openedAt) / 1000),
      user_messages: this.userMessages,
    })
  }

  private dispose(): void {
    this.reportInterruption()
    this.reportSpeechBytes()
    this.toClientInOrder.stop()
    this.speech?.close()
    this.speech = null
    clearTimeout(this.helloTimer)
    clearInterval(this.heartbeatTimer)
    clearInterval(this.sessionTimer)
    clearTimeout(this.maxDurationTimer)
    clearTimeout(this.idleTimer)
    this.agent?.close()
    this.agent = null
    if (this.userId) {
      const sessions = sessionsByUser.get(this.userId)
      sessions?.delete(this)
      if (sessions && sessions.size === 0) sessionsByUser.delete(this.userId)
    }
  }

  /** Idle with no frames: close the connection; the agent ends the dialog by its own rules. */
  private touchIdle(): void {
    clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(
      () => this.close(DialogCloseCode.Done, 'idle'),
      this.deps.env.DIALOG_IDLE_TIMEOUT_SEC * 1000,
    )
  }

  private allowMessage(): boolean {
    const now = Date.now()
    const elapsed = (now - this.lastRefill) / 1000
    this.lastRefill = now
    this.messageTokens = Math.min(
      DIALOG_LIMITS.messageBurst,
      this.messageTokens + elapsed * DIALOG_LIMITS.messagesPerSecond,
    )
    if (this.messageTokens < 1) return false
    this.messageTokens -= 1
    return true
  }

  private allowAudioFrame(): boolean {
    const now = Date.now()
    const elapsed = (now - this.lastAudioRefill) / 1000
    this.lastAudioRefill = now
    this.audioTokens = Math.min(
      DIALOG_LIMITS.audioFrameBurst,
      this.audioTokens + elapsed * DIALOG_LIMITS.audioFramesPerSecond,
    )
    if (this.audioTokens < 1) return false
    this.audioTokens -= 1
    return true
  }

  private async onClientMessage(data: Buffer, isBinary: boolean): Promise<void> {
    this.touchIdle()

    if (isBinary) {
      // Audio frames pass straight through: the gateway neither decodes nor stores them
      //.
      if (data.length > DIALOG_LIMITS.maxAudioFrameBytes) {
        return this.fail(DialogWsErrorCode.MESSAGE_TOO_LONG, 'audio frame too large', DialogCloseCode.RateLimited)
      }
      if (data.length < AUDIO_FRAME_HEADER_BYTES || data.readUInt8(0) !== AudioFrameKind.User) return
      if (!this.allowAudioFrame()) {
        return this.fail(DialogWsErrorCode.RATE_LIMITED, 'too many audio frames', DialogCloseCode.RateLimited)
      }
      this.agent?.sendBinary(data)
      return
    }

    let frame: { type?: unknown; [key: string]: unknown }
    try {
      frame = JSON.parse(data.toString('utf8')) as { type?: unknown }
    } catch {
      return this.fail(DialogWsErrorCode.UNAUTHORIZED, 'malformed frame', DialogCloseCode.Unauthorized)
    }

    switch (frame.type) {
      case DialogClientFrame.Hello:
        return this.onHello(frame)
      case DialogClientFrame.Message:
        return this.onMessage(frame)
      case DialogClientFrame.End:
        this.hasTakeaway = typeof frame.takeaway === 'string' && frame.takeaway.length > 0
        this.agent?.send({
          type: 'end',
          takeaway: typeof frame.takeaway === 'string' ? frame.takeaway : undefined,
          tensionAfter: typeof frame.tensionAfter === 'number' ? frame.tensionAfter : undefined,
          // The takeaway is the recap; `draft` marks one pre-filled by the model (add-mood-diary D13).
          recapSource: frame.recapSource === 'draft' ? 'draft' : 'manual',
        })
        return
      case DialogClientFrame.AudioStart:
        // The format is fixed by the contract (PCM16, 16 kHz, mono), so the frame carries nothing.
        this.agent?.send({ type: 'audio_start' })
        return
      case DialogClientFrame.AudioEnd:
        this.agent?.send({ type: 'audio_end' })
        return
      case DialogClientFrame.TtsCancel:
        this.agent?.send({ type: 'tts_cancel', messageId: frame.messageId })
        return
      case DialogClientFrame.Ping:
        this.toClient({ type: DialogServerFrame.Pong })
        return
      default:
        return
    }
  }

  private async onHello(frame: { [key: string]: unknown }): Promise<void> {
    if (this.userId) return // a repeated hello is ignored: the session is already established
    clearTimeout(this.helloTimer)

    const token = typeof frame.token === 'string' ? frame.token : ''
    const dialogId = typeof frame.dialogId === 'string' ? frame.dialogId : ''
    const payload = token ? await this.deps.jwt.verifyToken(token, 'access') : null
    if (!payload || !dialogId) {
      return this.fail(DialogWsErrorCode.UNAUTHORIZED, 'invalid token or dialogId', DialogCloseCode.Unauthorized)
    }
    if (payload.sid && !(await this.deps.sessions.isActive(payload.sid))) {
      return this.fail(DialogWsErrorCode.UNAUTHORIZED, 'session ended', DialogCloseCode.Unauthorized)
    }
    // The socket may have gone while the registry was being asked: a closed one starts nothing.
    if (this.closed) return

    this.userId = payload.sub
    this.sessionId = payload.sid ?? null
    this.dialogId = dialogId
    this.openedAt = Date.now()
    this.codec = pickTtsCodec(frame.codecs, this.deps.env.DIALOG_AUDIO_CODECS)
    // The upgrade carried only what the client could put in headers; now the account is verified.
    updateRequestContext({ userId: this.userId })

    // One active connection per person: the second socket closes the first, otherwise the same
    // person on a phone and in a browser would hold two conversations in one dialog.
    const existing = sessionsByUser.get(this.userId)
    if (existing) {
      for (const session of existing) session.close(DialogCloseCode.Superseded, 'superseded')
    }
    sessionsByUser.set(this.userId, new Set([this]))

    this.startHeartbeat()
    this.startSessionCheck()
    this.maxDurationTimer = setTimeout(
      () => this.close(DialogCloseCode.Done, 'max duration reached'),
      this.deps.env.DIALOG_MAX_DURATION_SEC * 1000,
    )
    this.touchIdle()
    this.connectAgent()
  }

  private onMessage(frame: { [key: string]: unknown }): void {
    const clientId = typeof frame.clientId === 'string' ? frame.clientId : ''
    const text = typeof frame.text === 'string' ? frame.text : ''
    if (!this.userId) {
      return this.fail(DialogWsErrorCode.UNAUTHORIZED, 'hello frame expected', DialogCloseCode.Unauthorized)
    }
    if (!clientId || !text) return
    if (text.length > InputLimit.MessageMax) {
      return this.toClient({
        type: DialogServerFrame.Error,
        code: DialogWsErrorCode.MESSAGE_TOO_LONG,
        message: `message longer than ${InputLimit.MessageMax} characters`,
      })
    }
    if (!this.allowMessage()) {
      return this.toClient({
        type: DialogServerFrame.Error,
        code: DialogWsErrorCode.RATE_LIMITED,
        message: 'too many messages',
      })
    }
    // A reply the agent never got (it is not connected yet or just left) is not a turn of the conversation.
    const forwarded = this.agent?.connected === true
    this.agent?.send({ type: 'user_message', id: clientId, text })
    this.userMessages += 1
    if (forwarded) this.reportTurn('text')
  }

  /** One accepted reply of the person: the target action of the product (see `AnalyticsEvent.DialogTurn`). Never its text. */
  private reportTurn(input: 'text' | 'voice'): void {
    if (!this.userId) return
    this.deps.analytics.capture(this.userId, AnalyticsEvent.DialogTurn, { ...dialogIdProperty(this.dialogId), input })
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (!this.alive) return this.close(DialogCloseCode.Done, 'heartbeat lost')
      this.alive = false
      try {
        this.socket.ping()
      } catch {
        this.close(DialogCloseCode.Done, 'ping failed')
      }
    }, DIALOG_LIMITS.heartbeatMs)
    this.heartbeatTimer.unref()
  }

  private startSessionCheck(): void {
    const sessionId = this.sessionId
    if (!sessionId) return
    this.sessionTimer = setInterval(() => {
      // A slow registry must not stack up checks: the next tick waits for this one.
      if (this.checkingSession) return
      this.checkingSession = true
      this.deps.sessions
        .isActive(sessionId)
        .then((active) => {
          if (!active) this.fail(DialogWsErrorCode.UNAUTHORIZED, 'session ended', DialogCloseCode.Unauthorized)
        })
        // A registry that cannot be reached is no reason to cut a person off mid-conversation: the next tick asks again.
        .catch((error: unknown) =>
          this.logger.warn('Не удалось проверить сессию открытого диалога', error, { userId: this.userId }),
        )
        .finally(() => {
          this.checkingSession = false
        })
    }, this.deps.env.DIALOG_SESSION_CHECK_SEC * 1000)
    this.sessionTimer.unref()
  }

  private connectAgent(): void {
    const userId = this.userId!
    const dialogId = this.dialogId!
    this.agent = openAgentSocket(
      {
        baseUrl: this.deps.env.AGENT_API_URL,
        token: this.deps.env.AGENT_API_TOKEN,
        userId,
        dialogId,
      },
      {
        onOpen: () => {
          this.logger.info('Соединение с агентом открыто', { userId, dialogId, codec: this.codec })
        },
        onText: (frame) => this.onAgentText(frame as AgentTextFrame),
        onBinary: (data) => this.onAgentSpeech(data),
        onClose: (code, reason) => {
          this.logger.info('Агент закрыл соединение', { userId, dialogId, code, reason })
          // The agent is gone, so there is nothing left to continue the conversation with. What it said
          // before closing (its `ended`, the last of its speech still in the encoder) goes out first.
          const closeCode = code === 1000 ? DialogCloseCode.Done : DialogCloseCode.AgentUnavailable
          this.toClientInOrder.push(null, () => this.close(closeCode, reason || 'agent closed'))
        },
        onError: (error) => {
          this.logger.warn('Ошибка соединения с агентом', error, { userId, dialogId })
          this.fail(
            DialogWsErrorCode.AGENT_UNAVAILABLE,
            'agent is unavailable',
            DialogCloseCode.AgentUnavailable,
          )
        },
      },
    )
  }

  /**
   * A text frame of the agent. The speech encoder follows `tts_start` and `tts_end` the moment they
   * arrive, since the audio after them belongs to the next speech; the frame itself reaches the client
   * in its turn, after the audio that came before it (which Opus may still be encoding).
   */
  private onAgentText(frame: AgentTextFrame): void {
    if (frame.type === 'tts_start') this.startSpeech()
    else if (frame.type === 'tts_end') this.endSpeech()
    this.toClientInOrder.push(frame, (ready) => this.fromAgent(ready))
  }

  /** A binary frame of the agent: its speech, re-encoded for the client. */
  private onAgentSpeech(data: Buffer): void {
    this.speechBytesIn += data.length
    // Audio without `tts_start` (the agent never sends it, but the protocol allows it) still gets the codec.
    const speech = this.speech ?? this.startSpeech()
    this.toClientInOrder.push(speech.frame(data), (frame) => this.sendSpeech(frame))
  }

  private startSpeech(): SpeechEncoder {
    // A speech the agent never ended is ended here, so its tail is not lost.
    this.endSpeech()
    this.speech = createSpeechEncoder(this.codec, {
      bitrate: this.deps.env.DIALOG_OPUS_BITRATE,
      complexity: this.deps.env.DIALOG_OPUS_COMPLEXITY,
    })
    return this.speech
  }

  private endSpeech(): void {
    const speech = this.speech
    this.speech = null
    const tail = speech?.finish()
    if (tail) this.toClientInOrder.push(tail, (frame) => this.sendSpeech(frame))
  }

  private sendSpeech(frame: Buffer | null): void {
    if (!frame || this.socket.readyState !== this.socket.OPEN) return
    this.speechBytesOut += frame.length
    this.socket.send(frame, { binary: true })
  }

  /** The encoder failed (its worker died): that speech goes on without the rest of its audio. Logged once. */
  private onSpeechError(error: unknown): void {
    if (this.speechErrorLogged) return
    this.speechErrorLogged = true
    this.logger.warn('Не удалось закодировать озвучку', error, {
      userId: this.userId,
      dialogId: this.dialogId,
      codec: this.codec,
    })
  }

  /** What the codec of this connection did to the size of the agent's speech. Counts only, never the sound. */
  private reportSpeechBytes(): void {
    if (this.speechBytesIn === 0) return
    const bytesIn = this.speechBytesIn
    this.speechBytesIn = 0
    this.logger.info('Озвучка за соединение', {
      userId: this.userId,
      dialogId: this.dialogId,
      codec: this.codec,
      bytesIn,
      bytesOut: this.speechBytesOut,
    })
  }

  /** Agent frames are translated into our protocol: fields are copied by name, the rest is dropped. */
  private fromAgent(frame: AgentTextFrame): void {
    const str = (key: string): string | null => (typeof frame[key] === 'string' ? (frame[key] as string) : null)
    const num = (key: string): number | null => (typeof frame[key] === 'number' ? (frame[key] as number) : null)

    switch (frame.type) {
      case 'ready':
        return this.toClient({
          type: DialogServerFrame.Ready,
          dialogId: this.dialogId!,
          greeting: str('greeting'),
          sinceLastDialogHours: num('sinceLastDialogHours'),
        })
      case 'ack': {
        const clientId = str('id')
        const messageId = str('messageId')
        if (!clientId || !messageId) return
        return this.toClient({ type: DialogServerFrame.Ack, clientId, messageId })
      }
      case 'transcript': {
        const text = str('text')
        if (text === null) return
        // A finished transcript WITH TEXT is one spoken turn of the person. The agent also sends a final
        // one with empty text for silence, an echo or a cough, and stores no message for it: that is not
        // something the person said. Partial ones are not counted either.
        if (frame.final === true && text.trim().length > 0) {
          this.userMessages += 1
          this.reportTurn('voice')
        }
        const messageId = str('messageId')
        return this.toClient({
          type: DialogServerFrame.Transcript,
          text,
          final: frame.final === true,
          ...(messageId ? { messageId } : {}),
        })
      }
      case 'assistant_start': {
        const messageId = str('messageId')
        if (!messageId) return
        return this.toClient({ type: DialogServerFrame.AssistantStart, messageId })
      }
      case 'assistant_delta': {
        const messageId = str('messageId')
        const text = str('text')
        if (!messageId || text === null) return
        return this.toClient({ type: DialogServerFrame.AssistantDelta, messageId, text })
      }
      case 'assistant_end': {
        const messageId = str('messageId')
        const text = str('text')
        if (!messageId || text === null) return
        this.assistantMessages += 1
        return this.toClient({
          type: DialogServerFrame.AssistantEnd,
          messageId,
          text,
        })
      }
      case 'tts_start': {
        const messageId = str('messageId')
        if (!messageId) return
        // The agent's speech is 24 kHz by its contract, and the encoders are made for it.
        return this.toClient({
          type: DialogServerFrame.TtsStart,
          messageId,
          codec: this.codec,
          sampleRate: AUDIO_TTS_SAMPLE_RATE,
        })
      }
      case 'tts_end': {
        const messageId = str('messageId')
        if (!messageId) return
        return this.toClient({ type: DialogServerFrame.TtsEnd, messageId })
      }
      case 'component': {
        // One real call of one of the agent's parts for this dialog: a name, how it went, whether it was cached.
        // Nothing else of the frame is read, so a prompt or a vendor's error text cannot reach a report.
        const component = COMPONENT_NAMES.find((name) => name === frame.component) as ComponentName | undefined
        if (!component || !this.userId) return
        this.deps.analytics.capture(this.userId, AnalyticsEvent.ComponentCalled, {
          ...dialogIdProperty(this.dialogId),
          component,
          outcome: frame.outcome === 'error' ? 'error' : 'ok',
          cached: frame.cached === true,
        })
        return
      }
      case 'mood': {
        // The tone of the person's last turn, from the agent's classifier (PROTEUS-168). Only known values pass.
        const tone = MOOD_TONES.find((name) => name === frame.tone)
        const intensity = num('intensity')
        if (!tone || intensity === null) return
        return this.toClient({
          type: DialogServerFrame.Mood,
          tone,
          intensity: Math.min(1, Math.max(0, intensity)),
          at: num('at') ?? Date.now(),
        })
      }
      case 'safety': {
        // The hotlines in this frame are always filled in: if the agent gave none, we substitute
        // ours. The SOS screen must never open empty.
        // The agent raises this frame when help is needed now, so a frame without a level is a crisis.
        const level = frame.level === SafetyLevel.Concern ? SafetyLevel.Concern : SafetyLevel.Crisis
        // Counted with no person attached: how often the hotlines were shown, not who needed them.
        this.deps.analytics.captureAnonymous(AnalyticsEvent.SafetySignal, { level })
        const hotlines = Array.isArray(frame.hotlines) && frame.hotlines.length > 0
          ? (frame.hotlines as { name: string; phone: string }[])
          : HOTLINES
        return this.toClient({ type: DialogServerFrame.Safety, level, text: str('text'), hotlines })
      }
      case 'ended': {
        // The agent builds the summary itself; its shape is already described by the contract
        // (DialogSummary).
        const raw = (frame.summary ?? null) as (DialogSummaryApiResponse & AgentSummaryCounts) | null
        // The counts of the whole dialog are for analytics only: they are not part of the contract with clients.
        const {
          userMessages: _user,
          assistantMessages: _assistant,
          recapAt: _recapAt,
          ...publicSummary
        } = (raw ?? {}) as DialogSummaryApiResponse & AgentSummaryCounts & { recapAt?: unknown }
        const summary = raw ? (publicSummary as DialogSummaryApiResponse) : null
        if (this.userId && !this.outcomeReported) {
          this.outcomeReported = true
          this.deps.analytics.capture(this.userId, AnalyticsEvent.DialogEnded, {
            ...dialogIdProperty(this.dialogId),
            via: 'socket',
            duration_s: Math.round((Date.now() - this.openedAt) / 1000),
            ...messageCounts(raw, { user: this.userMessages, assistant: this.assistantMessages }),
            has_takeaway: this.hasTakeaway,
            ...tensionOutcome(summary),
          })
        }
        this.toClient({ type: DialogServerFrame.Ended, summary })
        return this.close(DialogCloseCode.Done, 'dialog ended')
      }
      case 'error': {
        const code = frame.code === 'VOICE_UNAVAILABLE' ? DialogWsErrorCode.VOICE_UNAVAILABLE : null
        // Losing voice is not the end of the conversation: text keeps working.
        if (code) {
          return this.toClient({
            type: DialogServerFrame.Error,
            code,
            message: str('message') ?? 'voice is unavailable',
          })
        }
        return this.fail(
          DialogWsErrorCode.AGENT_UNAVAILABLE,
          str('message') ?? 'agent error',
          DialogCloseCode.AgentUnavailable,
        )
      }
      case 'pong':
        return
      default:
        return
    }
  }
}

/**
 * A new client connection: the session itself waits for `hello` and everything after it. The
 * tracing headers are read from the upgrade request and are this connection's context for its whole
 * life: a socket has no later request to carry them.
 */
export function handleDialogSocket(
  socket: WebSocket,
  deps: GatewayDeps,
  request: Pick<IncomingMessage, 'headers'>,
): void {
  // The balancer has not stopped sending traffic yet: a socket that arrives now would be closed a few seconds
  // later anyway, so it is turned away at once and the client comes back to a pod that stays.
  if (isDraining()) {
    socket.close(DialogCloseCode.Restarting, 'server is restarting')
    return
  }
  runWithRequestContext(
    readTracingContext((name) => request.headers[name]),
    () => new DialogSession(socket, deps),
  )
}

/**
 * Server rollout: every open dialog gets 1012 and the clients reconnect. The closing is
 * spread over `spreadMs`: a pod with thousands of dialogs that closed them all in one instant would send
 * every client back in the same second, and the other pods would take the whole herd at once.
 */
export function closeAllDialogSessions(spreadMs = 0): void {
  const sessions = [...sessionsByUser.values()].flatMap((set) => [...set])
  sessionsByUser.clear()
  for (const session of sessions) {
    if (spreadMs > 0) setTimeout(() => session.shutdown(), Math.random() * spreadMs)
    else session.shutdown()
  }
}
