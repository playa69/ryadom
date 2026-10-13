import type {
  AgentDialogListItemResponse,
  AgentDialogMemoryMode,
  AgentDialogResponse,
  AgentDialogSummaryResponse,
  AgentMessageResponse,
} from '../../../integrations/agent-api'

/**
 * Dialog DTOs are core-internal types. The agent's own shapes (`Agent*Response`) are not
 * exposed: their fields can change together with its version, while the application contract
 * cannot change without shipping new mobile builds.
 */

export interface DialogSummaryDTO {
  title: string
  themes: string[]
  tensionBefore: number | null
  tensionAfter: number | null
  /** Replies in the whole dialog, over every connection; null when the agent did not say. Not part of the app contract. */
  userMessages: number | null
  assistantMessages: number | null
}

export interface DialogListItemDTO {
  dialogId: string
  startedAt: Date
  endedAt: Date | null
  summary: DialogSummaryDTO | null
  /** `off`: a conversation "without memory", deleted by the agent 24 hours after its last message. */
  memoryMode: AgentDialogMemoryMode
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

export function toDialogSummaryDTO(summary: AgentDialogSummaryResponse | null): DialogSummaryDTO | null {
  if (!summary) return null
  return {
    title: summary.title,
    themes: Array.isArray(summary.themes) ? summary.themes : [],
    tensionBefore: summary.tensionBefore ?? null,
    tensionAfter: summary.tensionAfter ?? null,
    userMessages: summary.userMessages ?? null,
    assistantMessages: summary.assistantMessages ?? null,
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
  }
}

export function toDialogMessageDTO(message: AgentMessageResponse): DialogMessageDTO {
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
