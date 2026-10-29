import type { SessionDTO } from '@ryadom/core/managers/refresh-tokens-manager'
import type { UserDTO } from '@ryadom/core/processes/authentication'
import type { ConsentStatusDTO } from '@ryadom/core/processes/consents'
import type {
  DialogDTO,
  DialogListItemDTO,
  DialogRecapItemDTO,
  DialogSummaryDTO,
} from '@ryadom/core/processes/dialogs'
import type {
  MemoryChangesDTO,
  MemoryDTO,
  MemoryExportDTO,
  MemoryFactDTO,
  MemoryFactSlotsDTO,
  MemoryInstructionChangesDTO,
  MemoryNoteDTO,
  MemorySettingsDTO,
} from '@ryadom/core/processes/memory'
import { describeUserAgent } from '@ryadom/core/shared'
import type { MeApiResponse } from '@ryadom/contracts/api/auth/me'
import { DEFAULT_VOICE_ID, type VoicePipeline } from '@ryadom/contracts/voices'
import { SessionClient, type SessionApiResponse } from '@ryadom/contracts/api/auth/sessions'
import type { AuthUserApiResponse } from '@ryadom/contracts/api/auth/shared'
import {
  DialogMode,
  type DialogApiResponse,
  type DialogListItemApiResponse,
  type DialogRecapItemApiResponse,
  type DialogSummaryApiResponse,
} from '@ryadom/contracts/api/dialogs'
import {
  DialogMemoryMode,
  MemoryChangeOp,
  MemoryChangesStatus,
  MemoryFactCategory,
  MemoryNoteApiResponse,
  MemoryNoteKind,
  MemoryFactOrigin,
  MemoryFactSensitivity,
  MemoryFactStatus,
  type MemoryApiResponse,
  type MemoryChangesApiResponse,
  type MemoryExportApiResponse,
  type MemoryFactApiResponse,
  type MemoryFactSlots,
  type MemoryInstructionApiResponse,
  type UpdateMemorySettingsApiResponse,
} from '@ryadom/contracts/api/memory'

/**
 * Mappers from core DTOs to route responses. Core DTOs never leave the server and
 * fields are listed by name, so a new field in the core does not reach the app on its own.
 */

export function toAuthUser(user: UserDTO): AuthUserApiResponse {
  return { id: user.id, email: user.email, name: user.name, telegramLinked: user.telegramId !== null }
}

export function toMe(user: UserDTO, consent: ConsentStatusDTO, voicePipeline: VoicePipeline): MeApiResponse {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    isEmailConfirmed: user.isEmailConfirmed,
    telegramLinked: user.telegramId !== null,
    createdAt: user.createdAt.toISOString(),
    consentsCompleted: consent.completed,
    consentVersion: consent.offerVersion,
    voice: user.agentVoice,
    voiceName: user.agentVoiceName ?? DEFAULT_VOICE_ID[user.agentVoice],
    voicePipeline,
    analyticsOptOut: user.analyticsOptOut,
    timezone: user.timezone,
  }
}

/** What the clients put in `x-client-id` (`ryadom-web`, `ryadom-pwa`, `ryadom-telegram`, `ryadom-android`, `ryadom-ios`). */
const SESSION_CLIENTS: Record<string, SessionClient> = {
  'ryadom-web': SessionClient.Web,
  'ryadom-pwa': SessionClient.Pwa,
  'ryadom-telegram': SessionClient.Telegram,
  'ryadom-android': SessionClient.Android,
  'ryadom-ios': SessionClient.Ios,
}

export function toSession(session: SessionDTO, currentSessionId: string | null): SessionApiResponse {
  const { browser, os } = describeUserAgent(session.userAgent)
  return {
    id: session.sessionId,
    current: session.sessionId === currentSessionId,
    // Own property only: a client id of "constructor" must not find a function on the prototype.
    client:
      session.clientId !== null && Object.hasOwn(SESSION_CLIENTS, session.clientId)
        ? SESSION_CLIENTS[session.clientId]!
        : null,
    browser,
    os,
    startedAt: session.startedAt.toISOString(),
    lastUsedAt: session.lastUsedAt.toISOString(),
  }
}

export function toDialogSummary(summary: DialogSummaryDTO | null): DialogSummaryApiResponse | null {
  if (!summary) return null
  return {
    title: summary.title,
    themes: summary.themes,
    tensionBefore: summary.tensionBefore,
    tensionAfter: summary.tensionAfter,
    recap: summary.recap,
    recapStatus: summary.recapStatus,
    recapSource: summary.recapSource,
    ...(summary.recapAvailable === null ? {} : { recapAvailable: summary.recapAvailable }),
  }
}

export function toRecapItem(item: DialogRecapItemDTO): DialogRecapItemApiResponse {
  return {
    dialogId: item.dialogId,
    startedAt: item.startedAt.toISOString(),
    title: item.title,
    recap: item.recap,
    recapSource: item.recapSource,
  }
}

