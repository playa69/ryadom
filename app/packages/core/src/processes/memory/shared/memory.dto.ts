import type {
  AgentMemoryChangeOp,
  AgentMemoryChangesResponse,
  AgentMemoryChangesStatus,
  AgentMemoryExportResponse,
  AgentMemoryFactCategory,
  AgentMemoryFactOrigin,
  AgentMemoryFactResponse,
  AgentMemoryFactSensitivity,
  AgentMemoryFactSlots,
  AgentMemoryFactStatus,
  AgentMemoryMode,
  AgentMemoryResponse,
  AgentMemorySettingsResponse,
} from '../../../integrations/agent-api'

/**
 * Memory DTOs are core-internal types. The agent's own shapes (`AgentMemory*Response`) are not
 * exposed: their fields can change with its version, while the application contract cannot change
 * without shipping new mobile builds. Fields are listed by name, so nothing new slips through.
 *
 * A fact's `text` and `slots` are the person's words about themselves: they go to the person and
 * nowhere else, never into a log.
 */

export interface MemoryFactSlotsDTO {
  address?: string
  form?: 'ty' | 'vy'
  length?: 'short' | 'normal'
  advice?: 'ask_first' | 'ok'
  tone?: 'soft' | 'direct'
  role?: string
  name?: string
  note?: string
}

export interface MemoryFactSourceDTO {
  dialogId: string
  /** `YYYY-MM-DD`. */
  date: string
}

export interface MemoryFactDTO {
  id: string
  category: AgentMemoryFactCategory
  text: string
  slots: MemoryFactSlotsDTO | null
  importance: number
  confidence: number
  status: AgentMemoryFactStatus
  origin: AgentMemoryFactOrigin
  sensitivity: AgentMemoryFactSensitivity
  sources: MemoryFactSourceDTO[]
  createdAt: Date
  updatedAt: Date
  lastConfirmedAt: Date | null
  expiresAt: Date | null
  confirmCount: number
  seenByUser: boolean
}

export interface MemoryDTO {
  available: boolean
  mode: AgentMemoryMode
  enabled: boolean
  consentVersion: string | null
  consentAt: Date | null
  rulesVersion: string
  maxFacts: number
  facts: MemoryFactDTO[]
}

export interface MemorySettingsDTO {
  enabled: boolean
  consentVersion: string | null
  consentAt: Date | null
}

export interface MemoryChangeDTO {
  op: AgentMemoryChangeOp
  fact: MemoryFactDTO
}

export interface MemoryChangesDTO {
  status: AgentMemoryChangesStatus
  reason: string | null
  items: MemoryChangeDTO[]
}

export interface MemoryEventDTO {
  factId: string | null
  op: string
  actor: string
  dialogId: string | null
  at: Date
}

export interface MemoryExportDTO {
  exportedAt: Date
  rulesVersion: string
  settings: {
    enabled: boolean
    consentVersion: string | null
    consentAt: Date | null
    epochAt: Date | null
    updatedAt: Date | null
  }
  facts: MemoryFactDTO[]
  events: MemoryEventDTO[]
}

function toDate(value: string | null | undefined): Date | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function toSlotsDTO(slots: AgentMemoryFactSlots | null): MemoryFactSlotsDTO | null {
  if (!slots) return null
  const dto: MemoryFactSlotsDTO = {}
  if (slots.address !== undefined) dto.address = slots.address
  if (slots.form !== undefined) dto.form = slots.form
  if (slots.length !== undefined) dto.length = slots.length
  if (slots.advice !== undefined) dto.advice = slots.advice
  if (slots.tone !== undefined) dto.tone = slots.tone
  if (slots.role !== undefined) dto.role = slots.role
  if (slots.name !== undefined) dto.name = slots.name
  if (slots.note !== undefined) dto.note = slots.note
  return dto
}

export function toMemoryFactDTO(fact: AgentMemoryFactResponse): MemoryFactDTO {
  return {
    id: fact.id,
    category: fact.category,
    text: fact.text,
    slots: toSlotsDTO(fact.slots),
    importance: fact.importance,
    confidence: fact.confidence,
    status: fact.status,
    origin: fact.origin,
    sensitivity: fact.sensitivity,
    sources: fact.sources.map((source) => ({ dialogId: source.dialogId, date: source.date })),
    // The agent writes ISO strings; an unusable date is not replaced with "now", let it show.
    createdAt: toDate(fact.createdAt) ?? new Date(0),
    updatedAt: toDate(fact.updatedAt) ?? new Date(0),
    lastConfirmedAt: toDate(fact.lastConfirmedAt),
    expiresAt: toDate(fact.expiresAt),
    confirmCount: fact.confirmCount,
    seenByUser: fact.seenByUser,
  }
}

/**
 * The agent on Cognee has no limit of facts and says `maxFacts: null`; the apps' contract wants a
 * number (cached PWAs read it), so the missing limit is shown as this one.
 */
const DEFAULT_MAX_FACTS = 200

export function toMemoryDTO(memory: AgentMemoryResponse): MemoryDTO {
  return {
    available: memory.available,
    mode: memory.mode,
    enabled: memory.enabled,
    consentVersion: memory.consentVersion,
    consentAt: toDate(memory.consentAt),
    rulesVersion: memory.rulesVersion,
    maxFacts: memory.limits.maxFacts ?? DEFAULT_MAX_FACTS,
    facts: memory.facts.map(toMemoryFactDTO),
  }
}

export function toMemorySettingsDTO(settings: AgentMemorySettingsResponse): MemorySettingsDTO {
  return {
    enabled: settings.enabled,
    consentVersion: settings.consentVersion,
    consentAt: toDate(settings.consentAt),
  }
}

export function toMemoryChangesDTO(changes: AgentMemoryChangesResponse): MemoryChangesDTO {
  return {
    status: changes.status,
    reason: changes.reason,
    items: changes.items.map((item) => ({ op: item.op, fact: toMemoryFactDTO(item.fact) })),
  }
}

export function toMemoryExportDTO(exported: AgentMemoryExportResponse): MemoryExportDTO {
  return {
    exportedAt: toDate(exported.exportedAt) ?? new Date(0),
    rulesVersion: exported.rulesVersion,
    settings: {
      enabled: exported.settings.enabled,
      consentVersion: exported.settings.consentVersion,
      consentAt: toDate(exported.settings.consentAt),
      epochAt: toDate(exported.settings.epochAt),
      updatedAt: toDate(exported.settings.updatedAt),
    },
    facts: exported.facts.map(toMemoryFactDTO),
    events: exported.events.map((event) => ({
      factId: event.factId,
      op: event.op,
      actor: event.actor,
      dialogId: event.dialogId,
      at: toDate(event.at) ?? new Date(0),
    })),
  }
}
