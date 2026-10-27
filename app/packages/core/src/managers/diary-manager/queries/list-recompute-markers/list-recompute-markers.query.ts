import { RequestData } from 'mediatr-ts'
import type { ListRecomputeMarkersQueryResult } from './list-recompute-markers.types'

export interface ListRecomputeMarkersQueryData {
  /** Week markers of weeks starting before this day are not rebuilt (a deletion older than that is not worth a model call). */
  weeksSince: string
  limit: number
}

export class ListRecomputeMarkersQuery extends RequestData<ListRecomputeMarkersQueryResult> {
  /** Survives build minification: ListRecomputeMarkersQuery.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'ListRecomputeMarkersQuery'

  public readonly weeksSince: string
  public readonly limit: number

  constructor(data: ListRecomputeMarkersQueryData) {
    super()
    this.weeksSince = data.weeksSince
    this.limit = data.limit
  }
}
