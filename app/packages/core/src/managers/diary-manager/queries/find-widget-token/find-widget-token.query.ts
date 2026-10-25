import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../../shared'
import type { FindWidgetTokenQueryResult } from './find-widget-token.types'

export interface FindWidgetTokenQueryData {
  token: string
}

export class FindWidgetTokenQuery extends RequestData<FindWidgetTokenQueryResult> {
  /** Survives build minification: FindWidgetTokenQuery.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'FindWidgetTokenQuery'

  @hasPII(true)
  public readonly token: string

  constructor(data: FindWidgetTokenQueryData) {
    super()
    this.token = data.token
  }
}
