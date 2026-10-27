import { z } from 'zod'
import { createLogger } from '../../../shared'
import {
  AGENT_MEMORY_CHANGE_OPS,
  AGENT_MEMORY_CHANGES_STATUSES,
  AGENT_MEMORY_FACT_CATEGORIES,
  AGENT_MEMORY_FACT_ORIGINS,
  AGENT_MEMORY_FACT_SENSITIVITIES,
  AGENT_MEMORY_FACT_STATUSES,
  type AgentMemoryChangesResponse,
  type AgentMemoryExportResponse,
  type AgentMemoryFactResponse,
  type AgentMemoryNoteResponse,
  type AgentMemoryResponse,
  type AgentMemorySettingsResponse,
} from './agent-memory.types'

/**
 * The shape of the agent's memory answers, checked before anything leaves the integration: the
 * apps show these facts, and a field the agent renamed must not turn into `undefined` on a screen.
 *
 * A fact that does not hold up is left out and logged by its id and the failing fields, never by
 * its content; a malformed answer as a whole is thrown. Unknown fields are dropped, so nothing the
 * agent adds reaches the apps without being named here first.
 */

const nullableString = z.string().nullable().catch(null)

const slotsSchema = z.object({
  address: z.string().optional().catch(undefined),
  form: z.enum(['ty', 'vy']).optional().catch(undefined),
  length: z.enum(['short', 'normal']).optional().catch(undefined),
  advice: z.enum(['ask_first', 'ok']).optional().catch(undefined),
  tone: z.enum(['soft', 'direct']).optional().catch(undefined),
  role: z.string().optional().catch(undefined),
  name: z.string().optional().catch(undefined),
  note: z.string().optional().catch(undefined),
})

const factSchema = z.object({
  id: z.string().min(1),
  category: z.enum(AGENT_MEMORY_FACT_CATEGORIES),
  text: z.string(),
  slots: slotsSchema.nullable().catch(null),
  importance: z.number(),
  confidence: z.number(),
  status: z.enum(AGENT_MEMORY_FACT_STATUSES),
  origin: z.enum(AGENT_MEMORY_FACT_ORIGINS),
  sensitivity: z.enum(AGENT_MEMORY_FACT_SENSITIVITIES).catch('normal'),
  sources: z.array(z.object({ dialogId: z.string(), date: z.string() })).catch([]),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastConfirmedAt: nullableString,
  expiresAt: nullableString,
  confirmCount: z.number().catch(0),
  seenByUser: z.boolean().catch(false),
})

