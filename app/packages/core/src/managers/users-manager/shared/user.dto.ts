import type { AgentVoice, UserRow } from '@ryadom/db/schema'

export interface UserDTO {
  id: string
  /** null for an anonymous account that has not linked an address yet. */
  email: string | null
  /** The Telegram user that signs in to this account from the Mini App; null when none is linked. */
  telegramId: number | null
  /** null only for a deleted account (anonymization). */
  name: string | null
  /** The voice the agent speaks with, by gender. */
  agentVoice: AgentVoice
  /** IANA time zone of the person. */
  timezone: string
  /** false means the account was blocked by an admin, or deleted. */
  isActive: boolean
  isEmailConfirmed: boolean
  isDeleted: boolean
  deletedAt: Date | null
  /** The person asked for product analytics to be off for their account (`users.properties.analytics.optOut`). */
  analyticsOptOut: boolean
  /** Whose traffic the account is (`users.properties.traffic_type`); `real` when nobody marked it. */
  trafficType: TrafficType
  /** The last sign-in, session refresh or conversation; what the retention of anonymous accounts counts from. */
  lastActiveAt: Date
  createdAt: Date
  updatedAt: Date
}

/** `real` people; `test` (load tests, scripted checks); `internal` (the team). Product analytics tags events with it. */
export type TrafficType = 'real' | 'test' | 'internal'

export type UserSearchSortBy = 'createdAt' | 'email' | 'name'
export type SortOrder = 'asc' | 'desc'

/** Key under `users.properties` that holds the personal data archive of a deleted account. */
export const DELETION_ARCHIVE_KEY = 'deletion'

/** Key under `users.properties` that holds the person's analytics choice: `{ optOut: boolean }`. */
export const ANALYTICS_PREFS_KEY = 'analytics'

/** Key under `users.properties` that holds the account's traffic type; absent means `real`. */
export const TRAFFIC_TYPE_KEY = 'traffic_type'

function readTrafficType(properties: UserRow['properties']): TrafficType {
  const value = properties?.[TRAFFIC_TYPE_KEY]
  return value === 'test' || value === 'internal' ? value : 'real'
}

function readAnalyticsOptOut(properties: UserRow['properties']): boolean {
  const prefs = properties?.[ANALYTICS_PREFS_KEY]
  return typeof prefs === 'object' && prefs !== null && (prefs as { optOut?: unknown }).optOut === true
}

export function toUserDTO(row: UserRow): UserDTO {
  return {
    id: row.id,
    email: row.email,
    telegramId: row.telegramId,
    name: row.name,
    agentVoice: row.agentVoice,
    timezone: row.timezone,
    isActive: row.isActive,
    isEmailConfirmed: row.isEmailConfirmed,
    isDeleted: row.isDeleted,
    deletedAt: row.deletedAt,
    analyticsOptOut: readAnalyticsOptOut(row.properties),
    trafficType: readTrafficType(row.properties),
    lastActiveAt: row.lastActiveAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}
