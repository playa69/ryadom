import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../shared'
import type { ResolveWidgetTokenResult } from './resolve-widget-token.types'

export interface ResolveWidgetTokenOperationData {
  token: string
}

export class ResolveWidgetTokenOperation extends RequestData<ResolveWidgetTokenResult> {
  /** Survives build minification: ResolveWidgetTokenOperation.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'ResolveWidgetTokenOperation'

  @hasPII(true)
  public readonly token: string

  constructor(data: ResolveWidgetTokenOperationData) {
    super()
    this.token = data.token
  }
}
