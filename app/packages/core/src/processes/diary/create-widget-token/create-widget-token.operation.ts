import { RequestData } from 'mediatr-ts'
import type { CreateWidgetTokenResult } from './create-widget-token.types'

export interface CreateWidgetTokenOperationData {
  userId: string
}

export class CreateWidgetTokenOperation extends RequestData<CreateWidgetTokenResult> {
  /** Survives build minification: CreateWidgetTokenOperation.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'CreateWidgetTokenOperation'

  public readonly userId: string

  constructor(data: CreateWidgetTokenOperationData) {
    super()
    this.userId = data.userId
  }
}