export function toDialogListItem(item: DialogListItemDTO): DialogListItemApiResponse {
  return {
    dialogId: item.dialogId,
    // The agent has no modes yet and the field of the app contract is stable: every conversation is a vent.
    mode: DialogMode.Vent,
    startedAt: item.startedAt.toISOString(),
    endedAt: item.endedAt?.toISOString() ?? null,
    summary: toDialogSummary(item.summary),
    memoryMode: toDialogMemoryMode(item.memoryMode),
    saved: item.saved,
  }
}

export function toDialog(dialog: DialogDTO): DialogApiResponse {
  return {
    ...toDialogListItem(dialog),
    messages: dialog.messages.map((message) => ({
      id: message.id,
      role: message.role,
      text: message.text,
      createdAt: message.createdAt.toISOString(),
      // Nothing marks a message as a crisis any more: the screen only ever got the SOS frame for it.
      safetyLevel: null,
    })),
  }
}

// ─── Memory ───────────────────────────────────────────────────────────────────
//
// The core and the contract spell the same values, one as strings and the other as enums. Each
// table names every value of the core's side, so a value the core gains breaks the build here
// instead of reaching the apps unannounced. Facts go to their owner only: no mapper here is used
// for a log, analytics or the admin panel.

const DIALOG_MEMORY_MODES: Record<DialogListItemDTO['memoryMode'], DialogMemoryMode> = {
  on: DialogMemoryMode.On,
  off: DialogMemoryMode.Off,
}

const MEMORY_FACT_CATEGORIES: Record<MemoryFactDTO['category'], MemoryFactCategory> = {
  style: MemoryFactCategory.Style,
  boundary: MemoryFactCategory.Boundary,
  person: MemoryFactCategory.Person,
  situation: MemoryFactCategory.Situation,
  goal: MemoryFactCategory.Goal,
  works: MemoryFactCategory.Works,
  interest: MemoryFactCategory.Interest,
  recap: MemoryFactCategory.Recap,
}

const MEMORY_FACT_STATUSES: Record<MemoryFactDTO['status'], MemoryFactStatus> = {
  candidate: MemoryFactStatus.Candidate,
  proposed: MemoryFactStatus.Proposed,
  active: MemoryFactStatus.Active,
  expired: MemoryFactStatus.Expired,
}

const MEMORY_NOTE_KINDS: Record<string, MemoryNoteKind> = Object.fromEntries(
  Object.values(MemoryNoteKind).map((kind) => [kind, kind]),
)

const MEMORY_FACT_ORIGINS: Record<MemoryFactDTO['origin'], MemoryFactOrigin> = {
  auto: MemoryFactOrigin.Auto,
  user_said: MemoryFactOrigin.UserSaid,
  user_edit: MemoryFactOrigin.UserEdit,
}

const MEMORY_FACT_SENSITIVITIES: Record<MemoryFactDTO['sensitivity'], MemoryFactSensitivity> = {
  normal: MemoryFactSensitivity.Normal,
  sensitive: MemoryFactSensitivity.Sensitive,
}

const MEMORY_CHANGES_STATUSES: Record<MemoryChangesDTO['status'], MemoryChangesStatus> = {
  pending: MemoryChangesStatus.Pending,
  ready: MemoryChangesStatus.Ready,
}

const MEMORY_CHANGE_OPS: Record<MemoryChangesDTO['items'][number]['op'], MemoryChangeOp> = {
  add: MemoryChangeOp.Add,
  update: MemoryChangeOp.Update,
  confirm: MemoryChangeOp.Confirm,
  supersede: MemoryChangeOp.Supersede,
}

/** The other way: what the app sent, as the core spells it. */
function inverse<K extends string, V extends string>(table: Record<K, V>): Record<V, K> {
  return Object.fromEntries(Object.entries(table).map(([key, value]) => [value, key])) as Record<V, K>
}

const CORE_DIALOG_MEMORY_MODES = inverse(DIALOG_MEMORY_MODES)
const CORE_MEMORY_FACT_CATEGORIES = inverse(MEMORY_FACT_CATEGORIES)

export function toDialogMemoryMode(mode: DialogListItemDTO['memoryMode']): DialogMemoryMode {
  return DIALOG_MEMORY_MODES[mode]
}

export function fromDialogMemoryMode(mode: DialogMemoryMode): DialogListItemDTO['memoryMode'] {
  return CORE_DIALOG_MEMORY_MODES[mode]
}

export function fromMemoryFactCategory(category: MemoryFactCategory): MemoryFactDTO['category'] {
  return CORE_MEMORY_FACT_CATEGORIES[category]
}

