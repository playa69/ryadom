import { WebSocket } from 'ws'

/**
 * Connection to the agent for a single dialog. A thin layer: open a socket at the
 * user-scoped address, pass frames through, report the close. It knows nothing about frame meaning.
 *
 * The address is derived from `AGENT_API_URL`: http becomes ws, https becomes wss. A separate
 * variable is not needed, and two addresses would drift apart at the first move.
 */
export interface AgentSocket {
  /** Text frame (JSON). */
  send(frame: unknown): void
  /** Binary frame: the person's audio. */
  sendBinary(data: Buffer): void
  close(): void
  readonly connected: boolean
}

export interface AgentSocketHandlers {
  onText(frame: unknown): void
  onBinary(data: Buffer): void
  onOpen(): void
  onClose(code: number, reason: string): void
  onError(error: Error): void
}

export function agentWsUrl(baseUrl: string, userId: string, dialogId: string): string {
  const base = baseUrl.replace(/^http/, 'ws')
  return `${base}/v1/users/${encodeURIComponent(userId)}/dialogs/${encodeURIComponent(dialogId)}/ws`
}

export interface AgentSocketOptions {
  /** `AGENT_API_URL` from the app env; the http to ws conversion happens here. */
  baseUrl: string
  /** Shared secret; when empty the header is not sent at all (local mock). */
  token?: string
  userId: string
  dialogId: string
}

export function openAgentSocket(options: AgentSocketOptions, handlers: AgentSocketHandlers): AgentSocket {
  const { token } = options
  const socket = new WebSocket(agentWsUrl(options.baseUrl, options.userId, options.dialogId), {
    // Server to server: a header is available, so the token does not have to go into the URL.
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    handshakeTimeout: 10_000,
  })

  socket.on('open', handlers.onOpen)
  socket.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) return handlers.onBinary(data)
    try {
      handlers.onText(JSON.parse(data.toString('utf8')))
    } catch {
      handlers.onError(new Error('Agent sent a malformed text frame'))
    }
  })
  socket.on('close', (code: number, reason: Buffer) => handlers.onClose(code, reason.toString('utf8')))
  socket.on('error', handlers.onError)

  return {
    send(frame) {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame))
    },
    sendBinary(data) {
      if (socket.readyState === WebSocket.OPEN) socket.send(data, { binary: true })
    },
    close() {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(1000, 'client gone')
      }
    },
    get connected() {
      return socket.readyState === WebSocket.OPEN
    },
  }
}
