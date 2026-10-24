import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { and, asc, desc, eq, gte, lt, lte } from 'drizzle-orm'
import {
  diarySummaries,
  moodCheckins,
  notificationDeliveries,
  notificationSettings,
  pushSubscriptions,
  widgetTokens,
  type DiarySummaryRow,
  type MoodCheckinRow,
} from '@ryadom/db/schema'
import { getDb } from '../../shared'
import {
  DeleteUserDiaryCommand,
  ListDiarySummariesQuery,
  ListMoodCheckinsQuery,
  UpsertDiarySummaryCommand,
  UpsertMoodCheckinCommand,
  type DiarySummaryDTO,
  type MoodCheckinDTO,
} from './requests'

export function toCheckinDTO(row: MoodCheckinRow): MoodCheckinDTO {
  return { date: row.localDate, mood: row.mood, factor: row.factor, source: row.source, updatedAt: row.updatedAt }
}

export function toSummaryDTO(row: DiarySummaryRow): DiarySummaryDTO {
  return { kind: row.kind, periodStart: row.periodStart, text: row.text, stats: row.stats, generatedAt: row.generatedAt }
}

/** One note per local day: a second one replaces the first, the factor stays unless the request names one. */
@requestHandler(UpsertMoodCheckinCommand)
export class UpsertMoodCheckinCommandHandler implements RequestHandler<UpsertMoodCheckinCommand, { success: true; checkin: MoodCheckinDTO; changed: boolean }> {
  async handle(command: UpsertMoodCheckinCommand) {
    const { userId, localDate, mood, factor, source } = command.data
    const db = getDb()
    const [existing] = await db
      .select({ id: moodCheckins.id })
      .from(moodCheckins)
      .where(and(eq(moodCheckins.userId, userId), eq(moodCheckins.localDate, localDate)))
      .limit(1)
    const now = new Date()
    const [row] = await db
      .insert(moodCheckins)
      .values({ userId, localDate, mood, factor: factor ?? null, source })
      .onConflictDoUpdate({
        target: [moodCheckins.userId, moodCheckins.localDate],
        set: {
          mood,
          source,
          updatedAt: now,
          ...(factor === undefined ? {} : { factor }),
        },
      })
      .returning()
    return { success: true as const, checkin: toCheckinDTO(row!), changed: Boolean(existing) }
  }
}

@requestHandler(ListMoodCheckinsQuery)
export class ListMoodCheckinsQueryHandler implements RequestHandler<ListMoodCheckinsQuery, { success: true; checkins: MoodCheckinDTO[] }> {
  async handle(query: ListMoodCheckinsQuery) {
    const { userId, from, to } = query.data
    const rows = await getDb()
      .select()
      .from(moodCheckins)
      .where(and(eq(moodCheckins.userId, userId), gte(moodCheckins.localDate, from), lte(moodCheckins.localDate, to)))
      .orderBy(asc(moodCheckins.localDate))
    return { success: true as const, checkins: rows.map(toCheckinDTO) }
  }
}

/** A new text for the same period replaces the old one. */
@requestHandler(UpsertDiarySummaryCommand)
export class UpsertDiarySummaryCommandHandler implements RequestHandler<UpsertDiarySummaryCommand, { success: true; summary: DiarySummaryDTO }> {
  async handle(command: UpsertDiarySummaryCommand) {
    const { userId, kind, periodStart, text, stats, generatedAt } = command.data
    const [row] = await getDb()
      .insert(diarySummaries)
      .values({ userId, kind, periodStart, text, stats, generatedAt })
      .onConflictDoUpdate({
        target: [diarySummaries.userId, diarySummaries.kind, diarySummaries.periodStart],
        set: { text, stats, generatedAt },
      })
      .returning()
    return { success: true as const, summary: toSummaryDTO(row!) }
  }
}

@requestHandler(ListDiarySummariesQuery)
export class ListDiarySummariesQueryHandler implements RequestHandler<ListDiarySummariesQuery, { success: true; summaries: DiarySummaryDTO[] }> {
  async handle(query: ListDiarySummariesQuery) {
    const { userId, kind, before, from, to, limit } = query.data
    const conditions = [eq(diarySummaries.userId, userId), eq(diarySummaries.kind, kind)]
    if (before) conditions.push(lt(diarySummaries.periodStart, before))
    if (from) conditions.push(gte(diarySummaries.periodStart, from))
    if (to) conditions.push(lte(diarySummaries.periodStart, to))
    const rows = await getDb()
      .select()
      .from(diarySummaries)
      .where(and(...conditions))
      .orderBy(desc(diarySummaries.periodStart))
      .limit(limit ?? 100)
    return { success: true as const, summaries: rows.map(toSummaryDTO) }
  }
}

@requestHandler(DeleteUserDiaryCommand)
export class DeleteUserDiaryCommandHandler implements RequestHandler<DeleteUserDiaryCommand, { success: true }> {
  async handle(command: DeleteUserDiaryCommand) {
    const { userId } = command.data
    const db = getDb()
    await db.delete(moodCheckins).where(eq(moodCheckins.userId, userId))
    await db.delete(diarySummaries).where(eq(diarySummaries.userId, userId))
    await db.delete(notificationSettings).where(eq(notificationSettings.userId, userId))
    await db.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, userId))
    await db.delete(notificationDeliveries).where(eq(notificationDeliveries.userId, userId))
    await db.delete(widgetTokens).where(eq(widgetTokens.userId, userId))
    return { success: true as const }
  }
}

