import { createHash, randomBytes } from 'node:crypto'
import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm'
import {
  moodCheckins,
  notificationDeliveries,
  notificationSettings,
  pushSubscriptions,
  users,
  widgetTokens,
  type PushChannel,
} from '@ryadom/db/schema'
import { getDb } from '../../shared'
import {
  ClaimReminderDeliveryCommand,
  CountUnopenedRemindersQuery,
  CreatePushSubscriptionCommand,
  CreateWidgetTokenCommand,
  DeletePushSubscriptionCommand,
  FindWidgetTokenQuery,
  GetNotificationSettingsQuery,
  HasMoodCheckinQuery,
  ListPushSubscriptionsQuery,
  ListReminderCandidatesQuery,
  MarkReminderDeliveryCommand,
  MarkReminderOpenedCommand,
  PauseMoodReminderCommand,
  RecordPushResultCommand,
  RevokeWidgetTokensCommand,
  UpdateNotificationSettingsCommand,
  type NotificationSettingsDTO,
  type PushSubscriptionDTO,
  type ReminderCandidateDTO,
} from './requests'

export const DEFAULT_REMINDER_TIME = '20:00'
export const MOOD_DELIVERY_KIND = 'mood'

const hhmm = (time: string): string => time.slice(0, 5)

async function readSettings(userId: string): Promise<NotificationSettingsDTO> {
  const [row] = await getDb().select().from(notificationSettings).where(eq(notificationSettings.userId, userId)).limit(1)
  return {
    moodReminderEnabled: row?.moodReminderEnabled ?? true,
    moodReminderTime: hhmm(row?.moodReminderTime ?? DEFAULT_REMINDER_TIME),
    paused: Boolean(row?.pausedAt),
    offerAnswered: Boolean(row?.offerAnsweredAt),
  }
}

function toSubscription(row: typeof pushSubscriptions.$inferSelect): PushSubscriptionDTO {
  return {
    id: row.id,
    userId: row.userId,
    channel: row.channel,
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    deviceLabel: row.deviceLabel,
    createdAt: row.createdAt,
  }
}

@requestHandler(GetNotificationSettingsQuery)
export class GetNotificationSettingsQueryHandler implements RequestHandler<GetNotificationSettingsQuery, { success: true; settings: NotificationSettingsDTO }> {
  async handle(query: GetNotificationSettingsQuery) {
    return { success: true as const, settings: await readSettings(query.data.userId) }
  }
}

/**
 * Only the fields sent change. Switching the reminder on (or any change after a pause) wakes a paused
 * reminder: "Return" is the same call as turning it on again.
 */
@requestHandler(UpdateNotificationSettingsCommand)
export class UpdateNotificationSettingsCommandHandler implements RequestHandler<UpdateNotificationSettingsCommand, { success: true; settings: NotificationSettingsDTO }> {
  async handle(command: UpdateNotificationSettingsCommand) {
    const { userId, enabled, time, offerAnswered } = command.data
    const now = new Date()
    const set: Partial<typeof notificationSettings.$inferInsert> = { updatedAt: now }
    if (enabled !== undefined) set.moodReminderEnabled = enabled
    if (time !== undefined) set.moodReminderTime = time
    if (offerAnswered) set.offerAnsweredAt = now
    if (enabled === true) {
      set.pausedAt = null
      set.streakResetAt = now
    }
    await getDb()
      .insert(notificationSettings)
      .values({ userId, ...set })
      .onConflictDoUpdate({ target: notificationSettings.userId, set })
    return { success: true as const, settings: await readSettings(userId) }
  }
}

@requestHandler(ListPushSubscriptionsQuery)
export class ListPushSubscriptionsQueryHandler implements RequestHandler<ListPushSubscriptionsQuery, { success: true; subscriptions: PushSubscriptionDTO[] }> {
  async handle(query: ListPushSubscriptionsQuery) {
    const rows = await getDb()
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, query.data.userId))
      .orderBy(asc(pushSubscriptions.createdAt))
    return { success: true as const, subscriptions: rows.map(toSubscription) }
  }
}

/** One row per browser endpoint and one per Telegram chat: a repeat call refreshes the row. */
@requestHandler(CreatePushSubscriptionCommand)
export class CreatePushSubscriptionCommandHandler implements RequestHandler<CreatePushSubscriptionCommand, { success: true; subscription: PushSubscriptionDTO }> {
  async handle(command: CreatePushSubscriptionCommand) {
    const { userId, channel, endpoint, p256dh, auth, deviceLabel } = command.data
    const db = getDb()
    const same =
      channel === 'web_push' && endpoint
        ? and(eq(pushSubscriptions.channel, channel), eq(pushSubscriptions.endpoint, endpoint))
        : and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.channel, channel))
    const [existing] = await db.select().from(pushSubscriptions).where(same).limit(1)
    if (existing) {
      const [row] = await db
        .update(pushSubscriptions)
        .set({ userId, p256dh: p256dh ?? null, auth: auth ?? null, deviceLabel: deviceLabel ?? existing.deviceLabel, failures: 0 })
        .where(eq(pushSubscriptions.id, existing.id))
        .returning()
      return { success: true as const, subscription: toSubscription(row!) }
    }
    const [row] = await db
      .insert(pushSubscriptions)
      .values({ userId, channel, endpoint: endpoint ?? null, p256dh: p256dh ?? null, auth: auth ?? null, deviceLabel: deviceLabel ?? null })
      .returning()
    return { success: true as const, subscription: toSubscription(row!) }
  }
}

