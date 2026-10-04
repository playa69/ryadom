/**
 * Dialogs: REST plus the WebSocket protocol between the client and the app.
 *
 * This is our contract, not the agent's: it is stable and changes only by adding fields. Mobile
 * builds live for months, so the agent protocol may change underneath us while this one may not.
 */

/** Dialog modes. In v0 only `vent` is available. */
export enum DialogMode {
  Vent = 'vent',
  Chat = 'chat',
  Journal = 'journal',
  Recovery = 'recovery',
  RitualMorning = 'ritual_morning',
  RitualEvening = 'ritual_evening',
}

export enum SafetyLevel {
  /** The classifier grew wary: a careful question, and the screen does not switch. */
  Concern = 'concern',
  /** Crisis: de-escalation and the hotlines on top of everything. */
  Crisis = 'crisis',
}

// ─── REST ─────────────────────────────────────────────────────────────────────

export enum StartDialogApiErrorCode {
  /** The account does not exist or was deleted: the session must be terminated. */
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  /** The account is blocked. */
  USER_INACTIVE = 'USER_INACTIVE',
}

export interface StartDialogApiRequest {
  mode: DialogMode
}

export interface StartDialogApiResponse {
  dialogId: string
  /** true means we returned to an open dialog: a person never has more than one at a time. */
  resumed: boolean
  /** The agent's first message, if it gave one. */
  greeting: string | null
  /** How many hours passed since the previous conversation (time is part of the care). */
  sinceLastDialogHours: number | null
}

export interface DialogSummaryApiResponse {
  title: string
  themes: string[]
  /** Self-reported tension before and after, 1 to 10. */
  tensionBefore: number | null
  tensionAfter: number | null
}

export interface DialogListItemApiResponse {
  dialogId: string
  mode: DialogMode
  /** ISO 8601. */
  startedAt: string
  endedAt: string | null
  summary: DialogSummaryApiResponse | null
}

export interface ListDialogsApiResponse {
  items: DialogListItemApiResponse[]
  /** Cursor for the next page; null means there is nothing left to page through. */
  next: string | null
}

export interface DialogMessageApiResponse {
  id: string
  role: 'user' | 'assistant'
  text: string
  createdAt: string
  safetyLevel: SafetyLevel | null
}

export interface DialogApiResponse extends DialogListItemApiResponse {
  messages: DialogMessageApiResponse[]
}

export enum DialogApiErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  USER_INACTIVE = 'USER_INACTIVE',
  /** The dialog does not exist or belongs to someone else, which is the same thing to the client. */
  DIALOG_NOT_FOUND = 'DIALOG_NOT_FOUND',
}

export interface EndDialogApiRequest {
  /** "What you take with you". */
  takeaway?: string
  /** Tension after the conversation, 1 to 10. */
  tensionAfter?: number
}

export interface EndDialogApiResponse {
  summary: DialogSummaryApiResponse | null
}

// ─── WebSocket ────────────────────────────────────────────────────────────────

/** Frames from the client. The first must be `hello`: a browser cannot set headers on a socket. */
export enum DialogClientFrame {
  Hello = 'hello',
  Message = 'message',
  End = 'end',
  AudioStart = 'audio_start',
  AudioEnd = 'audio_end',
  TtsCancel = 'tts_cancel',
  Ping = 'ping',
}

/** Frames from the server. */
export enum DialogServerFrame {
  Ready = 'ready',
  Ack = 'ack',
  Transcript = 'transcript',
  AssistantStart = 'assistant_start',
  AssistantDelta = 'assistant_delta',
  AssistantEnd = 'assistant_end',
  TtsStart = 'tts_start',
  TtsEnd = 'tts_end',
  Safety = 'safety',
  Ended = 'ended',
  Error = 'error',
  Pong = 'pong',
}

