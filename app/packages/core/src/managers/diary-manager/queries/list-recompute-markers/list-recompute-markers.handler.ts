import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { and, asc, eq, gte, or, sql } from 'drizzle-orm'
import { diarySummaries, users } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { ListRecomputeMarkersQuery } from './list-recompute-markers.query'
import { type ListRecomputeMarkersQueryResult } from './list-recompute-markers.types'

@requestHandler(ListRecomputeMarkersQuery)
export class ListRecomputeMarkersQueryHandler implements RequestHandler<ListRecomputeMarkersQuery, ListRecomputeMarkersQueryResult> {
  async handle(c: ListRecomputeMarkersQuery): Promise<ListRecomputeMarkersQueryResult> {
    // Markers are `pending` rows without text that carry `stats.recompute`. A marker some replica is working on has a
    // fresh `generated_at`; the claim itself decides who takes it, so this only lists candidates.
    const rows = await getDb()
      .select({ userId: diarySummaries.userId, kind: diarySummaries.kind, periodStart: diarySummaries.periodStart })
      .from(diarySummaries)
      .innerJoin(users, eq(users.id, diarySummaries.userId))
      .where(
        and(
          eq(diarySummaries.status, 'pending'),
          eq(diarySummaries.text, ''),
          sql`coalesce((${diarySummaries.stats}->>'recompute')::boolean, false) = true`,
          eq(users.isActive, true),
          eq(users.isDeleted, false),
          or(eq(diarySummaries.kind, 'year'), gte(diarySummaries.periodStart, c.weeksSince)),
        ),
      )
      .orderBy(asc(diarySummaries.userId), asc(diarySummaries.kind), asc(diarySummaries.periodStart))
      .limit(c.limit)
    return { success: true, markers: rows }
  }
}
