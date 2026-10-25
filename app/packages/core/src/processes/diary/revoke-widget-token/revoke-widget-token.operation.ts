import { RequestData } from 'mediatr-ts'
import type { RevokeWidgetTokenResult } from './revoke-widget-token.types'

export interface RevokeWidgetTokenOperationData {
  userId: string
}

export class RevokeWidgetTokenOperation extends RequestData<RevokeWidgetTokenResult> {
  /** Survives build minification: RevokeWidgetTokenOperation.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'RevokeWidgetTokenOperation'

  public readonly userId: string

  constructor(data: RevokeWidgetTokenOperationData) {
    super()
    this.userId = data.userId
  }
}
