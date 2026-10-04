import type { WebSocket } from 'ws'
import { createLogger } from '@ryadom/core/shared'
import {
  AUDIO_FRAME_HEADER_BYTES,
  AudioFrameKind,
  DIALOG_PROTOCOL_VERSION,
  DialogClientFrame,
  DialogCloseCode,
  DialogServerFrame,
  DialogWsErrorCode,
  SafetyLevel,
  type DialogServerMessage,
  type DialogSummaryApiResponse,
} from '@ryadom/contracts/api/dialogs'
import { InputLimit } from '@ryadom/contracts/api/limits'
import type { AppServerEnv } from '../lib/env'
import { HOTLINES } from '../lib/hotlines'
import type { Jwt } from '../lib/jwt'
import { openAgentSocket, type AgentSocket } from './agent-socket'
import { isDraining } from '../lib/lifecycle'
import { DIALOG_LIMITS } from './limits'

/**
 * Gateway for a single dialog: the client socket against the socket to the agent.
 *
 * What it does: verifies the token from the `hello` frame, keeps one active connection per person,
 * enforces the limits, translates frames in both directions and closes everything once either side
 * is gone. What it does not do: interpret or store message content, or write text to the logs.
 */

/** Open connections per user: a second one closes the first. */
const sessionsByUser = new Map<string, Set<DialogSession>>()

export interface GatewayDeps {
  env: AppServerEnv
  jwt: Jwt
}

interface AgentTextFrame {
  type?: unknown
  [key: string]: unknown
}

class DialogSession {
  private readonly logger = createLogger('dialog-gateway')
  private agent: AgentSocket | null = null
  private userId: string | null = null
  private dialogId: string | null = null
  private helloTimer: NodeJS.Timeout
  private heartbeatTimer: NodeJS.Timeout | undefined
  private maxDurationTimer: NodeJS.Timeout | undefined
  private idleTimer: NodeJS.Timeout | undefined
  private alive = true
  private messageTokens: number = DIALOG_LIMITS.messageBurst
  private audioTokens: number = DIALOG_LIMITS.audioFrameBurst
  private lastRefill = Date.now()
  private lastAudioRefill = Date.now()
  private closed = false
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

    socket.on('message', (data: Buffer, isBinary: boolean) => {
      this.queue = this.queue.then(() => this.onClientMessage(data, isBinary)).catch(() => {})
    })
    socket.on('close', () => this.dispose())
    socket.on('error', () => this.dispose())
    socket.on('pong', () => {
      this.alive = true
    })
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

  private dispose(): void {
    clearTimeout(this.helloTimer)
    clearInterval(this.heartbeatTimer)
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
        this.agent?.send({
          type: 'end',
          takeaway: typeof frame.takeaway === 'string' ? frame.takeaway : undefined,
          tensionAfter: typeof frame.tensionAfter === 'number' ? frame.tensionAfter : undefined,
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

    this.userId = payload.sub
    this.dialogId = dialogId

    // One active connection per person: the second socket closes the first, otherwise the same
    // person on a phone and in a browser would hold two conversations in one dialog.
    const existing = sessionsByUser.get(this.userId)
    if (existing) {
      for (const session of existing) session.close(DialogCloseCode.Superseded, 'superseded')
    }
    sessionsByUser.set(this.userId, new Set([this]))

    this.startHeartbeat()
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
    this.agent?.send({ type: 'user_message', id: clientId, text })
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
          this.logger.info('Соединение с агентом открыто', { userId, dialogId })
        },
        onText: (frame) => this.fromAgent(frame as AgentTextFrame),
        onBinary: (data) => {
          // Speech goes to the client as is: the gateway does not re-encode it.
          if (this.socket.readyState === this.socket.OPEN) this.socket.send(data, { binary: true })
        },
        onClose: (code, reason) => {
          this.logger.info('Агент закрыл соединение', { userId, dialogId, code, reason })
          // The agent is gone, so there is nothing left to continue the conversation with.
          this.close(code === 1000 ? DialogCloseCode.Done : DialogCloseCode.AgentUnavailable, reason || 'agent closed')
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
        return this.toClient({
          type: DialogServerFrame.AssistantEnd,
          messageId,
          text,
        })
      }
      case 'tts_start': {
        const messageId = str('messageId')
        if (!messageId) return
        return this.toClient({
          type: DialogServerFrame.TtsStart,
          messageId,
          codec: 'pcm16',
          sampleRate: num('sampleRate') ?? 24_000,
        })
      }
      case 'tts_end': {
        const messageId = str('messageId')
        if (!messageId) return
        return this.toClient({ type: DialogServerFrame.TtsEnd, messageId })
      }
      case 'safety': {
        // The hotlines in this frame are always filled in: if the agent gave none, we substitute
        // ours. The SOS screen must never open empty.
        // The agent raises this frame when help is needed now, so a frame without a level is a crisis.
        const level = frame.level === SafetyLevel.Concern ? SafetyLevel.Concern : SafetyLevel.Crisis
        const hotlines = Array.isArray(frame.hotlines) && frame.hotlines.length > 0
          ? (frame.hotlines as { name: string; phone: string }[])
          : HOTLINES
        return this.toClient({ type: DialogServerFrame.Safety, level, text: str('text'), hotlines })
      }
      case 'ended': {
        // The agent builds the summary itself; its shape is already described by the contract
        // (DialogSummary).
        const summary = (frame.summary ?? null) as DialogSummaryApiResponse | null
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

/** A new client connection: the session itself waits for `hello` and everything after it. */
export function handleDialogSocket(socket: WebSocket, deps: GatewayDeps): void {
  // The balancer has not stopped sending traffic yet: a socket that arrives now would be closed a few seconds
  // later anyway, so it is turned away at once and the client comes back to a pod that stays.
  if (isDraining()) {
    socket.close(DialogCloseCode.Restarting, 'server is restarting')
    return
  }
  new DialogSession(socket, deps)
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

/** For metrics and tests: how many dialogs are open right now. */
export function openDialogCount(): number {
  let total = 0
  for (const sessions of sessionsByUser.values()) total += sessions.size
  return total
}
