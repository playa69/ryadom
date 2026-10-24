import { RequestData } from 'mediatr-ts'
import type { RevokeWidgetTokensCommandResult } from './revoke-widget-tokens.types'

export interface RevokeWidgetTokensCommandData {
  userId: string
}

export class RevokeWidgetTokensCommand extends RequestData<RevokeWidgetTokensCommandResult> {
  /** Survives build minification: RevokeWidgetTokensCommand.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'RevokeWidgetTokensCommand'

  public readonly userId: string

  constructor(data: RevokeWidgetTokensCommandData) {
    super()
    this.userId = data.userId
  }
}
