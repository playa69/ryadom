import type { DiarySummaryKind } from '@ryadom/db/schema'

export interface RecomputeMarkerDTO {
  userId: string
  kind: DiarySummaryKind
  periodStart: string
}

/** Week markers first, then year markers; people with markers only for active accounts, ordered by person. */
export type ListRecomputeMarkersQueryResult = { success: true; markers: RecomputeMarkerDTO[] }