@requestHandler(DeletePushSubscriptionCommand)
export class DeletePushSubscriptionCommandHandler implements RequestHandler<DeletePushSubscriptionCommand, { success: boolean }> {
  async handle(command: DeletePushSubscriptionCommand) {
    const { id, userId } = command.data
    const rows = await getDb()
      .delete(pushSubscriptions)
      .where(userId ? and(eq(pushSubscriptions.id, id), eq(pushSubscriptions.userId, userId)) : eq(pushSubscriptions.id, id))
      .returning({ id: pushSubscriptions.id })
    return { success: rows.length > 0 }
  }
}

@requestHandler(RecordPushResultCommand)
export class RecordPushResultCommandHandler implements RequestHandler<RecordPushResultCommand, { success: true }> {
  async handle(command: RecordPushResultCommand) {
    const { id, ok } = command.data
    await getDb()
      .update(pushSubscriptions)
      .set(ok ? { lastSuccessAt: new Date(), failures: 0 } : { failures: sql`${pushSubscriptions.failures} + 1` })
      .where(eq(pushSubscriptions.id, id))
    return { success: true as const }
  }
}

@requestHandler(ListReminderCandidatesQuery)
export class ListReminderCandidatesQueryHandler implements RequestHandler<ListReminderCandidatesQuery, { success: true; candidates: ReminderCandidateDTO[] }> {
  async handle(query: ListReminderCandidatesQuery) {
    const { limit, afterUserId } = query.data
    const rows = await getDb()
      .selectDistinct({
        userId: users.id,
        timezone: users.timezone,
        telegramId: users.telegramId,
        enabled: notificationSettings.moodReminderEnabled,
        time: notificationSettings.moodReminderTime,
        pausedAt: notificationSettings.pausedAt,
        streakResetAt: notificationSettings.streakResetAt,
      })
      .from(users)
      .innerJoin(
        pushSubscriptions,
        and(eq(pushSubscriptions.userId, users.id), inArray(pushSubscriptions.channel, ['web_push', 'telegram'] as PushChannel[])),
      )
      .leftJoin(notificationSettings, eq(notificationSettings.userId, users.id))
      .where(
        and(
          eq(users.isActive, true),
          eq(users.isDeleted, false),
          or(isNull(notificationSettings.moodReminderEnabled), eq(notificationSettings.moodReminderEnabled, true)),
          isNull(notificationSettings.pausedAt),
          afterUserId ? gt(users.id, afterUserId) : undefined,
        ),
      )
      .orderBy(asc(users.id))
      .limit(limit)
    return {
      success: true as const,
      candidates: rows.map((r) => ({
        userId: r.userId,
        timezone: r.timezone,
        telegramId: r.telegramId,
        time: hhmm(r.time ?? DEFAULT_REMINDER_TIME),
        streakResetAt: r.streakResetAt,
      })),
    }
  }
}

/** The unique key (person, kind, local day) lets exactly one inserter win, whatever the number of replicas. */
@requestHandler(ClaimReminderDeliveryCommand)
export class ClaimReminderDeliveryCommandHandler implements RequestHandler<ClaimReminderDeliveryCommand, { success: true; claimed: boolean; deliveryId: number | null }> {
  async handle(command: ClaimReminderDeliveryCommand) {
    const { userId, localDate, channel } = command.data
    const [row] = await getDb()
      .insert(notificationDeliveries)
      .values({ userId, kind: MOOD_DELIVERY_KIND, localDate, channel })
      .onConflictDoNothing()
      .returning({ id: notificationDeliveries.id })
    return { success: true as const, claimed: Boolean(row), deliveryId: row?.id ?? null }
  }
}

@requestHandler(MarkReminderDeliveryCommand)
export class MarkReminderDeliveryCommandHandler implements RequestHandler<MarkReminderDeliveryCommand, { success: true }> {
  async handle(command: MarkReminderDeliveryCommand) {
    const { deliveryId, error, channel } = command.data
    await getDb()
      .update(notificationDeliveries)
      .set({ error: error ?? null, ...(channel ? { channel } : {}) })
      .where(eq(notificationDeliveries.id, deliveryId))
    return { success: true as const }
  }
}

