/**
 * Memory: what the agent remembers about the person between conversations, so that support does
 * not start from zero every time (who matters to them, what is going on, what helps, how to talk to
 * them and what not to bring up).
 *
 * Memory is opt-in: it stays off until the person turns it on after a separate consent sheet
 * (`PUT /api/memory/settings`). Everything remembered is visible here and can be corrected, pinned,
 * forgotten one by one or all at once, and downloaded. A single conversation can be held "without
 * memory" (`memory: 'off'` in `POST /api/dialogs`). Reading, exporting and forgetting work even
 * while memory is off or unavailable.
 *
 * The facts are the person's own words about themselves, so the server never puts their text into
 * logs or analytics, and neither may the clients.
 */

/**
 * The version of the memory consent text the apps show: the date it came into force. The server
 * records the version a person accepted; a new text means a new date, and the person is asked again
 * the next time they turn memory on.
 */
export const MEMORY_CONSENT_VERSION = '2026-10-12'

/** Whether the memory feature works on the server at all (not the person's own switch). */
export enum MemoryServiceMode {
  Off = 'off',
  /** Facts are extracted for people who turned memory on, but the agent does not use them yet. */
  Shadow = 'shadow',
  On = 'on',
}

/** Memory for one conversation: `off` is a conversation "without memory", deleted 24 hours after its last message. */
export enum DialogMemoryMode {
  On = 'on',
  Off = 'off',
}

export enum MemoryFactCategory {
  /** How to address the person and talk to them. Built from `slots`, never free text. */
  Style = 'style',
  /** What not to bring up. */
  Boundary = 'boundary',
  /** People close to them. */
  Person = 'person',
  /** Current circumstances. */
  Situation = 'situation',
  /** Plans and goals. */
  Goal = 'goal',
  /** What helps and what does not. */
  Works = 'works',
  /** Interests and pleasant things. */
  Interest = 'interest',
  /** A retelling of the latest conversation; there is one at a time. */
  Recap = 'recap',
}

export enum MemoryFactStatus {
  /** An indirect guess: not used until a second conversation or the person confirms it. */
  Candidate = 'candidate',
  /** Waits for the person's "Remember" (sensitive, or it contradicts their own edit). */
  Proposed = 'proposed',
  Active = 'active',
  /** Pinned or written by the person: the agent never overwrites it. */
  Pinned = 'pinned',
  /** Outlived its term or was replaced; hidden from the person and erased after 30 days. */
  Expired = 'expired',
}

export enum MemoryFactOrigin {
  Auto = 'auto',
  /** The person asked "remember that…". */
  UserSaid = 'user_said',
  /** The person wrote or corrected it here. */
  UserEdit = 'user_edit',
}

export enum MemoryFactSensitivity {
  Normal = 'normal',
  Sensitive = 'sensitive',
}

export interface MemoryStyleSlots {
  /** How to call the person, up to 30 characters. */
  address?: string
  form?: 'ty' | 'vy'
  length?: 'short' | 'normal'
  advice?: 'ask_first' | 'ok'
  tone?: 'soft' | 'direct'
}

export interface MemoryPersonSlots {
  /** From the server's list of roles: мама, сестра, друг, коллега… */
  role: string
  /** One capitalised word, up to 20 characters. */
  name?: string
  /** Up to 60 characters. */
  note?: string
}

export type MemoryFactSlots = MemoryStyleSlots | MemoryPersonSlots

export interface MemoryFactSourceApiResponse {
  dialogId: string
  /** The day of the conversation, `YYYY-MM-DD`. */
  date: string
}

export interface MemoryFactApiResponse {
  id: string
  category: MemoryFactCategory
  /** What the person reads on the card, up to 200 characters. For `style` and `person` the server builds it from `slots`. */
  text: string
  /** Only for `style` and `person`; null otherwise. */
  slots: MemoryFactSlots | null
  /** 1 to 5. */
  importance: number
  /** 0 to 1. */
  confidence: number
  status: MemoryFactStatus
  origin: MemoryFactOrigin
  sensitivity: MemoryFactSensitivity
  /** The conversations it came from: "from the conversation of 12 Oct". */
  sources: MemoryFactSourceApiResponse[]
  /** ISO 8601. */
  createdAt: string
  updatedAt: string
  lastConfirmedAt: string | null
  /** ISO 8601; null means no term. */
  expiresAt: string | null
  confirmCount: number
  seenByUser: boolean
}

// ─── GET /api/memory ──────────────────────────────────────────────────────────

export interface MemoryApiResponse {
  /** The feature works on the server right now. False: show "unavailable" and keep "forget all" and the download. */
  available: boolean
  mode: MemoryServiceMode
  /** The person's own switch "Remember". */
  enabled: boolean
  /** The consent version the person accepted last; null if never. */
  consentVersion: string | null
  /** ISO 8601. */
  consentAt: string | null
  /** The version of the server's rules of what may be remembered. */
  rulesVersion: string
  limits: { maxFacts: number }
  /** Every fact except expired ones, ordered by category and then by weight. */
  facts: MemoryFactApiResponse[]
}

