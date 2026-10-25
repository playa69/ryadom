import type { DiarySummaryKind } from '@ryadom/db/schema'

export interface RecomputeMarkerDTO {
  userId: string
  kind: DiarySummaryKind
  periodStart: string
}

/** Markers of weeks to write again; only for active accounts, ordered by person. */
export type ListRecomputeMarkersQueryResult = { success: true; markers: RecomputeMarkerDTO[] }
