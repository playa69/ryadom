import type { PushChannel, PushSubscriptionRow } from '@ryadom/db/schema'

/** A device subscribed to notifications. `token` is its address at the push service: a secret, never logged. */
export interface PushSubscriptionDTO {
  id: string
  userId: string
  sessionId: string
  channel: PushChannel
  token: string
  projectId: string
  appId: string
  createdAt: Date
  updatedAt: Date
}

export function toPushSubscriptionDTO(row: PushSubscriptionRow): PushSubscriptionDTO {
  return {
    id: row.id,
    userId: row.userId,
    sessionId: row.sessionId,
    channel: row.channel,
    token: row.token,
    projectId: row.projectId,
    appId: row.appId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}