/** `style` keeps its five slots, `person` its three (and only with a role); other categories have none. */
function toMemoryFactSlots(
  category: MemoryFactDTO['category'],
  slots: MemoryFactSlotsDTO | null,
): MemoryFactSlots | null {
  if (!slots) return null
  if (category === 'style') {
    const style: MemoryFactSlots = {}
    if (slots.address !== undefined) style.address = slots.address
    if (slots.form !== undefined) style.form = slots.form
    if (slots.length !== undefined) style.length = slots.length
    if (slots.advice !== undefined) style.advice = slots.advice
    if (slots.tone !== undefined) style.tone = slots.tone
    return style
  }
  if (category === 'person' && slots.role !== undefined) {
    return {
      role: slots.role,
      ...(slots.name !== undefined ? { name: slots.name } : {}),
      ...(slots.note !== undefined ? { note: slots.note } : {}),
    }
  }
  return null
}

export function toMemoryFact(fact: MemoryFactDTO): MemoryFactApiResponse {
  return {
    id: fact.id,
    category: MEMORY_FACT_CATEGORIES[fact.category],
    text: fact.text,
    slots: toMemoryFactSlots(fact.category, fact.slots),
    importance: fact.importance,
    confidence: fact.confidence,
    status: MEMORY_FACT_STATUSES[fact.status],
    origin: MEMORY_FACT_ORIGINS[fact.origin],
    sensitivity: MEMORY_FACT_SENSITIVITIES[fact.sensitivity],
    sources: fact.sources.map((source) => ({ dialogId: source.dialogId, date: source.date })),
    createdAt: fact.createdAt.toISOString(),
    updatedAt: fact.updatedAt.toISOString(),
    expiresAt: fact.expiresAt?.toISOString() ?? null,
    seenByUser: fact.seenByUser,
  }
}

export function toMemory(memory: MemoryDTO): MemoryApiResponse {
  return {
    available: memory.available,
    mode: 'on', // kept for older clients, which read it
    enabled: memory.enabled,
    consentVersion: memory.consentVersion,
    consentAt: memory.consentAt?.toISOString() ?? null,
    rulesVersion: memory.rulesVersion,
    limits: { maxFacts: memory.maxFacts, maxNotes: memory.maxNotes },
    paused: memory.paused,
    sensitiveEnabled: memory.sensitiveEnabled,
    chatSearchEnabled: memory.chatSearchEnabled,
    notes: memory.notes.map(toMemoryNote),
    facts: memory.facts.map(toMemoryFact),
  }
}

function toMemoryNote(note: MemoryNoteDTO): MemoryNoteApiResponse {
  return {
    id: note.id,
    kind: MEMORY_NOTE_KINDS[note.kind] ?? MemoryNoteKind.Situation,
    text: note.text,
    sensitive: note.sensitive,
    eventDate: note.eventDate,
    createdAt: note.createdAt.toISOString(),
    updatedAt: note.updatedAt.toISOString(),
    dialogId: note.dialogId,
  }
}

export function toMemoryInstruction(changes: MemoryInstructionChangesDTO): MemoryInstructionApiResponse {
  return {
    added: changes.added.map(toMemoryNote),
    updated: changes.updated.map(toMemoryNote),
    deleted: changes.deleted,
    blocked: changes.blocked,
  }
}

export function toMemorySettings(settings: MemorySettingsDTO): UpdateMemorySettingsApiResponse {
  return {
    enabled: settings.enabled,
    sensitiveEnabled: settings.sensitiveEnabled,
    chatSearchEnabled: settings.chatSearchEnabled,
    consentVersion: settings.consentVersion,
    consentAt: settings.consentAt?.toISOString() ?? null,
  }
}

export function toMemoryChanges(changes: MemoryChangesDTO): MemoryChangesApiResponse {
  return {
    status: MEMORY_CHANGES_STATUSES[changes.status],
    reason: changes.reason,
    items: changes.items.map((item) => ({ op: MEMORY_CHANGE_OPS[item.op], fact: toMemoryFact(item.fact) })),
  }
}

export function toMemoryExport(exported: MemoryExportDTO): MemoryExportApiResponse {
  return {
    exportedAt: exported.exportedAt.toISOString(),
    rulesVersion: exported.rulesVersion,
    settings: {
      enabled: exported.settings.enabled,
      consentVersion: exported.settings.consentVersion,
      consentAt: exported.settings.consentAt?.toISOString() ?? null,
      epochAt: exported.settings.epochAt?.toISOString() ?? null,
      updatedAt: exported.settings.updatedAt?.toISOString() ?? null,
    },
    notes: exported.notes.map(toMemoryNote),
    facts: exported.facts.map(toMemoryFact),
    events: exported.events.map((event) => ({
      factId: event.factId,
      op: event.op,
      actor: event.actor,
      dialogId: event.dialogId,
      at: event.at.toISOString(),
    })),
  }
}