export enum GetMemoryApiErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
}

// ─── PUT /api/memory/settings ─────────────────────────────────────────────────

export interface UpdateMemorySettingsApiRequest {
  enabled: boolean
  /** Required with `enabled: true`: the person accepted the consent sheet just now. */
  consentAccepted?: boolean
  /** Required with `enabled: true`: the version of the sheet on the screen (`MEMORY_CONSENT_VERSION`). */
  consentVersion?: string
}

export interface UpdateMemorySettingsApiResponse {
  enabled: boolean
  consentVersion: string | null
  /** ISO 8601. */
  consentAt: string | null
}

export enum UpdateMemorySettingsApiErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  /** Turning on without `consentAccepted: true` and a version. */
  CONSENT_REQUIRED = 'CONSENT_REQUIRED',
  /** Memory is switched off on the server; the person cannot turn it on now. */
  MEMORY_UNAVAILABLE = 'MEMORY_UNAVAILABLE',
  /** A closed beta, and this person is not in it. */
  MEMORY_NOT_ALLOWED = 'MEMORY_NOT_ALLOWED',
}

// ─── POST /api/memory/facts, PATCH and DELETE /api/memory/facts/:id ──────────

/**
 * The person writes a fact themselves. `style` and `person` take only `slots` (the server builds their text: "Сестра Аня:
 * поддерживает"); the other categories take only `text`.
 */
export interface CreateMemoryFactApiRequest {
  category: MemoryFactCategory
  text?: string
  slots?: MemoryFactSlots
}

export enum CreateMemoryFactApiErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  /** The person's memory is off: turn it on first. */
  MEMORY_DISABLED = 'MEMORY_DISABLED',
  /** 60 facts already, and none can make room. */
  MEMORY_FULL = 'MEMORY_FULL',
  /** The server's rules do not allow remembering this (a diagnosis, a phone number, an instruction to the agent…). */
  FACT_REJECTED = 'FACT_REJECTED',
  MEMORY_UNAVAILABLE = 'MEMORY_UNAVAILABLE',
}

/**
 * One change at a time: `text`/`slots` correct the fact (it becomes the person's and pinned), `status`
 * accepts a proposed one ("Remember", `active`) or pins and unpins, `confirm` says "Right".
 */
export interface UpdateMemoryFactApiRequest {
  text?: string
  slots?: MemoryFactSlots
  status?: MemoryFactStatus.Active | MemoryFactStatus.Pinned
  confirm?: true
}

export enum UpdateMemoryFactApiErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  MEMORY_DISABLED = 'MEMORY_DISABLED',
  /** No such fact of this person (or it was forgotten already). */
  FACT_NOT_FOUND = 'FACT_NOT_FOUND',
  FACT_REJECTED = 'FACT_REJECTED',
  MEMORY_UNAVAILABLE = 'MEMORY_UNAVAILABLE',
}

/** `DELETE /api/memory/facts/:id` ("Forget", or "Don't remember" on a proposed one) and `DELETE /api/memory` ("Forget everything"): `result: null`, repeats succeed. */
export enum ForgetMemoryApiErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  MEMORY_UNAVAILABLE = 'MEMORY_UNAVAILABLE',
  /** `DELETE /api/memory/facts/:id` only: the agent cannot forget a single fact; "Forget everything" works. */
  FACT_UNSUPPORTED = 'FACT_UNSUPPORTED',
}

// ─── GET /api/memory/changes?dialogId= ────────────────────────────────────────

export enum MemoryChangesStatus {
  /** Extraction has not finished yet: ask again in a few seconds. */
  Pending = 'pending',
  Ready = 'ready',
  /** Nothing was extracted from this conversation (too short, memory off…): show nothing. */
  Skipped = 'skipped',
}

export enum MemoryChangeOp {
  Add = 'add',
  Update = 'update',
  Confirm = 'confirm',
  Supersede = 'supersede',
}

export interface MemoryChangeApiResponse {
  op: MemoryChangeOp
  /** The fact as it is now. */
  fact: MemoryFactApiResponse
}

/** What the conversation added to memory: the "I remembered" card after it. */
export interface MemoryChangesApiResponse {
  status: MemoryChangesStatus
  /** Why it was skipped; for the logs, the person is shown nothing. */
  reason: string | null
  items: MemoryChangeApiResponse[]
}

export enum MemoryChangesApiErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  DIALOG_NOT_FOUND = 'DIALOG_NOT_FOUND',
}

// ─── GET /api/memory/export ───────────────────────────────────────────────────

/** "Download my memory": everything, including guesses and proposed facts, as JSON. The shape belongs to the agent. */
export interface MemoryExportApiResponse {
  exportedAt: string
  rulesVersion: string
  settings: {
    enabled: boolean
    consentVersion: string | null
    consentAt: string | null
    epochAt: string | null
    updatedAt: string | null
  }
  facts: MemoryFactApiResponse[]
  /** The history of changes, without texts. */
  events: { factId: string | null; op: string; actor: string; dialogId: string | null; at: string }[]
}
