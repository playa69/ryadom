/**
 * The agent's memory as it returns it (`/v1/users/{userId}/memory...`), without domain DTOs.
 *
 * A fact is the person's own words about themselves: none of the texts and slots here may reach a
 * log, an error message or analytics. Ids, codes and counts may.
 */

/** Whether the feature works on the agent at all; not the person's own switch. */
export const AGENT_MEMORY_MODES = ['off', 'shadow', 'on'] as const
export type AgentMemoryMode = (typeof AGENT_MEMORY_MODES)[number]

/** Memory for one dialog: `off` is a conversation "without memory". */
export const AGENT_DIALOG_MEMORY_MODES = ['on', 'off'] as const
export type AgentDialogMemoryMode = (typeof AGENT_DIALOG_MEMORY_MODES)[number]

export const AGENT_MEMORY_FACT_CATEGORIES = [
  'style',
  'boundary',
  'person',
  'situation',
  'goal',
  'works',
  'interest',
  'recap',
] as const
export type AgentMemoryFactCategory = (typeof AGENT_MEMORY_FACT_CATEGORIES)[number]

export const AGENT_MEMORY_FACT_STATUSES = ['candidate', 'proposed', 'active', 'pinned', 'expired'] as const
export type AgentMemoryFactStatus = (typeof AGENT_MEMORY_FACT_STATUSES)[number]

export const AGENT_MEMORY_FACT_ORIGINS = ['auto', 'user_said', 'user_edit'] as const
export type AgentMemoryFactOrigin = (typeof AGENT_MEMORY_FACT_ORIGINS)[number]

export const AGENT_MEMORY_FACT_SENSITIVITIES = ['normal', 'sensitive'] as const
export type AgentMemoryFactSensitivity = (typeof AGENT_MEMORY_FACT_SENSITIVITIES)[number]

export const AGENT_MEMORY_CHANGES_STATUSES = ['pending', 'ready', 'skipped'] as const
export type AgentMemoryChangesStatus = (typeof AGENT_MEMORY_CHANGES_STATUSES)[number]

export const AGENT_MEMORY_CHANGE_OPS = ['add', 'update', 'confirm', 'supersede'] as const
export type AgentMemoryChangeOp = (typeof AGENT_MEMORY_CHANGE_OPS)[number]

/** The slots of a fact: `style` uses the first five, `person` the last three. */
export interface AgentMemoryFactSlots {
  address?: string
  form?: 'ty' | 'vy'
  length?: 'short' | 'normal'
  advice?: 'ask_first' | 'ok'
  tone?: 'soft' | 'direct'
  role?: string
  name?: string
  note?: string
}

export interface AgentMemoryFactSource {
  dialogId: string
  /** `YYYY-MM-DD`. */
  date: string
}

export interface AgentMemoryFactResponse {
  id: string
  category: AgentMemoryFactCategory
  text: string
  slots: AgentMemoryFactSlots | null
  importance: number
  confidence: number
  status: AgentMemoryFactStatus
  origin: AgentMemoryFactOrigin
  sensitivity: AgentMemoryFactSensitivity
  sources: AgentMemoryFactSource[]
  /** ISO 8601, as the agent wrote them. */
  createdAt: string
  updatedAt: string
  lastConfirmedAt: string | null
  expiresAt: string | null
  confirmCount: number
  seenByUser: boolean
}

/** `GET /memory`. */
export interface AgentMemoryResponse {
  available: boolean
  mode: AgentMemoryMode
  enabled: boolean
  consentVersion: string | null
  consentAt: string | null
  rulesVersion: string
  limits: { maxFacts: number }
  facts: AgentMemoryFactResponse[]
}

/** `PUT /memory/settings`. */
export interface AgentMemorySettingsResponse {
  enabled: boolean
  consentVersion: string | null
  consentAt: string | null
}

/** `GET /memory/changes?dialogId=`. */
export interface AgentMemoryChangesResponse {
  status: AgentMemoryChangesStatus
  /** Why nothing was extracted: a code such as `too_short`, never a text. */
  reason: string | null
  items: { op: AgentMemoryChangeOp; fact: AgentMemoryFactResponse }[]
}

/** One line of the history of changes: no texts. */
export interface AgentMemoryEventResponse {
  factId: string | null
  op: string
  actor: string
  dialogId: string | null
  at: string
}

/** `GET /memory/export`. */
export interface AgentMemoryExportResponse {
  exportedAt: string
  rulesVersion: string
  settings: {
    enabled: boolean
    consentVersion: string | null
    consentAt: string | null
    epochAt: string | null
    updatedAt: string | null
  }
  facts: AgentMemoryFactResponse[]
  events: AgentMemoryEventResponse[]
}