/** The code in an `error` frame: the client uses it to decide what to show the person. */
export enum DialogWsErrorCode {
  UNAUTHORIZED = 'UNAUTHORIZED',
  DIALOG_NOT_FOUND = 'DIALOG_NOT_FOUND',
  RATE_LIMITED = 'RATE_LIMITED',
  MESSAGE_TOO_LONG = 'MESSAGE_TOO_LONG',
  /** The agent is unavailable: a conversation is impossible, but the hotlines stay on screen. */
  AGENT_UNAVAILABLE = 'AGENT_UNAVAILABLE',
  /** ASR or TTS is down: voice turns off and the conversation continues in text. */
  VOICE_UNAVAILABLE = 'VOICE_UNAVAILABLE',
}

/**
 * Socket close codes. 1000 and 1012 are standard; the 4xxx ones are ours, since RFC 6455 leaves the
 * 4000 to 4999 range to the application.
 */
export enum DialogCloseCode {
  Done = 1000,
  /** The server is restarting: the client reconnects on its own. */
  Restarting = 1012,
  Unauthorized = 4001,
  RateLimited = 4008,
  /** The same person connected again: one active connection per user. */
  Superseded = 4009,
  AgentUnavailable = 4010,
}

export interface HelloFrame {
  type: DialogClientFrame.Hello
  /** The access token; it is not put in the URL, where it would end up in the Ingress logs. */
  token: string
  dialogId: string
  /** The last message the client already saw: after a drop the rest is sent again. */
  lastMessageId?: string
}

export interface MessageFrame {
  type: DialogClientFrame.Message
  /** Client-side id: the server answers `ack` with it and deduplicates repeats by it. */
  clientId: string
  text: string
}

export interface EndFrame {
  type: DialogClientFrame.End
  takeaway?: string
  tensionAfter?: number
}

export interface AudioStartFrame {
  type: DialogClientFrame.AudioStart
  codec: 'pcm16'
  sampleRate: number
  channels: number
}

export type DialogClientMessage =
  | HelloFrame
  | MessageFrame
  | EndFrame
  | AudioStartFrame
  | { type: DialogClientFrame.AudioEnd }
  | { type: DialogClientFrame.TtsCancel; messageId: string }
  | { type: DialogClientFrame.Ping }

export interface HotlineApiResponse {
  name: string
  phone: string
}

export type DialogServerMessage =
  | { type: DialogServerFrame.Ready; dialogId: string; greeting: string | null; sinceLastDialogHours: number | null }
  | { type: DialogServerFrame.Ack; clientId: string; messageId: string }
  | { type: DialogServerFrame.Transcript; text: string; final: boolean; messageId?: string }
  | { type: DialogServerFrame.AssistantStart; messageId: string }
  | { type: DialogServerFrame.AssistantDelta; messageId: string; text: string }
  | { type: DialogServerFrame.AssistantEnd; messageId: string; text: string; emotions?: string[] }
  | { type: DialogServerFrame.TtsStart; messageId: string; codec: 'pcm16'; sampleRate: number }
  | { type: DialogServerFrame.TtsEnd; messageId: string }
  | { type: DialogServerFrame.Safety; level: SafetyLevel; text: string | null; hotlines: HotlineApiResponse[] }
  | { type: DialogServerFrame.Ended; summary: DialogSummaryApiResponse | null }
  | { type: DialogServerFrame.Error; code: DialogWsErrorCode; message: string }
  | { type: DialogServerFrame.Pong }

/** Protocol version carried in every frame as field `v`. Still 1; it changes only on a breaking change. */
export const DIALOG_PROTOCOL_VERSION = 1

/**
 * Binary voice frames: byte 0 is the kind, bytes 1 to 4 are a big-endian uint32
 * sequence number, and the rest is raw little-endian PCM16 samples.
 */
export enum AudioFrameKind {
  /** The person's audio: PCM16 at 16 kHz, 100 ms per frame. */
  User = 0x01,
  /** The agent's speech: PCM16 at 24 kHz, 200 ms per frame. */
  Tts = 0x02,
}

export const AUDIO_FRAME_HEADER_BYTES = 5
export const AUDIO_USER_SAMPLE_RATE = 16_000
export const AUDIO_TTS_SAMPLE_RATE = 24_000
