import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../../shared'
import type { CreateWidgetTokenCommandResult } from './create-widget-token.types'

export interface CreateWidgetTokenCommandData {
  userId: string
  token: string
}

export class CreateWidgetTokenCommand extends RequestData<CreateWidgetTokenCommandResult> {
  /** Survives build minification: CreateWidgetTokenCommand.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'CreateWidgetTokenCommand'

  public readonly userId: string
  @hasPII(true)
  public readonly token: string

  constructor(data: CreateWidgetTokenCommandData) {
    super()
    this.userId = data.userId
    this.token = data.token
  }
}