@requestHandler(MarkReminderOpenedCommand)
export class MarkReminderOpenedCommandHandler implements RequestHandler<MarkReminderOpenedCommand, { success: boolean }> {
  async handle(command: MarkReminderOpenedCommand) {
    const { userId, deliveryId } = command.data
    const db = getDb()
    const rows = await db
      .update(notificationDeliveries)
      .set({ openedAt: new Date() })
      .where(and(eq(notificationDeliveries.id, deliveryId), eq(notificationDeliveries.userId, userId), isNull(notificationDeliveries.openedAt)))
      .returning({ id: notificationDeliveries.id })
    if (rows.length > 0) {
      await db
        .update(notificationSettings)
        .set({ pausedAt: null, streakResetAt: new Date() })
        .where(eq(notificationSettings.userId, userId))
    }
    return { success: rows.length > 0 }
  }
}

@requestHandler(CountUnopenedRemindersQuery)
export class CountUnopenedRemindersQueryHandler implements RequestHandler<CountUnopenedRemindersQuery, { success: true; unopenedInRow: number }> {
  async handle(query: CountUnopenedRemindersQuery) {
    const { userId, since, limit } = query.data
    const rows = await getDb()
      .select({ openedAt: notificationDeliveries.openedAt })
      .from(notificationDeliveries)
      .where(
        and(
          eq(notificationDeliveries.userId, userId),
          eq(notificationDeliveries.kind, MOOD_DELIVERY_KIND),
          since ? gt(notificationDeliveries.sentAt, since) : undefined,
        ),
      )
      .orderBy(desc(notificationDeliveries.sentAt))
      .limit(limit)
    let unopened = 0
    for (const row of rows) {
      if (row.openedAt) break
      unopened += 1
    }
    return { success: true as const, unopenedInRow: unopened }
  }
}

@requestHandler(PauseMoodReminderCommand)
export class PauseMoodReminderCommandHandler implements RequestHandler<PauseMoodReminderCommand, { success: true }> {
  async handle(command: PauseMoodReminderCommand) {
    const now = new Date()
    await getDb()
      .insert(notificationSettings)
      .values({ userId: command.data.userId, pausedAt: now })
      .onConflictDoUpdate({ target: notificationSettings.userId, set: { pausedAt: now, updatedAt: now } })
    return { success: true as const }
  }
}

@requestHandler(HasMoodCheckinQuery)
export class HasMoodCheckinQueryHandler implements RequestHandler<HasMoodCheckinQuery, { success: true; has: boolean }> {
  async handle(query: HasMoodCheckinQuery) {
    const [row] = await getDb()
      .select({ id: moodCheckins.id })
      .from(moodCheckins)
      .where(and(eq(moodCheckins.userId, query.data.userId), eq(moodCheckins.localDate, query.data.localDate)))
      .limit(1)
    return { success: true as const, has: Boolean(row) }
  }
}

const hashToken = (token: string): Buffer => createHash('sha256').update(token).digest()

/** The token is shown once; the table keeps its hash. A person has one widget: a new token revokes the old one. */
@requestHandler(CreateWidgetTokenCommand)
export class CreateWidgetTokenCommandHandler implements RequestHandler<CreateWidgetTokenCommand, { success: true; token: string }> {
  async handle(command: CreateWidgetTokenCommand) {
    const { userId } = command.data
    const db = getDb()
    await db.update(widgetTokens).set({ revokedAt: new Date() }).where(and(eq(widgetTokens.userId, userId), isNull(widgetTokens.revokedAt)))
    const token = `wdg_${randomBytes(32).toString('base64url')}`
    await db.insert(widgetTokens).values({ userId, tokenHash: hashToken(token) })
    return { success: true as const, token }
  }
}

@requestHandler(RevokeWidgetTokensCommand)
export class RevokeWidgetTokensCommandHandler implements RequestHandler<RevokeWidgetTokensCommand, { success: true }> {
  async handle(command: RevokeWidgetTokensCommand) {
    await getDb()
      .update(widgetTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(widgetTokens.userId, command.data.userId), isNull(widgetTokens.revokedAt)))
    return { success: true as const }
  }
}

@requestHandler(FindWidgetTokenQuery)
export class FindWidgetTokenQueryHandler implements RequestHandler<FindWidgetTokenQuery, { success: true; userId: string | null }> {
  async handle(query: FindWidgetTokenQuery) {
    const [row] = await getDb()
      .select({ userId: widgetTokens.userId, isActive: users.isActive, isDeleted: users.isDeleted })
      .from(widgetTokens)
      .innerJoin(users, eq(users.id, widgetTokens.userId))
      .where(and(eq(widgetTokens.tokenHash, hashToken(query.data.token)), isNull(widgetTokens.revokedAt)))
      .limit(1)
    return { success: true as const, userId: row && row.isActive && !row.isDeleted ? row.userId : null }
  }
}
