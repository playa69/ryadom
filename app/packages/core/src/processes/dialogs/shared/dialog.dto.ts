import type {
  AgentDialogListItemResponse,
  AgentDialogMemoryMode,
  AgentDialogResponse,
  AgentDialogSummaryResponse,
  AgentMessageResponse,
  AgentRecapItemResponse,
} from '../../../integrations/agent-api'

/**
 * Dialog DTOs are core-internal types. The agent's own shapes (`Agent*Response`) are not
 * exposed: their fields can change together with its version, while the application contract
 * cannot change without shipping new mobile builds.
 */

export type DialogRecapStatus = 'pending' | 'ready' | 'none'
export type DialogRecapSource = 'manual' | 'draft' | 'auto'

export interface DialogSummaryDTO {
  title: string
  themes: string[]
  tensionBefore: number | null
  tensionAfter: number | null
  /** Replies in the whole dialog, over every connection; null when the agent did not say. Not part of the app contract. */
  userMessages: number | null
  assistantMessages: number | null
  recap: string | null
  recapStatus: DialogRecapStatus
  recapSource: DialogRecapSource | null
  /** `false`: no recap can be made for this conversation; null: the agent did not say. */
  recapAvailable: boolean | null
  /** When the recap was stored. */
  recapAt: Date | null
}

/** A conversation with its recap: a line of the journal and an input of the week summary. */
export interface DialogRecapItemDTO {
  dialogId: string
  startedAt: Date
  title: string | null
  recap: string
  recapSource: DialogRecapSource | null
  recapAt: Date | null
}

export interface DialogListItemDTO {
  dialogId: string
  startedAt: Date
  endedAt: Date | null
  summary: DialogSummaryDTO | null
  /** `off`: a conversation "without memory" (no memory block, notes or search), otherwise an ordinary one; also `off` when unsaved. */
  memoryMode: AgentDialogMemoryMode
  /** `false`: a conversation the person asked not to keep: the journal shows a mark without text. */
  saved: boolean
}

export interface DialogMessageDTO {
  id: string
  role: 'user' | 'assistant'
  text: string
  createdAt: Date
}

export interface DialogDTO extends DialogListItemDTO {
  messages: DialogMessageDTO[]
}

function toDate(value: string | null | undefined): Date | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/** The recap is one free-form text; anything else (an older agent's three parts) is no recap. */
export function toRecapText(recap: unknown): string | null {
  return typeof recap === 'string' && recap.trim() ? recap : null
}

const RECAP_SOURCES: readonly string[] = ['manual', 'draft', 'auto']

function toRecapSource(value: string | null | undefined): DialogRecapSource | null {
  return value && RECAP_SOURCES.includes(value) ? (value as DialogRecapSource) : null
}

export function toDialogRecapItemDTO(item: AgentRecapItemResponse): DialogRecapItemDTO | null {
  const recap = toRecapText(item.recap)
  if (!recap) return null
  return {
    dialogId: item.dialogId,
    startedAt: toDate(item.startedAt) ?? new Date(0),
    title: item.title ?? null,
    recap,
    recapSource: toRecapSource(item.recapSource),
    recapAt: toDate(item.recapAt),
  }
}

export function toDialogSummaryDTO(summary: AgentDialogSummaryResponse | null): DialogSummaryDTO | null {
  if (!summary) return null
  return {
    title: summary.title,
    themes: Array.isArray(summary.themes) ? summary.themes : [],
    tensionBefore: summary.tensionBefore ?? null,
    tensionAfter: summary.tensionAfter ?? null,
    userMessages: summary.userMessages ?? null,
    assistantMessages: summary.assistantMessages ?? null,
    recap: toRecapText(summary.recap),
    // An agent without recaps (an older one) never says `pending` or `ready`.
    recapStatus: summary.recapStatus === 'pending' || summary.recapStatus === 'ready' ? summary.recapStatus : 'none',
    recapSource: toRecapSource(summary.recapSource),
    recapAvailable: typeof summary.recapAvailable === 'boolean' ? summary.recapAvailable : null,
    recapAt: toDate(summary.recapAt),
  }
}

export function toDialogListItemDTO(item: AgentDialogListItemResponse): DialogListItemDTO {
  return {
    dialogId: item.dialogId,
    // The agent returns ISO strings; an unusable date is not replaced with "now", let it show.
    startedAt: toDate(item.startedAt) ?? new Date(0),
    endedAt: toDate(item.endedAt),
    summary: toDialogSummaryDTO(item.summary),
    // An agent that does not report it (an older one) held every dialog with memory as usual.
    memoryMode: item.memoryMode === 'off' ? 'off' : 'on',
    saved: item.saved !== false,
  }
}

function toDialogMessageDTO(message: AgentMessageResponse): DialogMessageDTO {
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    createdAt: toDate(message.createdAt) ?? new Date(0),
  }
}

export function toDialogDTO(dialog: AgentDialogResponse): DialogDTO {
  return {
    ...toDialogListItemDTO(dialog),
    messages: dialog.messages.map(toDialogMessageDTO),
  }
}
