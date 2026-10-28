import type {
  AgentMemoryChangeOp,
  AgentMemoryChangesResponse,
  AgentMemoryChangesStatus,
  AgentMemoryExportResponse,
  AgentMemoryFactCategory,
  AgentMemoryFactOrigin,
  AgentMemoryFactResponse,
  AgentMemoryNoteResponse,
  AgentMemoryFactSensitivity,
  AgentMemoryFactSlots,
  AgentMemoryFactStatus,
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
  expiresAt: Date | null
  seenByUser: boolean
}

export interface MemoryNoteDTO {
  id: string
  kind: string
  text: string
  sensitive: boolean
  eventDate: string | null
  createdAt: Date
  updatedAt: Date
  dialogId: string | null
}

export interface MemoryDTO {
  available: boolean
  enabled: boolean
  consentVersion: string | null
  consentAt: Date | null
  rulesVersion: string
  maxFacts: number
  maxNotes: number
  paused: boolean
  sensitiveEnabled: boolean
  chatSearchEnabled: boolean
  notes: MemoryNoteDTO[]
  facts: MemoryFactDTO[]
}

export interface MemorySettingsDTO {
  enabled: boolean
  sensitiveEnabled: boolean
  chatSearchEnabled: boolean
  consentVersion: string | null
  consentAt: Date | null
}

export interface MemoryChangeDTO {
  op: AgentMemoryChangeOp
  fact: MemoryFactDTO
}

export interface MemoryChangesDTO {
  /** What the app is told: `skipped` of an older agent is already an empty `ready` here. */
  status: Exclude<AgentMemoryChangesStatus, 'skipped'>
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
  notes: MemoryNoteDTO[]
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
    expiresAt: toDate(fact.expiresAt),
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
    enabled: memory.enabled,
    consentVersion: memory.consentVersion,
    consentAt: toDate(memory.consentAt),
    rulesVersion: memory.rulesVersion,
    maxFacts: memory.limits.maxFacts ?? DEFAULT_MAX_FACTS,
    maxNotes: memory.limits.maxNotes ?? DEFAULT_MAX_FACTS,
    paused: memory.paused,
    sensitiveEnabled: memory.sensitiveEnabled,
    chatSearchEnabled: memory.chatSearchEnabled,
    notes: memory.notes.map(toMemoryNoteDTO),
    facts: memory.facts.map(toMemoryFactDTO),
  }
}

export function toMemoryNoteDTO(note: AgentMemoryNoteResponse): MemoryNoteDTO {
  return {
    id: note.id,
    kind: note.kind,
    text: note.text,
    sensitive: note.sensitive,
    eventDate: note.eventDate,
    createdAt: toDate(note.createdAt) ?? new Date(0),
    updatedAt: toDate(note.updatedAt) ?? new Date(0),
    dialogId: note.dialogId,
  }
}

export function toMemorySettingsDTO(settings: AgentMemorySettingsResponse): MemorySettingsDTO {
  return {
    enabled: settings.enabled,
    sensitiveEnabled: settings.sensitiveEnabled,
    chatSearchEnabled: settings.chatSearchEnabled,
    consentVersion: settings.consentVersion,
    consentAt: toDate(settings.consentAt),
  }
}

export function toMemoryChangesDTO(changes: AgentMemoryChangesResponse): MemoryChangesDTO {
  // Tolerance for an agent older than this gateway: its `skipped` means there is nothing to list, which is an empty `ready`.
  if (changes.status === 'skipped') return { status: 'ready', reason: changes.reason, items: [] }
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
    notes: exported.notes.map(toMemoryNoteDTO),
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