function fieldsOf(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.map(String).join('.') || '(root)'}:${issue.code}`)
}

/** One fact, or null when it does not hold up (logged without its content). */
export function parseAgentFact(raw: unknown): AgentMemoryFactResponse | null {
  const parsed = factSchema.safeParse(raw)
  if (parsed.success) {
    const { slots, ...fact } = parsed.data
    return { ...fact, slots: slots === null ? null : withoutEmpty(slots) }
  }
  const id = typeof raw === 'object' && raw !== null ? (raw as { id?: unknown }).id : undefined
  createLogger('agent-api').warn('Agent API returned a malformed memory fact, left out', undefined, {
    factId: typeof id === 'string' ? id : null,
    fields: fieldsOf(parsed.error),
  })
  return null
}

function withoutEmpty<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T
}

function parseFacts(raw: unknown[]): AgentMemoryFactResponse[] {
  return raw.map(parseAgentFact).filter((fact): fact is AgentMemoryFactResponse => fact !== null)
}

function parseOrThrow<S extends z.ZodType>(schema: S, body: unknown, what: string): z.infer<S> {
  const parsed = schema.safeParse(body)
  if (!parsed.success)
    throw new Error(`Agent API returned a malformed ${what}: ${fieldsOf(parsed.error).join(', ')}`)
  return parsed.data
}

const noteSchema = z.object({
  id: z.string().min(1),
  kind: z.string(),
  text: z.string(),
  sensitive: z.boolean().catch(false),
  eventDate: nullableString,
  createdAt: z.string(),
  updatedAt: z.string(),
  dialogId: nullableString,
})

/** The notes the agent gave; one that does not hold up is left out (logged by its id), like a fact. */
export function parseNotesList(raw: unknown[]): AgentMemoryNoteResponse[] {
  return parseNotes(raw)
}

function parseNotes(raw: unknown[]): AgentMemoryNoteResponse[] {
  const notes: AgentMemoryNoteResponse[] = []
  for (const item of raw) {
    const parsed = noteSchema.safeParse(item)
    if (parsed.success) notes.push(parsed.data)
    else {
      const id = typeof item === 'object' && item !== null ? (item as { id?: unknown }).id : undefined
      createLogger('agent-api').warn('Agent API returned a malformed memory note, left out', undefined, {
        noteId: typeof id === 'string' ? id : null,
        fields: fieldsOf(parsed.error),
      })
    }
  }
  return notes
}

const memorySchema = z.object({
  available: z.boolean(),
  enabled: z.boolean(),
  consentVersion: nullableString,
  consentAt: nullableString,
  rulesVersion: z.string().catch(''),
  limits: z.object({
    maxFacts: z.number().nullable(),
    maxNotes: z.number().nullable().catch(null),
  }),
  // An older agent (before notes) has none of these: pause follows `enabled`, the switches take their defaults.
  paused: z.boolean().optional(),
  sensitiveEnabled: z.boolean().catch(false),
  chatSearchEnabled: z.boolean().catch(true),
  notes: z.array(z.unknown()).catch([]),
  facts: z.array(z.unknown()),
})

export function parseAgentMemory(body: unknown): AgentMemoryResponse {
  const { paused, notes, ...memory } = parseOrThrow(memorySchema, body, 'memory')
  return { ...memory, paused: paused ?? !memory.enabled, notes: parseNotes(notes), facts: parseFacts(memory.facts) }
}

const settingsSchema = z.object({
  enabled: z.boolean(),
  sensitiveEnabled: z.boolean().catch(false),
  chatSearchEnabled: z.boolean().catch(true),
  consentVersion: nullableString,
  consentAt: nullableString,
})

export function parseAgentMemorySettings(body: unknown): AgentMemorySettingsResponse {
  return parseOrThrow(settingsSchema, body, 'memory settings answer')
}

export function parseAgentMemoryFactOrThrow(body: unknown): AgentMemoryFactResponse {
  const fact = parseAgentFact(body)
  if (!fact) throw new Error('Agent API returned a malformed memory fact')
  return fact
}

const changesSchema = z.object({
  status: z.enum(AGENT_MEMORY_CHANGES_STATUSES),
  reason: nullableString,
  items: z.array(z.object({ op: z.enum(AGENT_MEMORY_CHANGE_OPS), fact: z.unknown() })).catch([]),
})

export function parseAgentMemoryChanges(body: unknown): AgentMemoryChangesResponse {
  const changes = parseOrThrow(changesSchema, body, 'memory changes answer')
  const items: AgentMemoryChangesResponse['items'] = []
  for (const item of changes.items) {
    const fact = parseAgentFact(item.fact)
    if (fact) items.push({ op: item.op, fact })
  }
  return { status: changes.status, reason: changes.reason, items }
}

const exportSchema = z.object({
  exportedAt: z.string(),
  rulesVersion: z.string().catch(''),
  settings: z.object({
    enabled: z.boolean(),
    consentVersion: nullableString,
    consentAt: nullableString,
    epochAt: nullableString,
    updatedAt: nullableString,
  }),
  notes: z.array(z.unknown()).catch([]),
  facts: z.array(z.unknown()),
  events: z
    .array(
      z.object({
        factId: nullableString,
        op: z.string(),
        actor: z.string(),
        dialogId: nullableString,
        at: z.string(),
      }),
    )
    .catch([]),
})

export function parseAgentMemoryExport(body: unknown): AgentMemoryExportResponse {
  const exported = parseOrThrow(exportSchema, body, 'memory export')
  const { notes, ...rest } = exported
  return { ...rest, notes: parseNotes(notes), facts: parseFacts(exported.facts) }
}

/**
 * `details.reason` of `FACT_REJECTED`: a code of the rule that refused the fact (`contact_pii`,
 * `diagnosis`...). Only something that looks like a code is kept, so that no text of the fact can
 * ride along into a log or an answer.
 */
export function rejectionReasonOf(details: unknown): string | null {
  if (typeof details !== 'object' || details === null) return null
  const reason = (details as { reason?: unknown }).reason
  return typeof reason === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(reason) ? reason : null
}
